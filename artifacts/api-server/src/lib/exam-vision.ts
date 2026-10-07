import { pool } from "@workspace/db";
import { ensureResultsTables, findClassStudent, getExam, recordExamResult, type ExamRow } from "./results";
import { generateCuratedNotesForPaper, generateRetestForPaper } from "./student-development";
import { logger } from "./logger";

export type VisionMarkItem = {
  question_number?: number | string | null;
  question_text?: string | null;
  question_topic?: string | null;
  student_answer?: string | null;
  expected_answer?: string | null;
  is_correct?: boolean | null;
  marks_awarded?: number | string | null;
  marks_possible?: number | string | null;
  marking_confidence?: number | null;
};

function clean(v: unknown, max = 1000): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s.length <= max ? s : null;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function hasMark(item: VisionMarkItem): boolean {
  const awarded = num(item.marks_awarded);
  return awarded !== null || typeof item.is_correct === "boolean";
}

/**
 * Camera-first exam marking. The teacher never reads questions or answers.
 * Vision supplies the paper structure and the teacher's visible marks.
 *
 * Identity is intentionally gated: if K9 cannot confidently attach the paper
 * to a permanent student record, the result is held for teacher confirmation.
 */
export async function recordCameraMarkedPaper(args: {
  response: Record<string, unknown>;
  context: Record<string, unknown>;
  teacherUserId: number | null;
}): Promise<{ status: "recorded" | "needs_confirmation" | "ignored"; paperId?: number; studentCode?: string; reason?: string }> {
  const response = args.response;
  const context = args.context;
  const studentCode = clean(response.student_code ?? response.studentCode ?? context.student_code, 100);
  const studentConfidence = num(response.student_confidence ?? response.studentConfidence) ?? 0;
  const attachmentConfidence = num(response.profile_attachment_confidence ?? response.permanent_profile_confidence) ?? studentConfidence;
  const items = Array.isArray(response.items) ? response.items as VisionMarkItem[] : [];

  if (!studentCode || attachmentConfidence < 0.90) {
    return { status: "needs_confirmation", studentCode: studentCode ?? undefined, reason: "K9 is not confident enough to permanently attach this paper to a student profile." };
  }
  const examId = num(context.exam_id);
  if (!examId || items.length === 0) return { status: "ignored", reason: "No exam or marked question items detected." };

  const exam = await getExam(examId);
  if (!exam || exam.status !== "open") return { status: "ignored", reason: "Exam is not open." };
  const student = await findClassStudent(exam.class_id, studentCode);
  if (!student) return { status: "needs_confirmation", studentCode, reason: "Student is not in the selected exam class." };

  const marked = items.filter(hasMark);
  if (marked.length === 0) return { status: "ignored", reason: "No teacher mark detected." };

  const marksAwarded = marked.reduce((s, i) => s + (num(i.marks_awarded) ?? (i.is_correct ? (num(i.marks_possible) ?? 0) : 0)), 0);
  const marksPossible = marked.reduce((s, i) => s + (num(i.marks_possible) ?? 0), 0);
  const correct = marked.filter(i => i.is_correct === true).length;
  const incorrect = marked.filter(i => i.is_correct === false).length;
  const score = marksPossible > 0 ? Math.round((marksAwarded / marksPossible) * 100) : Math.round((correct / marked.length) * 100);
  const sessionId = num(context.lens_session_id);
  const imageKey = clean(context.image_key, 300);

  const client = await pool.connect();
  let paperId = 0;
  try {
    await client.query("BEGIN");
    const paper = await client.query(
      `INSERT INTO graded_papers
       (session_id, teacher_user_id, student_code, class_id, subject, assessment_title,
        total_questions, correct_count, incorrect_count, score_percent, paper_image_key, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING id`,
      [sessionId, args.teacherUserId, studentCode, exam.class_id, exam.subject, exam.title,
       marked.length, correct, incorrect, score, imageKey,
       JSON.stringify({ source: "glasses_camera", student_confidence: studentConfidence,
         profile_attachment_confidence: attachmentConfidence, exam_id: exam.id })],
    );
    paperId = Number(paper.rows[0].id);

    for (const item of marked) {
      const awarded = num(item.marks_awarded);
      const possible = num(item.marks_possible);
      const isCorrect = typeof item.is_correct === "boolean" ? item.is_correct : (awarded !== null && possible !== null ? awarded >= possible : false);
      await client.query(
        `INSERT INTO graded_paper_items
         (paper_id, question_number, question_text, question_topic, student_answer,
          expected_answer, is_correct, marks_awarded, marks_possible, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [paperId, num(item.question_number), clean(item.question_text,800), clean(item.question_topic,200),
         clean(item.student_answer,1500), clean(item.expected_answer,1500), isCorrect, awarded, possible,
         JSON.stringify({ source: "glasses_camera", marking_confidence: item.marking_confidence ?? null })],
      );
    }

    await ensureResultsTables();
    const marks = marksPossible > 0 ? Math.min(exam.total_marks, (marksAwarded / marksPossible) * exam.total_marks) : (score / 100) * exam.total_marks;
    await recordExamResult(client, {
      examId: exam.id, studentId: student.id, marks: Math.round(marks * 10) / 10,
      source: "lens", gradedPaperId: paperId, recordedBy: args.teacherUserId,
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }

  try { await generateCuratedNotesForPaper(paperId); } catch (e) { logger.warn({ err: e, paperId }, "camera curated notes failed"); }
  try { await generateRetestForPaper(paperId); } catch (e) { logger.warn({ err: e, paperId }, "camera retest generation failed"); }

  return { status: "recorded", paperId, studentCode };
}
