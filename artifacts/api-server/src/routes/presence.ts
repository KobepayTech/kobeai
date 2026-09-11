import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { pool } from "@workspace/db";
import { verifyToken } from "../lib/auth";
import {
  ensurePresenceTables,
  presenceConfig,
  recordPresenceEvent,
  runPresenceCheckpoint,
} from "../lib/presence-monitor";

const router = Router();

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(req: Request): string | null {
  const header = req.header("authorization") ?? req.header("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

function requirePresenceServiceOrStaff(req: Request, res: Response, next: NextFunction): void {
  const configuredSecret = process.env["KOBEVISION_SHARED_SECRET"];
  const suppliedSecret = req.header("x-kobevision-secret");
  const token = bearer(req);

  if (
    configuredSecret &&
    ((suppliedSecret && safeEqual(configuredSecret, suppliedSecret)) ||
      (token && safeEqual(configuredSecret, token)))
  ) {
    next();
    return;
  }

  if (token) {
    const principal = verifyToken(token);
    if (principal && ["teacher", "admin", "super_admin"].includes(principal.role)) {
      req.auth = principal;
      next();
      return;
    }
  }

  res.status(401).json({ error: "presence_auth_required" });
}

function requireStaff(req: Request, res: Response, next: NextFunction): void {
  const token = bearer(req);
  if (!token) {
    res.status(401).json({ error: "missing bearer token" });
    return;
  }
  const principal = verifyToken(token);
  if (!principal) {
    res.status(401).json({ error: "invalid or expired token" });
    return;
  }
  if (!["teacher", "admin", "super_admin"].includes(principal.role)) {
    res.status(403).json({ error: "staff role required" });
    return;
  }
  req.auth = principal;
  next();
}

function text(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function number01(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

router.use("/v1/presence", requirePresenceServiceOrStaff);

router.get("/v1/presence/health", async (_req, res) => {
  await ensurePresenceTables();
  const cameras = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE enabled)::int AS enabled
     FROM campus_cameras`,
  );
  const zones = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE active)::int AS active
     FROM campus_zones`,
  );
  res.json({
    ok: true,
    config: presenceConfig,
    cameras: cameras.rows[0],
    zones: zones.rows[0],
  });
});

/** Vision service posts recognized student sightings here. Raw images are not accepted. */
router.post("/v1/presence/event", async (req, res) => {
  const studentCode = text(req.body?.student_code ?? req.body?.studentCode, 100);
  const cameraId = text(req.body?.camera_id ?? req.body?.cameraId, 160);
  const confidence = number01(req.body?.confidence);
  if (!studentCode || !cameraId || confidence === null) {
    res.status(400).json({
      error: "student_code, camera_id, and confidence between 0 and 1 are required",
    });
    return;
  }

  try {
    const event = await recordPresenceEvent({
      studentCode,
      cameraId,
      confidence,
      faceQuality: number01(req.body?.face_quality ?? req.body?.faceQuality),
      capturedAt: text(req.body?.captured_at ?? req.body?.capturedAt, 100),
      trackId: text(req.body?.track_id ?? req.body?.trackId, 160),
      modelVersion: text(req.body?.model_version ?? req.body?.modelVersion, 160),
      metadata:
        req.body?.metadata && typeof req.body.metadata === "object"
          ? req.body.metadata
          : {},
    });
    res.status(201).json({ event });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message === "camera_not_registered" ? 404 : 400;
    res.status(code).json({ error: message });
  }
});

router.post("/v1/presence/zones", requireStaff, async (req, res) => {
  await ensurePresenceTables();
  const code = text(req.body?.code, 100);
  const name = text(req.body?.name, 160);
  const zoneType = text(req.body?.zone_type ?? req.body?.zoneType, 40);
  const allowed = new Set(["classroom", "library", "dining", "office", "corridor", "outdoor", "other"]);
  if (!code || !name || !zoneType || !allowed.has(zoneType)) {
    res.status(400).json({ error: "valid code, name, and zone_type are required" });
    return;
  }
  const classId = req.body?.class_id ?? req.body?.classId;
  const result = await pool.query(
    `INSERT INTO campus_zones (code, name, zone_type, class_id, room, active, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (code)
     DO UPDATE SET
       name = EXCLUDED.name,
       zone_type = EXCLUDED.zone_type,
       class_id = EXCLUDED.class_id,
       room = EXCLUDED.room,
       active = EXCLUDED.active,
       metadata = campus_zones.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [
      code,
      name,
      zoneType,
      classId == null || classId === "" ? null : Number(classId),
      text(req.body?.room, 160),
      req.body?.active !== false,
      JSON.stringify(req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {}),
    ],
  );
  res.status(201).json({ zone: result.rows[0] });
});

router.get("/v1/presence/zones", requireStaff, async (_req, res) => {
  await ensurePresenceTables();
  const rows = await pool.query(`SELECT * FROM campus_zones ORDER BY zone_type, name`);
  res.json({ zones: rows.rows });
});

router.post("/v1/presence/cameras", requireStaff, async (req, res) => {
  await ensurePresenceTables();
  const cameraId = text(req.body?.camera_id ?? req.body?.cameraId, 160);
  const name = text(req.body?.name, 160);
  const zoneCode = text(req.body?.zone_code ?? req.body?.zoneCode, 100);
  if (!cameraId || !name || !zoneCode) {
    res.status(400).json({ error: "camera_id, name, and zone_code are required" });
    return;
  }
  const zone = await pool.query(`SELECT id FROM campus_zones WHERE code = $1 LIMIT 1`, [zoneCode]);
  if (!zone.rows[0]) {
    res.status(404).json({ error: "zone_not_found" });
    return;
  }
  const result = await pool.query(
    `INSERT INTO campus_cameras (camera_id, name, zone_id, enabled, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (camera_id)
     DO UPDATE SET
       name = EXCLUDED.name,
       zone_id = EXCLUDED.zone_id,
       enabled = EXCLUDED.enabled,
       metadata = campus_cameras.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [
      cameraId,
      name,
      zone.rows[0].id,
      req.body?.enabled !== false,
      JSON.stringify(req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {}),
    ],
  );
  res.status(201).json({ camera: result.rows[0] });
});

router.get("/v1/presence/cameras", requireStaff, async (_req, res) => {
  await ensurePresenceTables();
  const rows = await pool.query(
    `SELECT c.*, z.code AS zone_code, z.name AS zone_name, z.zone_type
     FROM campus_cameras c
     LEFT JOIN campus_zones z ON z.id = c.zone_id
     ORDER BY c.name`,
  );
  res.json({ cameras: rows.rows });
});

/**
 * Override a class-level timetable subject for an individual student.
 * Example: student does not take Physics -> takes_subject=false, fallback_zone_type=library.
 */
router.post("/v1/presence/subject-override", requireStaff, async (req, res) => {
  await ensurePresenceTables();
  const studentCode = text(req.body?.student_code ?? req.body?.studentCode, 100);
  const subject = text(req.body?.subject, 160);
  const fallbackZoneType = text(
    req.body?.fallback_zone_type ?? req.body?.fallbackZoneType ?? "library",
    40,
  );
  if (!studentCode || !subject || !fallbackZoneType) {
    res.status(400).json({ error: "student_code, subject, and fallback_zone_type are required" });
    return;
  }
  const subjectKey = subject.toLowerCase().replace(/\s+/g, " ");
  const result = await pool.query(
    `INSERT INTO student_subject_overrides (
       student_code, subject_key, subject_label, takes_subject,
       fallback_zone_type, notes, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (student_code, subject_key)
     DO UPDATE SET
       subject_label = EXCLUDED.subject_label,
       takes_subject = EXCLUDED.takes_subject,
       fallback_zone_type = EXCLUDED.fallback_zone_type,
       notes = EXCLUDED.notes,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING *`,
    [
      studentCode,
      subjectKey,
      subject,
      req.body?.takes_subject ?? req.body?.takesSubject ?? true,
      fallbackZoneType,
      text(req.body?.notes, 500),
      req.auth?.user_id ?? null,
    ],
  );
  res.status(201).json({ override: result.rows[0] });
});

router.post("/v1/presence/checkpoint/run", requireStaff, async (req, res) => {
  const outcome = await runPresenceCheckpoint({
    source: "manual",
    startedBy: req.auth?.user_id ?? null,
  });
  res.status(201).json(outcome);
});

router.get("/v1/presence/checkpoints/latest", requireStaff, async (_req, res) => {
  await ensurePresenceTables();
  const cp = await pool.query(
    `SELECT * FROM presence_checkpoints ORDER BY run_at DESC LIMIT 1`,
  );
  if (!cp.rows[0]) {
    res.json({ checkpoint: null, results: [] });
    return;
  }
  const results = await pool.query(
    `SELECT r.*, ez.name AS expected_zone_name, az.name AS actual_zone_name,
            az.zone_type AS actual_zone_type
     FROM presence_checkpoint_results r
     LEFT JOIN campus_zones ez ON ez.id = r.expected_zone_id
     LEFT JOIN campus_zones az ON az.id = r.actual_zone_id
     WHERE r.checkpoint_id = $1
     ORDER BY r.requires_review DESC, r.class_name, r.student_name`,
    [cp.rows[0].id],
  );
  res.json({ checkpoint: cp.rows[0], results: results.rows });
});

router.get("/v1/presence/flags", requireStaff, async (req, res) => {
  await ensurePresenceTables();
  const limit = Math.max(1, Math.min(500, Number(req.query["limit"] ?? 100) || 100));
  const reviewStatus = text(req.query["review_status"], 20) ?? "open";
  const rows = await pool.query(
    `SELECT r.*, cp.run_at, cp.school_date, cp.school_minute,
            ez.name AS expected_zone_name,
            az.name AS actual_zone_name,
            az.zone_type AS actual_zone_type
     FROM presence_checkpoint_results r
     INNER JOIN presence_checkpoints cp ON cp.id = r.checkpoint_id
     LEFT JOIN campus_zones ez ON ez.id = r.expected_zone_id
     LEFT JOIN campus_zones az ON az.id = r.actual_zone_id
     WHERE r.requires_review = TRUE AND r.review_status = $1
     ORDER BY cp.run_at DESC, r.student_name
     LIMIT $2`,
    [reviewStatus, limit],
  );
  res.json({ flags: rows.rows });
});

router.post("/v1/presence/results/:id/review", requireStaff, async (req, res) => {
  await ensurePresenceTables();
  const id = Number(req.params.id);
  const reviewStatus = text(req.body?.review_status ?? req.body?.reviewStatus, 20);
  if (!Number.isInteger(id) || !reviewStatus || !["confirmed", "dismissed"].includes(reviewStatus)) {
    res.status(400).json({ error: "valid result id and review_status are required" });
    return;
  }
  const result = await pool.query(
    `UPDATE presence_checkpoint_results
     SET review_status = $2, reviewed_by = $3, reviewed_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, reviewStatus, req.auth?.user_id ?? null],
  );
  if (!result.rows[0]) {
    res.status(404).json({ error: "presence_result_not_found" });
    return;
  }
  res.json({ result: result.rows[0] });
});

/**
 * GET /v1/presence/live
 * Fast-path live map — one row per student showing where they were last
 * seen and whether that agrees with their timetable. Query params:
 *   ?since_minutes=15   (default 30) — only students seen within window
 *   ?mismatch=1          — only rows currently flagged (wrong_location etc.)
 *   ?limit=200           — max rows (default 200, cap 1000)
 */
router.get("/v1/presence/live", requireStaff, async (req, res) => {
  await ensurePresenceTables();
  const since = Math.max(1, Math.min(720, Number(req.query["since_minutes"] ?? 30)));
  const mismatchOnly = req.query["mismatch"] === "1" || req.query["mismatch"] === "true";
  const limit = Math.max(1, Math.min(1000, Number(req.query["limit"] ?? 200)));

  const filters: string[] = [`p.seen_at >= NOW() - ($1::text || ' minutes')::interval`];
  const values: unknown[] = [since];
  if (mismatchOnly) {
    filters.push(`p.mismatch_status IN ('wrong_location', 'configuration_missing')`);
  }
  values.push(limit);

  const rows = await pool.query(
    `SELECT p.student_code, u.name AS student_name,
            p.camera_id, p.zone_id, p.zone_name, p.zone_type,
            p.confidence::float8 AS confidence,
            p.face_quality::float8 AS face_quality,
            p.model_version,
            p.expected_zone_id, p.expected_zone_type,
            ez.name AS expected_zone_name,
            p.mismatch_status,
            p.seen_at, p.updated_at
     FROM current_student_presence p
     LEFT JOIN users u ON u.student_code = p.student_code
     LEFT JOIN campus_zones ez ON ez.id = p.expected_zone_id
     WHERE ${filters.join(" AND ")}
     ORDER BY p.seen_at DESC
     LIMIT $${values.length}`,
    values,
  );
  res.json({ presence: rows.rows });
});

/**
 * GET /v1/presence/live/mismatches
 * Shortcut: just the currently-flagged rows, most recent first. This is the
 * feed the classroom TV kiosk / teacher live-tile subscribes to.
 */
router.get("/v1/presence/live/mismatches", requireStaff, async (req, res) => {
  await ensurePresenceTables();
  const since = Math.max(1, Math.min(720, Number(req.query["since_minutes"] ?? 30)));
  const rows = await pool.query(
    `SELECT p.student_code, u.name AS student_name,
            p.camera_id, p.zone_name, p.zone_type,
            p.confidence::float8 AS confidence,
            p.expected_zone_id, p.expected_zone_type,
            ez.name AS expected_zone_name,
            p.mismatch_status, p.seen_at
     FROM current_student_presence p
     LEFT JOIN users u ON u.student_code = p.student_code
     LEFT JOIN campus_zones ez ON ez.id = p.expected_zone_id
     WHERE p.seen_at >= NOW() - ($1::text || ' minutes')::interval
       AND p.mismatch_status IN ('wrong_location', 'configuration_missing')
     ORDER BY p.seen_at DESC
     LIMIT 200`,
    [since],
  );
  res.json({ mismatches: rows.rows, since_minutes: since });
});

router.get("/v1/presence/student/:studentCode/current", requireStaff, async (req, res) => {
  await ensurePresenceTables();
  const rows = await pool.query(
    `SELECT e.*, z.code AS zone_code, z.name AS zone_name, z.zone_type
     FROM student_presence_events e
     LEFT JOIN campus_zones z ON z.id = e.zone_id
     WHERE e.student_code = $1
     ORDER BY e.captured_at DESC
     LIMIT 1`,
    [req.params.studentCode],
  );
  res.json({ presence: rows.rows[0] ?? null });
});

export default router;
