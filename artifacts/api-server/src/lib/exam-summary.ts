import { pool } from "@workspace/db";

export async function ensureExamSummaryTable(): Promise<void> {
  await pool.query("CREATE TABLE IF NOT EXISTS k9_exam_summaries (id SERIAL PRIMARY KEY, student_code TEXT NOT NULL, subject TEXT NOT NULL, source_exam_id INTEGER, page_count INTEGER NOT NULL DEFAULT 6 CHECK (page_count BETWEEN 1 AND 6), split_layout BOOLEAN NOT NULL DEFAULT TRUE, content JSONB NOT NULL, generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(student_code, subject, source_exam_id))");
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
