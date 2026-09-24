import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";
import { nextFocus, studentView, type StudentSkillView } from "../lib/mastery-bands";
import { assess, type EvidenceKind, EVIDENCE_KINDS } from "../lib/evidence";

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

export default router;
