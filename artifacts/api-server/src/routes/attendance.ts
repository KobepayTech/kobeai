import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../lib/auth";

const router = Router();
const staffAuth = requireAuth(["teacher", "admin", "super_admin"]);

type AttendanceStatus = "present" | "absent" | "late" | "excused";
type AttendanceSource = "ruview" | "manual" | "nfc" | "tablet";

const STATUSES = new Set<AttendanceStatus>(["present", "absent", "late", "excused"]);
const SOURCES = new Set<AttendanceSource>(["ruview", "manual", "nfc", "tablet"]);

let tablesReady: Promise<void> | null = null;

function ensureAttendanceTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS attendance_sessions (
          id BIGSERIAL PRIMARY KEY,
          class_id TEXT NOT NULL,
          class_name TEXT,
          session_date DATE NOT NULL DEFAULT CURRENT_DATE,
          started_by INTEGER,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          closed_at TIMESTAMPTZ,
          source TEXT NOT NULL DEFAULT 'tablet',
          notes TEXT,
          UNIQUE (class_id, session_date)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS attendance_records (
          id BIGSERIAL PRIMARY KEY,
          session_id BIGINT NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
          student_id INTEGER,
          student_code TEXT,
          student_name TEXT,
          status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'late', 'excused')),
          source TEXT NOT NULL CHECK (source IN ('ruview', 'manual', 'nfc', 'tablet')),
          confidence_score NUMERIC(5, 4),
          needs_review BOOLEAN NOT NULL DEFAULT FALSE,
          ruview_event_id TEXT,
          ruview_camera_id TEXT,
          model_version TEXT,
          marked_by INTEGER,
          captured_at TIMESTAMPTZ,
          marked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          UNIQUE (session_id, student_code)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS student_face_profiles (
          id BIGSERIAL PRIMARY KEY,
          student_id INTEGER,
          student_code TEXT NOT NULL UNIQUE,
          ruview_person_id TEXT UNIQUE,
          consent_status TEXT NOT NULL DEFAULT 'pending',
          enrolled_by INTEGER,
          enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `);
    })();
  }
  return tablesReady;
}

function normalizeStatus(value: unknown, fallback: AttendanceStatus): AttendanceStatus | null {
  const status = typeof value === "string" ? value.toLowerCase() : fallback;
  return STATUSES.has(status as AttendanceStatus) ? (status as AttendanceStatus) : null;
}

function normalizeSource(value: unknown, fallback: AttendanceSource): AttendanceSource | null {
  const source = typeof value === "string" ? value.toLowerCase() : fallback;
  return SOURCES.has(source as AttendanceSource) ? (source as AttendanceSource) : null;
}

function confidenceToNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

async function getOrCreateSession(input: {
  classId: string;
  className?: string | null;
  sessionDate?: string | null;
  startedBy?: number | null;
  source?: AttendanceSource;
}) {
  const result = await pool.query(
    `INSERT INTO attendance_sessions (class_id, class_name, session_date, started_by, source)
     VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5)
     ON CONFLICT (class_id, session_date)
     DO UPDATE SET class_name = COALESCE(EXCLUDED.class_name, attendance_sessions.class_name)
     RETURNING *`,
    [input.classId, input.className ?? null, input.sessionDate ?? null, input.startedBy ?? null, input.source ?? "tablet"],
  );
  return result.rows[0];
}

async function upsertAttendanceRecord(input: {
  sessionId: number | string;
  studentId?: number | null;
  studentCode: string;
  studentName?: string | null;
  status: AttendanceStatus;
  source: AttendanceSource;
  confidenceScore?: number | null;
  needsReview?: boolean;
  ruviewEventId?: string | null;
  ruviewCameraId?: string | null;
  modelVersion?: string | null;
  markedBy?: number | null;
  capturedAt?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const result = await pool.query(
    `INSERT INTO attendance_records (
       session_id, student_id, student_code, student_name, status, source,
       confidence_score, needs_review, ruview_event_id, ruview_camera_id,
       model_version, marked_by, captured_at, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13::timestamptz, NOW()), $14::jsonb)
     ON CONFLICT (session_id, student_code)
     DO UPDATE SET
       student_id = COALESCE(EXCLUDED.student_id, attendance_records.student_id),
       student_name = COALESCE(EXCLUDED.student_name, attendance_records.student_name),
       status = EXCLUDED.status,
       source = EXCLUDED.source,
       confidence_score = EXCLUDED.confidence_score,
       needs_review = EXCLUDED.needs_review,
       ruview_event_id = COALESCE(EXCLUDED.ruview_event_id, attendance_records.ruview_event_id),
       ruview_camera_id = COALESCE(EXCLUDED.ruview_camera_id, attendance_records.ruview_camera_id),
       model_version = COALESCE(EXCLUDED.model_version, attendance_records.model_version),
       marked_by = EXCLUDED.marked_by,
       captured_at = EXCLUDED.captured_at,
       marked_at = NOW(),
       metadata = attendance_records.metadata || EXCLUDED.metadata
     RETURNING *`,
    [
      input.sessionId,
      input.studentId ?? null,
      input.studentCode,
      input.studentName ?? null,
      input.status,
      input.source,
      input.confidenceScore ?? null,
      input.needsReview ?? false,
      input.ruviewEventId ?? null,
      input.ruviewCameraId ?? null,
      input.modelVersion ?? null,
      input.markedBy ?? null,
      input.capturedAt ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return result.rows[0];
}

router.use("/v1/attendance", staffAuth);

router.post("/v1/attendance/session/start", async (req, res) => {
  await ensureAttendanceTables();
  const classId = String(req.body?.class_id ?? req.body?.classId ?? "").trim();
  if (!classId) {
    res.status(400).json({ error: "class_id is required" });
    return;
  }

  const session = await getOrCreateSession({
    classId,
    className: req.body?.class_name ?? req.body?.className ?? null,
    sessionDate: req.body?.session_date ?? req.body?.sessionDate ?? null,
    startedBy: req.auth?.user_id ?? null,
    source: "tablet",
  });

  res.status(201).json({ session });
});

router.post("/v1/attendance/scan", async (req, res) => {
  await ensureAttendanceTables();

  const classId = String(req.body?.class_id ?? req.body?.classId ?? "").trim();
  const studentCode = String(req.body?.student_code ?? req.body?.studentCode ?? "").trim();
  if (!classId || !studentCode) {
    res.status(400).json({ error: "class_id and student_code are required" });
    return;
  }

  const confidenceScore = confidenceToNumber(req.body?.confidence_score ?? req.body?.confidenceScore);
  const reviewThreshold = confidenceToNumber(req.body?.review_threshold ?? req.body?.reviewThreshold) ?? 0.8;
  const status = normalizeStatus(req.body?.status, "present");
  if (!status) {
    res.status(400).json({ error: "invalid attendance status" });
    return;
  }

  const session = await getOrCreateSession({
    classId,
    className: req.body?.class_name ?? req.body?.className ?? null,
    sessionDate: req.body?.session_date ?? req.body?.sessionDate ?? null,
    startedBy: req.auth?.user_id ?? null,
    source: "ruview",
  });

  const record = await upsertAttendanceRecord({
    sessionId: session.id,
    studentId: req.body?.student_id ?? req.body?.studentId ?? null,
    studentCode,
    studentName: req.body?.student_name ?? req.body?.studentName ?? null,
    status,
    source: "ruview",
    confidenceScore,
    needsReview: confidenceScore === null || confidenceScore < reviewThreshold,
    ruviewEventId: req.body?.ruview_event_id ?? req.body?.ruviewEventId ?? null,
    ruviewCameraId: req.body?.ruview_camera_id ?? req.body?.ruviewCameraId ?? null,
    modelVersion: req.body?.model_version ?? req.body?.modelVersion ?? null,
    markedBy: req.auth?.user_id ?? null,
    capturedAt: req.body?.captured_at ?? req.body?.capturedAt ?? null,
    metadata: {
      engine: "RuView",
      tablet_device_id: req.body?.tablet_device_id ?? req.body?.tabletDeviceId ?? null,
    },
  });

  res.status(201).json({ session, record });
});

router.post("/v1/attendance/mark", async (req, res) => {
  await ensureAttendanceTables();

  const classId = String(req.body?.class_id ?? req.body?.classId ?? "").trim();
  const studentCode = String(req.body?.student_code ?? req.body?.studentCode ?? "").trim();
  const status = normalizeStatus(req.body?.status, "present");
  const source = normalizeSource(req.body?.source, "manual");
  if (!classId || !studentCode || !status || !source) {
    res.status(400).json({ error: "class_id, student_code, valid status, and valid source are required" });
    return;
  }

  const session = await getOrCreateSession({
    classId,
    className: req.body?.class_name ?? req.body?.className ?? null,
    sessionDate: req.body?.session_date ?? req.body?.sessionDate ?? null,
    startedBy: req.auth?.user_id ?? null,
    source,
  });

  const record = await upsertAttendanceRecord({
    sessionId: session.id,
    studentId: req.body?.student_id ?? req.body?.studentId ?? null,
    studentCode,
    studentName: req.body?.student_name ?? req.body?.studentName ?? null,
    status,
    source,
    confidenceScore: confidenceToNumber(req.body?.confidence_score ?? req.body?.confidenceScore),
    needsReview: Boolean(req.body?.needs_review ?? req.body?.needsReview ?? false),
    ruviewEventId: req.body?.ruview_event_id ?? req.body?.ruviewEventId ?? null,
    ruviewCameraId: req.body?.ruview_camera_id ?? req.body?.ruviewCameraId ?? null,
    modelVersion: req.body?.model_version ?? req.body?.modelVersion ?? null,
    markedBy: req.auth?.user_id ?? null,
    capturedAt: req.body?.captured_at ?? req.body?.capturedAt ?? null,
    metadata: req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {},
  });

  res.status(201).json({ session, record });
});

router.get("/v1/attendance/class/:classId/today", async (req, res) => {
  await ensureAttendanceTables();
  const sessionDate = String(req.query["date"] ?? "").trim();
  const params = [req.params.classId, sessionDate || null];
  const result = await pool.query(
    `SELECT s.*, COALESCE(json_agg(r ORDER BY r.marked_at DESC) FILTER (WHERE r.id IS NOT NULL), '[]') AS records
     FROM attendance_sessions s
     LEFT JOIN attendance_records r ON r.session_id = s.id
     WHERE s.class_id = $1 AND s.session_date = COALESCE($2::date, CURRENT_DATE)
     GROUP BY s.id
     ORDER BY s.started_at DESC
     LIMIT 1`,
    params,
  );

  res.json({ session: result.rows[0] ?? null });
});

router.get("/v1/attendance/student/:studentCode/history", async (req, res) => {
  await ensureAttendanceTables();
  const limit = Math.min(Number(req.query["limit"] ?? 30) || 30, 100);
  const result = await pool.query(
    `SELECT r.*, s.class_id, s.class_name, s.session_date
     FROM attendance_records r
     INNER JOIN attendance_sessions s ON s.id = r.session_id
     WHERE r.student_code = $1
     ORDER BY s.session_date DESC, r.marked_at DESC
     LIMIT $2`,
    [req.params.studentCode, limit],
  );

  res.json({ records: result.rows });
});

router.post("/v1/attendance/face-profile", async (req, res) => {
  await ensureAttendanceTables();
  const studentCode = String(req.body?.student_code ?? req.body?.studentCode ?? "").trim();
  const ruviewPersonId = String(req.body?.ruview_person_id ?? req.body?.ruviewPersonId ?? "").trim();
  if (!studentCode || !ruviewPersonId) {
    res.status(400).json({ error: "student_code and ruview_person_id are required" });
    return;
  }

  const result = await pool.query(
    `INSERT INTO student_face_profiles (student_id, student_code, ruview_person_id, consent_status, enrolled_by, metadata)
     VALUES ($1, $2, $3, COALESCE($4, 'pending'), $5, $6::jsonb)
     ON CONFLICT (student_code)
     DO UPDATE SET
       ruview_person_id = EXCLUDED.ruview_person_id,
       consent_status = EXCLUDED.consent_status,
       updated_at = NOW(),
       metadata = student_face_profiles.metadata || EXCLUDED.metadata
     RETURNING *`,
    [
      req.body?.student_id ?? req.body?.studentId ?? null,
      studentCode,
      ruviewPersonId,
      req.body?.consent_status ?? req.body?.consentStatus ?? "pending",
      req.auth?.user_id ?? null,
      JSON.stringify(req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {}),
    ],
  );

  res.status(201).json({ profile: result.rows[0] });
});

export default router;
