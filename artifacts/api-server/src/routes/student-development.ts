import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth, verifyToken } from "../lib/auth";
import {
  BEHAVIOR_CATEGORIES,
  ensureStudentDevelopmentTables,
  generateAllLessonPlans,
  generateCuratedNotesForPaper,
  generateLessonPlanForStudent,
  generateRetestForPaper,
  recordBehaviorObservation,
  recordRetestResult,
} from "../lib/student-development";

import { requirePremium } from "../lib/entitlements";
const router = Router();
const requireStaff = requireAuth(["teacher", "admin", "super_admin"]);

// Behavior observations may come from a kiosk / vision worker running
// alongside KobeVision — accept the same shared-secret header we use for
// presence events, plus staff JWTs for manual testing.
function requireWorkerOrStaff(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env["KOBEVISION_SHARED_SECRET"];
  const provided = req.header("x-kobevision-secret");
  if (secret && provided) {
    const a = Buffer.from(secret);
    const b = Buffer.from(provided);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      next();
      return;
    }
  }
  const header = req.header("authorization") ?? req.header("Authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) {
    const principal = verifyToken(header.slice(7).trim());
    if (principal && ["teacher", "admin", "super_admin"].includes(principal.role)) {
      req.auth = principal;
      next();
      return;
    }
  }
  res.status(401).json({ error: "behavior_worker_auth_required" });
}

function text(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Curated notes
// ---------------------------------------------------------------------------
router.get("/v1/staff/curated-notes/:studentCode", requireStaff, requirePremium("revision"), async (req, res) => {
  await ensureStudentDevelopmentTables();
  const studentCode = text(req.params.studentCode, 100);
  if (!studentCode) {
    res.status(400).json({ error: "student_code required" });
    return;
  }
  const limit = Math.max(1, Math.min(200, Number(req.query["limit"] ?? 50)));
  const rows = await pool.query(
    `SELECT id, source_paper_id, subject, topic, student_answer, ideal_answer,
            body_markdown, generator, status, created_at
     FROM student_curated_notes
     WHERE student_code = $1 AND status = 'published'
     ORDER BY created_at DESC
     LIMIT $2`,
    [studentCode, limit],
  );
  res.json({ notes: rows.rows });
});

router.post("/v1/staff/curated-notes/:id/flag", requireStaff, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const rows = await pool.query(
    `UPDATE student_curated_notes SET status = 'flagged' WHERE id = $1 RETURNING id`,
    [id],
  );
  if (!rows.rows[0]) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

// Optional manual regeneration for a paper (mostly for demo / debug).
router.post("/v1/staff/curated-notes/regenerate", requireStaff, requirePremium("revision"), async (req, res) => {
  const paperId = Number(req.body?.paper_id);
  if (!Number.isInteger(paperId) || paperId <= 0) {
    res.status(400).json({ error: "paper_id required" });
    return;
  }
  const inserted = await generateCuratedNotesForPaper(paperId);
  res.json({ inserted });
});

// ---------------------------------------------------------------------------
// Retests
// ---------------------------------------------------------------------------
router.get("/v1/staff/retests/:studentCode", requireStaff, requirePremium("revision"), async (req, res) => {
  await ensureStudentDevelopmentTables();
  const studentCode = text(req.params.studentCode, 100);
  if (!studentCode) {
    res.status(400).json({ error: "student_code required" });
    return;
  }
  const status = text(req.query["status"], 40);
  const filters: string[] = [`s.student_code = $1`];
  const values: unknown[] = [studentCode];
  if (status) {
    values.push(status);
    filters.push(`s.status = $${values.length}`);
  }
  const rows = await pool.query(
    `SELECT s.*, (
       SELECT json_agg(row_to_json(i.*)) FROM (
         SELECT id, topic, question_text, expected_answer, difficulty_level
         FROM retest_items WHERE session_id = s.id ORDER BY id
       ) i
     ) AS items
     FROM retest_sessions s
     WHERE ${filters.join(" AND ")}
     ORDER BY generated_at DESC
     LIMIT 20`,
    values,
  );
  res.json({ retests: rows.rows });
});

router.post("/v1/staff/retests/:id/record", requireStaff, async (req, res) => {
  const id = Number(req.params.id);
  const score = Number(req.body?.score_percent);
  if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(score) || score < 0 || score > 100) {
    res.status(400).json({ error: "invalid id or score_percent (0..100 required)" });
    return;
  }
  await recordRetestResult({
    sessionId: id,
    scorePercent: Math.round(score),
    resultPaperId: Number.isFinite(Number(req.body?.result_paper_id))
      ? Number(req.body.result_paper_id)
      : null,
  });
  res.json({ ok: true });
});

router.post("/v1/staff/retests/regenerate", requireStaff, requirePremium("revision"), async (req, res) => {
  const paperId = Number(req.body?.paper_id);
  if (!Number.isInteger(paperId) || paperId <= 0) {
    res.status(400).json({ error: "paper_id required" });
    return;
  }
  const outcome = await generateRetestForPaper(paperId);
  if (!outcome) {
    res.json({ retest: null, note: "no wrong topics on paper" });
    return;
  }
  res.status(201).json(outcome);
});

// ---------------------------------------------------------------------------
// Behavior observations
// ---------------------------------------------------------------------------
router.post("/v1/behavior/event", requireWorkerOrStaff, async (req, res) => {
  await ensureStudentDevelopmentTables();
  const studentCode = text(req.body?.student_code, 100);
  const category = text(req.body?.category, 40);
  if (!studentCode || !category) {
    res.status(400).json({ error: "student_code and category required" });
    return;
  }
  if (!BEHAVIOR_CATEGORIES.includes(category as (typeof BEHAVIOR_CATEGORIES)[number])) {
    res.status(400).json({
      error: `invalid category — one of ${BEHAVIOR_CATEGORIES.join(", ")}`,
    });
    return;
  }
  const outcome = await recordBehaviorObservation({
    studentCode,
    cameraId: text(req.body?.camera_id, 160),
    zoneId: Number.isFinite(Number(req.body?.zone_id)) ? Number(req.body.zone_id) : null,
    category: category as (typeof BEHAVIOR_CATEGORIES)[number],
    confidence: Number(req.body?.confidence ?? 70),
    description: text(req.body?.description, 500),
    periodId: Number.isFinite(Number(req.body?.period_id)) ? Number(req.body.period_id) : null,
    subject: text(req.body?.subject, 200),
    metadata:
      req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {},
  });
  res.status(201).json({ observation: outcome });
});

router.get("/v1/staff/behavior/:studentCode", requireStaff, async (req, res) => {
  await ensureStudentDevelopmentTables();
  const studentCode = text(req.params.studentCode, 100);
  if (!studentCode) {
    res.status(400).json({ error: "student_code required" });
    return;
  }
  const sinceHours = Math.max(1, Math.min(720, Number(req.query["since_hours"] ?? 168)));
  const rows = await pool.query(
    `SELECT id, camera_id, category, confidence, description, subject, captured_at
     FROM student_behavior_observations
     WHERE student_code = $1
       AND captured_at >= NOW() - ($2::text || ' hours')::interval
     ORDER BY captured_at DESC
     LIMIT 200`,
    [studentCode, sinceHours],
  );
  const summary = await pool.query(
    `SELECT category, COUNT(*)::int AS n
     FROM student_behavior_observations
     WHERE student_code = $1
       AND captured_at >= NOW() - ($2::text || ' hours')::interval
     GROUP BY category
     ORDER BY n DESC`,
    [studentCode, sinceHours],
  );
  res.json({ observations: rows.rows, summary: summary.rows });
});

// ---------------------------------------------------------------------------
// Personalized lesson plans
// ---------------------------------------------------------------------------
router.post("/v1/staff/lesson-plans/generate", requireStaff, requirePremium("learning_plan"), async (req, res) => {
  const studentCode = text(req.body?.student_code ?? req.query["student_code"], 100);
  if (studentCode) {
    const outcome = await generateLessonPlanForStudent(
      studentCode,
      text(req.body?.week_start, 40) ?? undefined,
      req.auth?.user_id ?? null,
    );
    if (!outcome) {
      res.status(404).json({ error: "student_not_found_or_no_profile" });
      return;
    }
    res.json({ plan_id: outcome.id, plan_markdown: outcome.plan_markdown });
    return;
  }
  const outcome = await generateAllLessonPlans(
    text(req.body?.week_start, 40) ?? undefined,
    req.auth?.user_id ?? null,
  );
  res.json(outcome);
});

router.get("/v1/staff/lesson-plans/:studentCode/latest", requireStaff, requirePremium("learning_plan"), async (req, res) => {
  await ensureStudentDevelopmentTables();
  const studentCode = text(req.params.studentCode, 100);
  if (!studentCode) {
    res.status(400).json({ error: "student_code required" });
    return;
  }
  const rows = await pool.query(
    `SELECT id, week_start, plan_markdown, snapshot, generator, generated_at
     FROM personalized_lesson_plans
     WHERE student_code = $1
     ORDER BY week_start DESC
     LIMIT 1`,
    [studentCode],
  );
  if (!rows.rows[0]) {
    res.status(404).json({ error: "no_lesson_plan_yet" });
    return;
  }
  res.json({ plan: rows.rows[0] });
});

// ---------------------------------------------------------------------------
// Generated question bank
// ---------------------------------------------------------------------------
router.get("/v1/staff/questions", requireStaff, async (req, res) => {
  await ensureStudentDevelopmentTables();
  const topic = text(req.query["topic"], 200);
  const difficulty = Number.isFinite(Number(req.query["difficulty"]))
    ? Number(req.query["difficulty"])
    : null;
  const filters: string[] = [];
  const values: unknown[] = [];
  if (topic) {
    values.push(topic);
    filters.push(`topic = $${values.length}`);
  }
  if (difficulty != null) {
    values.push(difficulty);
    filters.push(`difficulty_level = $${values.length}`);
  }
  values.push(Math.max(1, Math.min(200, Number(req.query["limit"] ?? 50))));
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = await pool.query(
    `SELECT id, topic, subject, difficulty_level, question_text, expected_answer,
            generator, used_count, created_at
     FROM generated_questions
     ${where}
     ORDER BY topic, difficulty_level, used_count
     LIMIT $${values.length}`,
    values,
  );
  res.json({ questions: rows.rows });
});

export default router;
