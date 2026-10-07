import { pool } from "@workspace/db";

export async function ensureExamSummaryTable(): Promise<void> {
  await pool.query("CREATE TABLE IF NOT EXISTS k9_exam_summaries (id SERIAL PRIMARY KEY, student_code TEXT NOT NULL, subject TEXT NOT NULL, source_exam_id INTEGER, page_count INTEGER NOT NULL DEFAULT 6 CHECK (page_count BETWEEN 1 AND 6), split_layout BOOLEAN NOT NULL DEFAULT TRUE, content JSONB NOT NULL, generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(student_code, subject, source_exam_id))");
}

export async function generateExamSummary(studentCode: string, subject: string, examId: number): Promise<void> {
  await ensureExamSummaryTable();
  const rows = await pool.query(
    "SELECT i.question_number, i.question_topic, i.student_answer, i.expected_answer, i.is_correct, i.marks_awarded, i.marks_possible FROM graded_paper_items i JOIN graded_papers p ON p.id=i.paper_id WHERE p.student_code=$1 AND p.subject=$2 AND p.metadata->>'exam_id'=$3 ORDER BY i.question_number NULLS LAST",
    [studentCode, subject, String(examId)],
  );
  const weak = await pool.query(
    "SELECT COALESCE(i.question_topic,'General') AS topic, COUNT(*)::int AS wrong_count, COUNT(*) FILTER (WHERE i.is_correct)::int AS correct_count FROM graded_paper_items i JOIN graded_papers p ON p.id=i.paper_id WHERE p.student_code=$1 AND p.subject=$2 AND i.is_correct=FALSE GROUP BY i.question_topic ORDER BY wrong_count DESC LIMIT 5",
    [studentCode, subject],
  );
  const practice = await pool.query(
    "SELECT topic, question_text, expected_answer FROM generated_questions WHERE topic = ANY($1::text[]) ORDER BY used_count ASC LIMIT 12",
    [weak.rows.map((r: any) => String(r.topic))],
  );
  const pages = [
    { page: 1, left: "Your exam performance", right: "Strengths and priority learning gaps." },
    { page: 2, left: "Understand: " + (weak.rows[0]?.topic ?? "core review"), right: "Explanation + worked example." },
    { page: 3, left: "Understand: " + (weak.rows[1]?.topic ?? "core review"), right: "Explanation + worked example." },
    { page: 4, left: "Your mistakes explained", right: "K9 explains the student's actual errors and expected reasoning." },
    { page: 5, left: "Practice questions", right: "Questions targeted at the student's weakest concepts." },
    { page: 6, left: "Mastery challenge", right: "Mixed questions to confirm recovery." },
  ];
  const mistakes = rows.rows.filter((r: any) => r.is_correct === false).slice(0, 12).map((r: any) => ({
    question_number: r.question_number, topic: r.question_topic, answer: r.student_answer,
    expected: r.expected_answer, marks: r.marks_awarded, possible: r.marks_possible,
  }));
  await pool.query(
    "INSERT INTO k9_exam_summaries (student_code,subject,source_exam_id,page_count,split_layout,content) VALUES ($1,$2,$3,6,TRUE,$4::jsonb) ON CONFLICT (student_code,subject,source_exam_id) DO UPDATE SET content=EXCLUDED.content,page_count=6,split_layout=TRUE,generated_at=NOW()",
    [studentCode, subject, examId, JSON.stringify({
      format: "A4-portrait-three-sheets", pages, weak_topics: weak.rows, mistakes, practice_questions: practice.rows,
      max_pages: 6, physical_sheets: 3, split_middle: true, generated_from: "camera_marked_exam",
    })],
  );
}

export async function getClassExamGaps(examId: number) {
  const rows = await pool.query(
    "SELECT COALESCE(i.question_topic,'General') AS topic, COUNT(DISTINCT p.student_code)::int AS students, (SELECT COUNT(DISTINCT p2.student_code)::int FROM graded_papers p2 WHERE p2.metadata->>'exam_id'=$1) AS total FROM graded_paper_items i JOIN graded_papers p ON p.id=i.paper_id WHERE p.metadata->>'exam_id'=$1 AND i.is_correct=FALSE GROUP BY i.question_topic ORDER BY students DESC",
    [String(examId)],
  );
  return rows.rows.map((r: any) => ({
    topic: r.topic, students: Number(r.students), total: Number(r.total),
    rate: Number(r.total) ? Math.round(Number(r.students) / Number(r.total) * 100) : 0,
  }));
}
