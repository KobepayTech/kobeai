import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { enqueueVisionAnalysisSafe } from "../lib/vision-queue";
import { getMergedProfile } from "../lib/learning-profile";
import {
  generateCuratedNotesForPaper,
  generateRetestForPaper,
} from "../lib/student-development";
import { logger } from "../lib/logger";

const router = Router();

// Teacher-lens is a staff surface — the teacher wearing the phone/glasses
// authenticates as themselves, not as a shared kiosk. That way every
// graded_papers row is attributed to a real teacher for audit.
const requireTeacher = requireAuth(["teacher", "admin", "super_admin"]);

let tablesReady: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS teacher_lens_sessions (
          id SERIAL PRIMARY KEY,
          teacher_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          mode TEXT NOT NULL DEFAULT 'marking',
          device TEXT,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ended_at TIMESTAMPTZ,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS teacher_lens_sessions_teacher_idx
          ON teacher_lens_sessions (teacher_user_id, started_at)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS graded_papers (
          id SERIAL PRIMARY KEY,
          session_id INTEGER REFERENCES teacher_lens_sessions(id) ON DELETE SET NULL,
          teacher_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          student_code TEXT NOT NULL,
          class_id INTEGER,
          subject TEXT,
          assessment_title TEXT,
          total_questions INTEGER NOT NULL DEFAULT 0,
          correct_count INTEGER NOT NULL DEFAULT 0,
          incorrect_count INTEGER NOT NULL DEFAULT 0,
          score_percent INTEGER,
          graded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          paper_image_key TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS graded_papers_student_time_idx
          ON graded_papers (student_code, graded_at)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS graded_paper_items (
          id SERIAL PRIMARY KEY,
          paper_id INTEGER NOT NULL REFERENCES graded_papers(id) ON DELETE CASCADE,
          question_number INTEGER,
          question_text TEXT,
          question_topic TEXT,
          student_answer TEXT,
          expected_answer TEXT,
          is_correct BOOLEAN NOT NULL,
          marks_awarded INTEGER,
          marks_possible INTEGER,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS graded_paper_items_paper_idx
          ON graded_paper_items (paper_id)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS graded_paper_items_topic_correct_idx
          ON graded_paper_items (question_topic, is_correct)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS teacher_lens_whispers (
          id SERIAL PRIMARY KEY,
          session_id INTEGER REFERENCES teacher_lens_sessions(id) ON DELETE CASCADE,
          teacher_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          text TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 5,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          played_at TIMESTAMPTZ
        )
      `);
    })().catch((err) => {
      tablesReady = null;
      throw err;
    });
  }
  return tablesReady;
}

function text(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

async function enqueueWhisper(args: {
  sessionId: number | null;
  teacherUserId: number | null;
  text: string;
  priority?: number;
}): Promise<void> {
  const priority = Math.max(1, Math.min(10, args.priority ?? 5));
  await pool.query(
    `INSERT INTO teacher_lens_whispers (session_id, teacher_user_id, text, priority)
     VALUES ($1, $2, $3, $4)`,
    [args.sessionId, args.teacherUserId, args.text, priority],
  );
}

/**
 * POST /v1/teacher-lens/session
 * Start a new lens session. Body: { mode: "marking" | "lookup" | "ambient", device?: string }
 */
router.post("/v1/teacher-lens/session", requireTeacher, async (req, res) => {
  await ensureTables();
  const mode = text(req.body?.mode, 40) ?? "marking";
  if (!["marking", "lookup", "ambient"].includes(mode)) {
    res.status(400).json({ error: "invalid mode" });
    return;
  }
  const device = text(req.body?.device, 100);
  const rows = await pool.query(
    `INSERT INTO teacher_lens_sessions (teacher_user_id, mode, device)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [req.auth?.user_id ?? null, mode, device],
  );
  res.status(201).json({ session: rows.rows[0] });
});

router.post("/v1/teacher-lens/session/:id/end", requireTeacher, async (req, res) => {
  await ensureTables();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "invalid session id" });
    return;
  }
  const rows = await pool.query(
    `UPDATE teacher_lens_sessions
     SET ended_at = NOW()
     WHERE id = $1 AND teacher_user_id = $2 AND ended_at IS NULL
     RETURNING *`,
    [id, req.auth?.user_id ?? null],
  );
  if (!rows.rows[0]) {
    res.status(404).json({ error: "session_not_found_or_already_ended" });
    return;
  }
  res.json({ session: rows.rows[0] });
});

/**
 * POST /v1/teacher-lens/paper-graded
 * Ingest one graded paper. Body:
 *   {
 *     session_id?: number,
 *     student_code: string,
 *     subject?: string,
 *     assessment_title?: string,
 *     items: [
 *       {
 *         question_number?: number,
 *         question_text?: string,
 *         question_topic?: string,
 *         student_answer?: string,
 *         expected_answer?: string,
 *         is_correct: boolean,
 *         marks_awarded?: number,
 *         marks_possible?: number
 *       }, ...
 *     ],
 *     paper_image_key?: string,
 *     metadata?: object
 *   }
 *
 * Client can call this from the phone with structured input (either the
 * teacher marked in-app OR a vision worker OCR'd the paper). In both
 * cases the DB shape is identical.
 */
router.post("/v1/teacher-lens/paper-graded", requireTeacher, async (req, res) => {
  await ensureTables();
  const body = req.body ?? {};
  const studentCode = text(body.student_code, 100);
  if (!studentCode) {
    res.status(400).json({ error: "student_code required" });
    return;
  }
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) {
    res.status(400).json({ error: "items array required (may be empty only in a stub call)" });
    return;
  }
  if (items.length > 200) {
    res.status(413).json({ error: "too many items (max 200)" });
    return;
  }

  const sessionId = Number.isFinite(Number(body.session_id)) ? Number(body.session_id) : null;
  const subject = text(body.subject, 200);
  const assessment = text(body.assessment_title, 300);
  const paperImage = text(body.paper_image_key, 300);

  let correct = 0;
  let incorrect = 0;
  for (const it of items) {
    if (typeof it?.is_correct !== "boolean") {
      res.status(400).json({ error: "each item needs is_correct boolean" });
      return;
    }
    if (it.is_correct) correct += 1;
    else incorrect += 1;
  }
  const total = items.length;
  const score = total > 0 ? Math.round((correct / total) * 100) : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const paper = await client.query(
      `INSERT INTO graded_papers (
         session_id, teacher_user_id, student_code, subject,
         assessment_title, total_questions, correct_count, incorrect_count,
         score_percent, paper_image_key, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       RETURNING *`,
      [
        sessionId,
        req.auth?.user_id ?? null,
        studentCode,
        subject,
        assessment,
        total,
        correct,
        incorrect,
        score,
        paperImage,
        JSON.stringify(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
      ],
    );
    const paperId = Number(paper.rows[0].id);
    for (const it of items) {
      await client.query(
        `INSERT INTO graded_paper_items (
           paper_id, question_number, question_text, question_topic,
           student_answer, expected_answer, is_correct,
           marks_awarded, marks_possible, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [
          paperId,
          Number.isFinite(Number(it.question_number)) ? Number(it.question_number) : null,
          text(it.question_text, 800),
          text(it.question_topic, 200),
          text(it.student_answer, 800),
          text(it.expected_answer, 800),
          !!it.is_correct,
          Number.isFinite(Number(it.marks_awarded)) ? Number(it.marks_awarded) : null,
          Number.isFinite(Number(it.marks_possible)) ? Number(it.marks_possible) : null,
          JSON.stringify(it.metadata && typeof it.metadata === "object" ? it.metadata : {}),
        ],
      );
    }
    await client.query("COMMIT");

    // Fire a whisper back so the teacher hears "captured N of N for
    // <student> — one weak spot on X" through the earbud. Best effort.
    const shortSummary =
      total > 0
        ? `${studentCode}: ${correct} out of ${total} — ${score}%`
        : `${studentCode}: no items captured`;
    await enqueueWhisper({
      sessionId,
      teacherUserId: req.auth?.user_id ?? null,
      text: shortSummary,
      priority: 6,
    }).catch(() => undefined);

    // If more than a couple wrong on the same topic, ask Youtu-VL / Qwen
    // to suggest a remediation. Fire-and-forget onto the intelligence path.
    const wrongTopics = new Map<string, number>();
    for (const it of items) {
      if (it.is_correct) continue;
      const topic = text(it.question_topic, 200);
      if (!topic) continue;
      wrongTopics.set(topic, (wrongTopics.get(topic) ?? 0) + 1);
    }
    for (const [topic, count] of wrongTopics) {
      if (count >= 2) {
        enqueueVisionAnalysisSafe({
          studentCode,
          question: `Student ${studentCode} got ${count} questions wrong on ${topic}. Recommend a 3-step remediation plan for their teacher (KobeAI Qwen worker will complete this).`,
          reason: "auto:paper_grading_pattern",
          priority: 5,
          context: { topic, wrong_count: count, subject, assessment },
        });
      }
    }

    // Kick the student-development pipeline. Both steps are best-effort:
    // a failure here doesn't take down the paper submission itself, since
    // the raw graded_papers row is already committed.
    let notesGenerated = 0;
    let retest: { retest_id: number; items: number } | null = null;
    try {
      notesGenerated = await generateCuratedNotesForPaper(paperId);
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e), paperId },
        "curated-notes generation skipped",
      );
    }
    try {
      retest = await generateRetestForPaper(paperId);
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e), paperId },
        "retest generation skipped",
      );
    }

    // Follow-up whisper so the teacher hears what was generated
    // ("3 notes ready, 6-question retest queued").
    if (notesGenerated > 0 || retest) {
      const parts: string[] = [];
      if (notesGenerated > 0) parts.push(`${notesGenerated} curated note${notesGenerated === 1 ? "" : "s"} ready`);
      if (retest) parts.push(`retest ${retest.items} question${retest.items === 1 ? "" : "s"} queued`);
      await enqueueWhisper({
        sessionId,
        teacherUserId: req.auth?.user_id ?? null,
        text: `For ${studentCode}: ${parts.join(", ")}.`,
        priority: 4,
      }).catch(() => undefined);
    }

    res.status(201).json({
      paper: paper.rows[0],
      summary: { total, correct, incorrect, score_percent: score },
      curated_notes_generated: notesGenerated,
      retest,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    logger.error({ err }, "teacher-lens paper-graded transaction failed");
    res.status(500).json({ error: "insert_failed" });
  } finally {
    client.release();
  }
});

/**
 * POST /v1/teacher-lens/lookup
 * Teacher looks at a student and taps the lens button. Client either
 * supplies the student_code (from face-recognition already done client-
 * side) or a face_signature the server will resolve. Server returns a
 * short brief and enqueues a whisper.
 * Body: { student_code?: string, session_id?: number }
 */
router.post("/v1/teacher-lens/lookup", requireTeacher, async (req, res) => {
  await ensureTables();
  const studentCode = text(req.body?.student_code, 100);
  if (!studentCode) {
    res.status(400).json({
      error: "student_code required. Face-recognition-based lookup will hit /v1/teacher-lens/frame once the vision worker is wired.",
    });
    return;
  }
  const sessionId = Number.isFinite(Number(req.body?.session_id))
    ? Number(req.body.session_id)
    : null;

  const profile = await getMergedProfile(studentCode);
  if (!profile) {
    res.status(404).json({ error: "student_not_found" });
    return;
  }

  // Recent grading — the teacher wants "how did they do last time".
  const recent = await pool.query(
    `SELECT assessment_title, subject, score_percent, graded_at
     FROM graded_papers
     WHERE student_code = $1
     ORDER BY graded_at DESC
     LIMIT 3`,
    [studentCode],
  );

  const weakBits = profile.topics_weak.slice(0, 3).join(", ");
  const strongBits = profile.topics_strong.slice(0, 3).join(", ");
  const lastScore = recent.rows[0]?.score_percent ?? null;
  const lastSubject = recent.rows[0]?.subject ?? null;

  const parts: string[] = [];
  parts.push(`${profile.student_name ?? studentCode}.`);
  if (lastScore != null && lastSubject) parts.push(`Last ${lastSubject}: ${lastScore} percent.`);
  if (weakBits) parts.push(`Weak in ${weakBits}.`);
  if (strongBits && !weakBits) parts.push(`Strong in ${strongBits}.`);
  const whisper = parts.join(" ");

  await enqueueWhisper({
    sessionId,
    teacherUserId: req.auth?.user_id ?? null,
    text: whisper,
    priority: 3,
  });

  res.json({
    student_code: studentCode,
    student_name: profile.student_name,
    whisper,
    profile: {
      topics_strong: profile.topics_strong,
      topics_weak: profile.topics_weak,
      attendance_rate: profile.attendance_rate,
      questions_asked_count: profile.questions_asked_count,
    },
    recent_papers: recent.rows,
  });
});

/**
 * GET /v1/teacher-lens/whisper/next
 * The lens app long-polls this (or plain polls it every ~1s). Server
 * atomically claims the next pending whisper for this session and marks
 * it "played". Returns 204 when the queue is empty.
 */
router.get("/v1/teacher-lens/whisper/next", requireTeacher, async (req, res) => {
  await ensureTables();
  const sessionId = Number.isFinite(Number(req.query["session_id"]))
    ? Number(req.query["session_id"])
    : null;
  const teacherId = req.auth?.user_id ?? null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const picked = await client.query(
      `SELECT id FROM teacher_lens_whispers
       WHERE status = 'pending'
         AND ($1::int IS NULL OR session_id = $1)
         AND ($2::int IS NULL OR teacher_user_id = $2)
       ORDER BY priority ASC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [sessionId, teacherId],
    );
    if (picked.rows.length === 0) {
      await client.query("COMMIT");
      res.status(204).end();
      return;
    }
    const updated = await client.query(
      `UPDATE teacher_lens_whispers
       SET status = 'played', played_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [picked.rows[0].id],
    );
    await client.query("COMMIT");
    res.json({ whisper: updated.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    logger.error({ err }, "teacher-lens whisper claim failed");
    res.status(500).json({ error: "claim_failed" });
  } finally {
    client.release();
  }
});

/**
 * GET /v1/teacher-lens/student/:studentCode/summary
 * A more detailed brief the teacher's phone can render on-screen while
 * the whisper plays. Not queued — one-shot HTTP.
 */
router.get(
  "/v1/teacher-lens/student/:studentCode/summary",
  requireTeacher,
  async (req: Request, res: Response) => {
    const studentCode = text(req.params.studentCode, 100);
    if (!studentCode) {
      res.status(400).json({ error: "student_code required" });
      return;
    }
    const profile = await getMergedProfile(studentCode);
    if (!profile) {
      res.status(404).json({ error: "student_not_found" });
      return;
    }
    const recent = await pool.query(
      `SELECT id, assessment_title, subject, score_percent, correct_count,
              incorrect_count, total_questions, graded_at
       FROM graded_papers
       WHERE student_code = $1
       ORDER BY graded_at DESC
       LIMIT 5`,
      [studentCode],
    );
    const wrongTopics = await pool.query(
      `SELECT i.question_topic, COUNT(*)::int AS wrong_count
       FROM graded_paper_items i
       INNER JOIN graded_papers p ON p.id = i.paper_id
       WHERE p.student_code = $1
         AND i.is_correct = FALSE
         AND i.question_topic IS NOT NULL
       GROUP BY i.question_topic
       ORDER BY wrong_count DESC
       LIMIT 5`,
      [studentCode],
    );
    res.json({
      profile,
      recent_papers: recent.rows,
      recurring_weak_topics: wrongTopics.rows,
    });
  },
);

export default router;
