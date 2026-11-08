import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { requirePremium } from "../lib/entitlements";
import { logger } from "../lib/logger";
import { assess } from "../lib/evidence";

// ===========================================================================
// Learn and School: the rest of the tablet.
//
// Two rules carried through from elsewhere, and one distinction that matters:
//
//   - Revision and practice are the premium tier (docs/K9_SUBSCRIPTIONS.md),
//     gated on this student's own subscription.
//   - A practice answered unaided is a `diagnostic` and DOES move mastery —
//     this is the one place the tablet produces a real measurement. Ask for a
//     hint and the same question becomes a guided attempt that moves nothing.
//   - **Exam marks are shown as numbers.** The no-percentages rule
//     (lib/mastery-bands.ts) is about K9's *inference* of mastery, which four
//     questions cannot support to a decimal place. A mark a teacher awarded is
//     the school's own record of its own pupil and has always been the child's
//     to see.
// ===========================================================================

const router = Router();
const student = requireAuth(["student"]);

/**
 * The signed-in student's own code.
 *
 * `requirePremium` resolves the same student through `subjectStudentCode`,
 * which falls through to `req.auth.student_id` when no path or query names one
 * — so a child asking about themselves is gated on their own subscription,
 * which is what the tier boundary intends.
 */
function selfCode(req: { auth?: { student_id?: string } }): string | null {
  return req.auth?.student_id ?? null;
}

/** GET /v1/student/notes — revision K9 wrote from this student's own marking. */
router.get("/v1/student/notes", student, requirePremium("revision"), async (req, res) => {
  const code = selfCode(req);
  if (!code) return void res.status(401).json({ error: "no student" });
  try {
    const { rows } = await pool.query(
      `SELECT id, subject, topic, body_markdown, created_at
         FROM student_curated_notes
        WHERE student_code = $1 AND status <> 'flagged'
        ORDER BY created_at DESC LIMIT 40`,
      [code],
    );
    res.json({ entitled: true, notes: rows });
  } catch (error) {
    logger.error({ error }, "student notes failed");
    res.status(500).json({ error: "could not load your notes" });
  }
});

/** GET /v1/student/practice — retests waiting for this student. */
// `revision` covers curated notes, retests and practice sets — one feature,
// because a school buys the revision layer, not three separate things.
router.get("/v1/student/practice", student, requirePremium("revision"), async (req, res) => {
  const code = selfCode(req);
  if (!code) return void res.status(401).json({ error: "no student" });
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.subject, s.difficulty_level, s.status, s.generated_at,
              COUNT(i.id)::int AS questions
         FROM retest_sessions s
         LEFT JOIN retest_items i ON i.session_id = s.id
        WHERE s.student_code = $1 AND s.status IN ('ready','generated','pending')
        GROUP BY s.id
        ORDER BY s.generated_at DESC LIMIT 20`,
      [code],
    );
    res.json({ entitled: true, practice: rows });
  } catch (error) {
    logger.error({ error }, "student practice list failed");
    res.status(500).json({ error: "could not load your practice" });
  }
});

/** GET /v1/student/practice/:id — the questions, without their answers. */
router.get("/v1/student/practice/:id", student, async (req, res) => {
  const code = selfCode(req);
  const id = Number(req.params["id"]);
  if (!code || !Number.isFinite(id)) return void res.status(400).json({ error: "bad request" });
  try {
    const { rows: owned } = await pool.query(
      `SELECT id, subject FROM retest_sessions WHERE id = $1 AND student_code = $2`,
      [id, code],
    );
    if (!owned.length) return void res.status(404).json({ error: "not found" });
    // expected_answer is deliberately not selected. A practice whose answers
    // are in the page is not a measurement of anything.
    const { rows } = await pool.query(
      `SELECT id, topic, question_text FROM retest_items WHERE session_id = $1 ORDER BY id`,
      [id],
    );
    res.json({ id, subject: owned[0]!.subject, items: rows });
  } catch (error) {
    logger.error({ error, id }, "student practice load failed");
    res.status(500).json({ error: "could not load that practice" });
  }
});

/**
 * POST /v1/student/practice/:id/answer
 *
 * One answer. `used_hint` is the whole point: the same correct answer is a
 * measurement when it was reached alone and a record of a hint working when it
 * was not. The verdict comes back so the UI never has to guess, and so a child
 * is never told their marks moved when they did not.
 */
router.post("/v1/student/practice/:id/answer", student, async (req, res) => {
  const code = selfCode(req);
  const id = Number(req.params["id"]);
  const itemId = Number(req.body?.item_id);
  const answer = typeof req.body?.answer === "string" ? req.body.answer.slice(0, 2000) : "";
  if (!code || !Number.isFinite(id) || !Number.isFinite(itemId) || !answer)
    return void res.status(400).json({ error: "item_id and answer required" });
  const usedHint = req.body?.used_hint === true;
  try {
    const { rows } = await pool.query(
      `SELECT i.expected_answer, i.topic, s.subject
         FROM retest_items i
         JOIN retest_sessions s ON s.id = i.session_id
        WHERE i.id = $1 AND i.session_id = $2 AND s.student_code = $3`,
      [itemId, id, code],
    );
    if (!rows.length) return void res.status(404).json({ error: "not found" });
    const expected = String(rows[0]!.expected_answer ?? "").trim().toLowerCase();
    const given = answer.trim().toLowerCase();
    // Generous string matching only: this marks practice, never a grade. A
    // teacher's mark remains the only thing that decides an exam.
    const correct = expected.length > 0 && (given === expected || given.includes(expected));
    const verdict = assess({ kind: "diagnostic", assisted: usedHint, correct });
    await pool.query(
      `INSERT INTO student_interactions
         (student_id, kind, subject, assisted, correct, moves_mastery, detail)
       VALUES ($1,'diagnostic',$2,$3,$4,$5,$6)`,
      [
        req.auth!.user_id,
        rows[0]!.subject,
        usedHint,
        correct,
        verdict.moves_mastery,
        `${rows[0]!.topic ?? ""}: ${answer.slice(0, 300)}`,
      ],
    );
    res.json({ correct, ...verdict });
  } catch (error) {
    logger.error({ error, id }, "practice answer failed");
    res.status(500).json({ error: "could not record that answer" });
  }
});

/**
 * GET /v1/student/school — the week, the marks, attendance, KP.
 *
 * All baseline: none of this is the intelligence layer, so none of it is gated.
 * A child's own timetable, marks and attendance are the school's record of its
 * own pupil and are never for sale (docs/K9_SUBSCRIPTIONS.md).
 */
router.get("/v1/student/school", student, async (req, res) => {
  const code = selfCode(req);
  const userId = req.auth!.user_id;
  try {
    const [week, results, attendance, kp, subscription] = await Promise.all([
      pool.query(
        `SELECT tp.day_of_week, tp.subject, tp.room, tp.start_minute, tp.end_minute
           FROM timetable_periods tp
           JOIN class_memberships cm ON cm.class_id = tp.class_id
          WHERE cm.student_id = $1
          ORDER BY tp.day_of_week, tp.start_minute`,
        [userId],
      ),
      pool.query(
        `SELECT subject, marks_awarded, marks_possible, created_at
           FROM graded_papers
          WHERE student_id = $1
          ORDER BY created_at DESC LIMIT 20`,
        [userId],
      ).catch(() => ({ rows: [] as Record<string, unknown>[] })),
      pool.query(
        `SELECT attendance_rate FROM student_learning_profile WHERE student_code = $1 LIMIT 1`,
        [code],
      ).catch(() => ({ rows: [] as Record<string, unknown>[] })),
      pool.query(`SELECT balance FROM student_kp WHERE user_id = $1 LIMIT 1`, [userId]).catch(
        () => ({ rows: [] as Record<string, unknown>[] }),
      ),
      pool.query(
        `SELECT status, expires_at FROM subscription_cache WHERE student_code = $1 LIMIT 1`,
        [code],
      ).catch(() => ({ rows: [] as Record<string, unknown>[] })),
    ]);
    res.json({
      week: week.rows,
      results: results.rows,
      attendance_rate: (attendance.rows[0] as { attendance_rate?: number } | undefined)
        ?.attendance_rate ?? null,
      kp_balance: (kp.rows[0] as { balance?: number } | undefined)?.balance ?? 0,
      subscription: subscription.rows[0] ?? null,
    });
  } catch (error) {
    logger.error({ error }, "student school view failed");
    res.status(500).json({ error: "could not load your school page" });
  }
});

/**
 * POST /v1/student/listen — a spoken question, transcribed on the school's
 * own runtime. The audio is held for the length of the request and dropped.
 */
router.post("/v1/student/listen", student, async (req, res) => {
  const audio = typeof req.body?.audio === "string" ? req.body.audio : null;
  if (!audio || audio.length > 8_000_000)
    return void res.status(400).json({ error: "a base64 WAV is required" });
  try {
    const { k9RuntimePost } = await import("../lib/k9-runtime");
    const out = await k9RuntimePost<{ text?: string }>(
      "/v1/transcribe",
      { audio, ...(req.body?.language ? { language: String(req.body.language) } : {}) },
      45_000,
    );
    const text = (out.text ?? "").trim();
    if (!text)
      return void res.status(422).json({ error: "K9 did not catch that. Try again." });
    res.json({ text });
  } catch (error) {
    logger.error({ error }, "student listen failed");
    res.status(503).json({ error: "K9 could not listen just now." });
  }
});

export default router;
