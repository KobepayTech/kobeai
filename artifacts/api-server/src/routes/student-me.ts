import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";
import { nextFocus, studentView, type StudentSkillView } from "../lib/mastery-bands";
import { assess, type EvidenceKind, EVIDENCE_KINDS } from "../lib/evidence";
import { k9RuntimePost } from "../lib/k9-runtime";
import { askAI } from "../lib/ai-provider";

// ===========================================================================
// The student's own view of their learning.
//
// Everything here is banded, never numeric — see lib/mastery-bands.ts. A
// teacher needs 31% and a declining trend; a fourteen-year-old needs
// "Practising, and moving up". The percentage is not withheld to be gentle, it
// is withheld because it asserts a precision four questions cannot support.
//
// A tablet session is authoritative identity (lib/attribution.ts), so
// everything a child does here attributes to them with no voice recognition
// anywhere near it.
// ===========================================================================

const router = Router();
const student = requireAuth(["student"]);

/** GET /v1/student/me — the learning map. */
router.get("/v1/student/me", student, async (req, res) => {
  const studentId = req.auth!.user_id;
  try {
    const { rows } = await pool.query(
      `SELECT s.id AS skill_id, s.name, s.subject,
              m.mastery, m.confidence, m.trend
         FROM student_skill_mastery m
         JOIN skills s ON s.id = m.skill_id
        WHERE m.student_id = $1
        ORDER BY s.subject, s.name`,
      [studentId],
    );
    const views: StudentSkillView[] = rows.map((r) =>
      studentView({
        skill_id: r.skill_id as number,
        name: r.name as string,
        subject: r.subject as string,
        mastery: Number(r.mastery),
        confidence: Number(r.confidence),
        trend: Number(r.trend),
      }),
    );
    const bySubject = new Map<string, StudentSkillView[]>();
    for (const view of views) {
      const list = bySubject.get(view.subject) ?? [];
      list.push(view);
      bySubject.set(view.subject, list);
    }
    const week = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM classroom_skill_questions
           WHERE student_id = $1 AND asked_at > now() - interval '7 days') AS questions,
         (SELECT COUNT(DISTINCT skill_id)::int FROM skill_observations
           WHERE student_id = $1 AND observed_at > now() - interval '7 days') AS skills_practised`,
      [studentId],
    );
    res.json({
      subjects: [...bySubject.entries()].map(([subject, skills]) => ({ subject, skills })),
      focus: nextFocus(views),
      week: {
        questions_asked: week.rows[0]?.questions ?? 0,
        skills_practised: week.rows[0]?.skills_practised ?? 0,
      },
    });
  } catch (error) {
    logger.error({ error, studentId }, "student learning map failed");
    res.status(500).json({ error: "could not load your learning map" });
  }
});

/** GET /v1/student/today — the day, from the timetable. */
router.get("/v1/student/today", student, async (req, res) => {
  const studentId = req.auth!.user_id;
  try {
    const { rows } = await pool.query(
      `SELECT tp.id AS period_id, tp.subject, tp.room, tp.start_minute, tp.end_minute
         FROM timetable_periods tp
         JOIN class_memberships cm ON cm.class_id = tp.class_id
        WHERE cm.student_id = $1
          AND tp.day_of_week = EXTRACT(ISODOW FROM NOW())::int
        ORDER BY tp.start_minute`,
      [studentId],
    );
    const now = new Date().getHours() * 60 + new Date().getMinutes();
    res.json({
      now_minute: now,
      periods: rows.map((r) => ({
        ...r,
        state:
          r.end_minute <= now ? "done" : r.start_minute <= now ? "now" : "upcoming",
      })),
    });
  } catch (error) {
    logger.error({ error, studentId }, "student timetable failed");
    res.status(500).json({ error: "could not load your day" });
  }
});

/**
 * POST /v1/student/interaction
 *
 * The tablet reports what the child actually did — asked, requested a simpler
 * explanation, took a hint, tried again. The evidence gate decides whether any
 * of it is a measurement; most of it is not, and that is the point.
 *
 * The response says plainly whether this moved anything, so the UI never has to
 * guess and no future screen can imply a score changed when it did not.
 */
router.post("/v1/student/interaction", student, async (req, res) => {
  const kind = String(req.body?.kind ?? "");
  if (!(EVIDENCE_KINDS as readonly string[]).includes(kind)) {
    res.status(400).json({ error: `kind must be one of ${EVIDENCE_KINDS.join(", ")}` });
    return;
  }
  const verdict = assess({
    kind: kind as EvidenceKind,
    assisted: req.body?.assisted === true,
    correct: typeof req.body?.correct === "boolean" ? req.body.correct : null,
  });
  try {
    await pool.query(
      `INSERT INTO student_interactions
         (student_id, kind, subject, skill_id, assisted, correct, moves_mastery, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        req.auth!.user_id,
        kind,
        typeof req.body?.subject === "string" ? req.body.subject.slice(0, 200) : null,
        Number.isFinite(Number(req.body?.skill_id)) ? Number(req.body.skill_id) : null,
        req.body?.assisted === true,
        typeof req.body?.correct === "boolean" ? req.body.correct : null,
        verdict.moves_mastery,
        typeof req.body?.detail === "string" ? req.body.detail.slice(0, 800) : null,
      ],
    );
    res.status(201).json(verdict);
  } catch (error) {
    logger.error({ error }, "student interaction failed");
    res.status(500).json({ error: "could not record that" });
  }
});

/**
 * POST /v1/student/scan
 *
 * A photographed question, or a photograph of the child's own working. The
 * image is read by the local runtime — it never leaves the school — and the
 * text becomes an ordinary question.
 *
 * `kind` distinguishes the two, and it matters for evidence: a photographed
 * textbook question is a question, while a photograph of working the child did
 * is an attempt. Neither moves mastery on its own, because K9 cannot tell from
 * a photograph whether they were helped.
 */
router.post("/v1/student/scan", student, async (req, res) => {
  const image = typeof req.body?.image === "string" ? req.body.image : null;
  const kind = req.body?.kind === "working" ? "working" : "question";
  if (!image || image.length > 12_000_000) {
    res.status(400).json({ error: "a base64 image is required (max ~9MB)" });
    return;
  }
  const subject = typeof req.body?.subject === "string" ? req.body.subject.slice(0, 200) : null;
  try {
    const read = await k9RuntimePost<{ text?: string }>(
      "/v1/vision/describe",
      {
        image,
        prompt:
          kind === "working"
            ? "Transcribe this student's handwritten working exactly, line by line. Do not correct it."
            : "Transcribe the question in this image exactly. Return only the question.",
      },
      45_000,
    );
    const text = (read.text ?? "").trim();
    if (!text) {
      res.status(422).json({
        error: "K9 could not read that. Try again with more light, or type it out.",
      });
      return;
    }
    const answer = await askAI(
      kind === "working"
        ? `A student photographed their own working and asked why their answer is wrong. ` +
            `Find the step where it goes wrong, say which step and why, then give ONE similar ` +
            `problem to try. Do not give the final answer.\n\n${text}`
        : text,
      subject
        ? `You are K9, a patient tutor for Tanzanian secondary students. The lesson is ${subject}.`
        : undefined,
    );
    // Recorded as evidence, and deliberately not as a measurement: a
    // photograph cannot tell K9 whether the child was helped.
    await pool.query(
      `INSERT INTO student_interactions
         (student_id, kind, subject, assisted, moves_mastery, detail)
       VALUES ($1, $2, $3, true, false, $4)`,
      [
        req.auth!.user_id,
        kind === "working" ? "guided_attempt" : "question",
        subject,
        text.slice(0, 800),
      ],
    );
    res.json({ read: text, answer: answer.answer, moves_mastery: false });
  } catch (error) {
    logger.error({ error }, "student scan failed");
    res.status(503).json({ error: "K9 could not read that just now." });
  }
});

export default router;
