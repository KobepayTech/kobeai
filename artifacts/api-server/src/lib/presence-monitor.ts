import { pool } from "@workspace/db";
import { logger } from "./logger";
import { enqueueVisionAnalysisSafe } from "./vision-queue";

const SCHOOL_TIMEZONE = process.env["SCHOOL_TIMEZONE"] ?? "Africa/Dar_es_Salaam";
const CHECKPOINT_INTERVAL_MINUTES = Math.max(
  5,
  Number(process.env["PRESENCE_CHECKPOINT_MINUTES"] ?? 30),
);
const EXPECTED_ZONE_LOOKBACK_MINUTES = Math.max(
  1,
  Number(process.env["PRESENCE_EXPECTED_ZONE_LOOKBACK_MINUTES"] ?? 10),
);
const CAMPUS_SEARCH_LOOKBACK_MINUTES = Math.max(
  EXPECTED_ZONE_LOOKBACK_MINUTES,
  Number(process.env["PRESENCE_CAMPUS_SEARCH_LOOKBACK_MINUTES"] ?? 30),
);
const MATCH_CONFIDENCE_THRESHOLD = Math.max(
  0,
  Math.min(1, Number(process.env["PRESENCE_MATCH_THRESHOLD"] ?? 0.86)),
);

export type PresenceResultStatus =
  | "on_schedule"
  | "wrong_location"
  | "not_seen"
  | "low_confidence"
  | "no_timetable"
  | "configuration_missing"
  // The expected zone exists in the timetable but we have no viable camera
  // evidence: either no enabled cameras cover it, or the cameras that do
  // cover it haven't produced any events (from anyone) in the lookback
  // window. The student is NOT at fault; the exception belongs to IT/ops.
  | "insufficient_camera_coverage";

export type PresenceEventInput = {
  studentCode: string;
  cameraId: string;
  confidence: number;
  capturedAt?: string | null;
  trackId?: string | null;
  modelVersion?: string | null;
  faceQuality?: number | null;
  metadata?: Record<string, unknown>;
};

type SchoolClock = {
  isoDay: number;
  minuteOfDay: number;
  localDate: string;
  localTime: string;
};

type CurrentPeriod = {
  period_id: number;
  class_id: number;
  class_name: string;
  subject: string;
  room: string | null;
};

type StudentRow = {
  student_id: number;
  student_code: string;
  student_name: string;
};

type ZoneRow = {
  id: number;
  code: string;
  name: string;
  zone_type: string;
  class_id: number | null;
  room: string | null;
};

type PresenceRow = {
  event_id: number;
  student_code: string;
  camera_id: string;
  zone_id: number | null;
  confidence: number;
  face_quality: number | null;
  captured_at: Date;
  model_version: string | null;
  zone_code: string | null;
  zone_name: string | null;
  zone_type: string | null;
};

let tablesReady: Promise<void> | null = null;
let schedulerStarted = false;
let schedulerTimer: NodeJS.Timeout | null = null;

function cleanText(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const valueTrimmed = value.trim();
  if (!valueTrimmed || valueTrimmed.length > max) return null;
  return valueTrimmed;
}

function normalizeSubject(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function schoolClock(at: Date): SchoolClock {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: SCHOOL_TIMEZONE,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekday = get("weekday");
  const isoDay =
    ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[weekday] ?? 1;
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return {
    isoDay,
    minuteOfDay: hour * 60 + minute,
    localDate: `${get("year")}-${get("month")}-${get("day")}`,
    localTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function defaultExpectedZoneType(subject: string, takesSubject: boolean, fallbackZoneType: string | null): string {
  if (!takesSubject) return fallbackZoneType || "library";
  const key = normalizeSubject(subject);
  if (/\b(lunch|breakfast|dinner|meal|dining|canteen)\b/.test(key)) return "dining";
  if (/\b(library|study|prep|private study|free period)\b/.test(key)) return "library";
  return "classroom";
}

export function ensurePresenceTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS campus_zones (
          id BIGSERIAL PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          zone_type TEXT NOT NULL CHECK (zone_type IN ('classroom', 'library', 'dining', 'office', 'corridor', 'outdoor', 'other')),
          class_id INTEGER,
          room TEXT,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS campus_cameras (
          camera_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          zone_id BIGINT REFERENCES campus_zones(id) ON DELETE SET NULL,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS student_subject_overrides (
          student_code TEXT NOT NULL,
          subject_key TEXT NOT NULL,
          subject_label TEXT NOT NULL,
          takes_subject BOOLEAN NOT NULL DEFAULT TRUE,
          fallback_zone_type TEXT NOT NULL DEFAULT 'library',
          notes TEXT,
          updated_by INTEGER,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (student_code, subject_key)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS student_presence_events (
          id BIGSERIAL PRIMARY KEY,
          student_code TEXT NOT NULL,
          camera_id TEXT NOT NULL REFERENCES campus_cameras(camera_id) ON DELETE RESTRICT,
          zone_id BIGINT REFERENCES campus_zones(id) ON DELETE SET NULL,
          confidence NUMERIC(6, 5) NOT NULL,
          face_quality NUMERIC(6, 5),
          track_id TEXT,
          model_version TEXT,
          captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS student_presence_events_student_time_idx
          ON student_presence_events (student_code, captured_at DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS student_presence_events_camera_time_idx
          ON student_presence_events (camera_id, captured_at DESC)
      `);

      // Continuous presence: one row per student, updated in place by
      // recordPresenceEvent. This is the fast-path source of truth for
      // "where is student X right now"; the 30-min presence_checkpoint_results
      // is the historical audit log. See docs/K9_ARCHITECTURE.md.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS current_student_presence (
          student_code TEXT PRIMARY KEY,
          camera_id TEXT NOT NULL,
          zone_id BIGINT REFERENCES campus_zones(id) ON DELETE SET NULL,
          zone_name TEXT,
          zone_type TEXT,
          confidence NUMERIC(6, 5) NOT NULL,
          face_quality NUMERIC(6, 5),
          model_version TEXT,
          -- Denormalised timetable expectation at last check-in, so the
          -- mismatch view can be filtered without re-joining timetable rows.
          expected_zone_id BIGINT REFERENCES campus_zones(id) ON DELETE SET NULL,
          expected_zone_type TEXT,
          mismatch_status TEXT NOT NULL DEFAULT 'unknown',
          seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS current_student_presence_seen_idx
          ON current_student_presence (seen_at DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS current_student_presence_mismatch_idx
          ON current_student_presence (mismatch_status)
          WHERE mismatch_status NOT IN ('on_schedule', 'unknown')
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS presence_checkpoints (
          id BIGSERIAL PRIMARY KEY,
          run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          school_date DATE NOT NULL,
          school_minute INTEGER NOT NULL,
          day_of_week INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT 'scheduler',
          started_by INTEGER,
          status TEXT NOT NULL DEFAULT 'running',
          summary JSONB NOT NULL DEFAULT '{}'::jsonb,
          completed_at TIMESTAMPTZ
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS presence_checkpoint_results (
          id BIGSERIAL PRIMARY KEY,
          checkpoint_id BIGINT NOT NULL REFERENCES presence_checkpoints(id) ON DELETE CASCADE,
          student_id INTEGER,
          student_code TEXT NOT NULL,
          student_name TEXT,
          class_id INTEGER,
          class_name TEXT,
          period_id INTEGER,
          subject TEXT,
          expected_zone_id BIGINT REFERENCES campus_zones(id) ON DELETE SET NULL,
          expected_zone_type TEXT,
          actual_zone_id BIGINT REFERENCES campus_zones(id) ON DELETE SET NULL,
          actual_camera_id TEXT,
          actual_seen_at TIMESTAMPTZ,
          confidence NUMERIC(6, 5),
          status TEXT NOT NULL CHECK (status IN ('on_schedule', 'wrong_location', 'not_seen', 'low_confidence', 'no_timetable', 'configuration_missing', 'insufficient_camera_coverage')),
          requires_review BOOLEAN NOT NULL DEFAULT FALSE,
          review_status TEXT NOT NULL DEFAULT 'open' CHECK (review_status IN ('open', 'confirmed', 'dismissed')),
          reviewed_by INTEGER,
          reviewed_at TIMESTAMPTZ,
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (checkpoint_id, student_code, period_id)
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS presence_checkpoint_results_review_idx
          ON presence_checkpoint_results (requires_review, review_status, created_at DESC)
      `);

      // Migration: earlier deploys had the status CHECK without
      // 'insufficient_camera_coverage'. Rebuild the constraint idempotently.
      await pool.query(`
        DO $$
        DECLARE
          conname TEXT;
        BEGIN
          SELECT c.conname INTO conname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname = 'presence_checkpoint_results'
            AND c.contype = 'c'
            AND pg_get_constraintdef(c.oid) LIKE '%status%'
            AND pg_get_constraintdef(c.oid) NOT LIKE '%insufficient_camera_coverage%';
          IF conname IS NOT NULL THEN
            EXECUTE format(
              'ALTER TABLE presence_checkpoint_results DROP CONSTRAINT %I',
              conname
            );
            ALTER TABLE presence_checkpoint_results
              ADD CONSTRAINT presence_checkpoint_results_status_check
              CHECK (status IN (
                'on_schedule', 'wrong_location', 'not_seen', 'low_confidence',
                'no_timetable', 'configuration_missing', 'insufficient_camera_coverage'
              ));
          END IF;
        END $$;
      `);
    })().catch((err) => {
      tablesReady = null;
      throw err;
    });
  }
  return tablesReady;
}

export async function recordPresenceEvent(input: PresenceEventInput) {
  await ensurePresenceTables();
  const studentCode = cleanText(input.studentCode, 100);
  const cameraId = cleanText(input.cameraId, 160);
  if (!studentCode || !cameraId) throw new Error("student_code_and_camera_id_required");
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error("confidence_must_be_between_0_and_1");
  }

  const camera = await pool.query(
    `SELECT c.camera_id, c.zone_id, c.enabled,
            z.name AS zone_name, z.zone_type
     FROM campus_cameras c
     LEFT JOIN campus_zones z ON z.id = c.zone_id
     WHERE c.camera_id = $1
     LIMIT 1`,
    [cameraId],
  );
  if (!camera.rows[0]) throw new Error("camera_not_registered");
  if (!camera.rows[0].enabled) throw new Error("camera_disabled");
  const cameraRow = camera.rows[0];

  // 1. Append-only event log (unchanged — audit + rollup source).
  const result = await pool.query(
    `INSERT INTO student_presence_events (
       student_code, camera_id, zone_id, confidence, face_quality, track_id,
       model_version, captured_at, metadata
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, NOW()), $9::jsonb
     ) RETURNING *`,
    [
      studentCode,
      cameraId,
      cameraRow.zone_id ?? null,
      input.confidence,
      input.faceQuality ?? null,
      cleanText(input.trackId, 160),
      cleanText(input.modelVersion, 160),
      input.capturedAt ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  // 2. Continuous-presence row (the fast-path source of truth). Best-effort:
  //    a failure to compute the live mismatch never breaks event ingestion.
  try {
    const live = await computeLiveMismatch(studentCode, cameraRow.zone_id ?? null, cameraRow.zone_type ?? null);
    // 3. If the live path found an anomaly (wrong_location), enqueue a
    //    scene-analysis request onto the intelligence path so a future
    //    Youtu-VL worker can enrich the event without blocking the fast
    //    path. Fire-and-forget — never throws.
    if (live.status === "wrong_location") {
      enqueueVisionAnalysisSafe({
        cameraId,
        studentCode,
        question: `A student appears in ${cameraRow.zone_name ?? cameraRow.zone_type ?? "an unexpected zone"} but their timetable expects ${live.expectedZoneType}. Describe what the student appears to be doing.`,
        reason: "auto:live_mismatch",
        priority: 4,
        context: {
          actual_zone_id: cameraRow.zone_id,
          actual_zone_type: cameraRow.zone_type,
          expected_zone_id: live.expectedZoneId,
          expected_zone_type: live.expectedZoneType,
          confidence: input.confidence,
        },
      });
    }
    await pool.query(
      `INSERT INTO current_student_presence (
         student_code, camera_id, zone_id, zone_name, zone_type,
         confidence, face_quality, model_version,
         expected_zone_id, expected_zone_type, mismatch_status,
         seen_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 COALESCE($12::timestamptz, NOW()), NOW())
       ON CONFLICT (student_code) DO UPDATE SET
         camera_id = EXCLUDED.camera_id,
         zone_id = EXCLUDED.zone_id,
         zone_name = EXCLUDED.zone_name,
         zone_type = EXCLUDED.zone_type,
         confidence = EXCLUDED.confidence,
         face_quality = EXCLUDED.face_quality,
         model_version = EXCLUDED.model_version,
         expected_zone_id = EXCLUDED.expected_zone_id,
         expected_zone_type = EXCLUDED.expected_zone_type,
         mismatch_status = EXCLUDED.mismatch_status,
         seen_at = EXCLUDED.seen_at,
         updated_at = NOW()`,
      [
        studentCode,
        cameraId,
        cameraRow.zone_id ?? null,
        cameraRow.zone_name ?? null,
        cameraRow.zone_type ?? null,
        input.confidence,
        input.faceQuality ?? null,
        cleanText(input.modelVersion, 160),
        live.expectedZoneId,
        live.expectedZoneType,
        live.status,
        input.capturedAt ?? null,
      ],
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), studentCode },
      "current_student_presence upsert skipped",
    );
  }

  return result.rows[0];
}

/**
 * Compare where the student was just seen against where the timetable says
 * they should be, without going through the full 30-min reconciliation.
 * Returns the mismatch status stored on current_student_presence so
 * /v1/presence/live/mismatches can serve the fast-path teacher dashboard.
 */
async function computeLiveMismatch(
  studentCode: string,
  actualZoneId: number | null,
  actualZoneType: string | null,
): Promise<{
  status:
    | "on_schedule"
    | "wrong_location"
    | "no_timetable"
    | "configuration_missing"
    | "unknown";
  expectedZoneId: number | null;
  expectedZoneType: string | null;
}> {
  const clock = schoolClock(new Date());
  const periodRows = await pool.query(
    `SELECT tp.id AS period_id, tp.class_id, tp.subject, tp.room
     FROM timetable_periods tp
     INNER JOIN class_memberships cm ON cm.class_id = tp.class_id
     INNER JOIN users u ON u.id = cm.student_id
     WHERE u.student_code = $1
       AND tp.day_of_week = $2
       AND tp.start_minute <= $3
       AND tp.end_minute > $3
     ORDER BY tp.start_minute
     LIMIT 1`,
    [studentCode, clock.isoDay, clock.minuteOfDay],
  );
  const period = periodRows.rows[0];
  if (!period) {
    return { status: "no_timetable", expectedZoneId: null, expectedZoneType: null };
  }
  const rule = await subjectRule(studentCode, period.subject);
  const expectedType = defaultExpectedZoneType(
    period.subject,
    rule.takesSubject,
    rule.fallbackZoneType,
  );
  const expected = await expectedZone(
    { period_id: period.period_id, class_id: period.class_id, class_name: "", subject: period.subject, room: period.room },
    expectedType,
  );
  if (!expected) {
    return {
      status: "configuration_missing",
      expectedZoneId: null,
      expectedZoneType: expectedType,
    };
  }
  if (actualZoneId && actualZoneId === expected.id) {
    return {
      status: "on_schedule",
      expectedZoneId: expected.id,
      expectedZoneType: expectedType,
    };
  }
  if (!actualZoneId && actualZoneType === expectedType) {
    // Generic-type zone hit (e.g. "library" period, seen at a library camera).
    return {
      status: "on_schedule",
      expectedZoneId: expected.id,
      expectedZoneType: expectedType,
    };
  }
  return {
    status: "wrong_location",
    expectedZoneId: expected.id,
    expectedZoneType: expectedType,
  };
}

async function currentPeriods(clock: SchoolClock): Promise<CurrentPeriod[]> {
  const rows = await pool.query(
    `SELECT
       tp.id AS period_id,
       tp.class_id,
       c.name AS class_name,
       tp.subject,
       tp.room
     FROM timetable_periods tp
     INNER JOIN classes c ON c.id = tp.class_id
     WHERE tp.day_of_week = $1
       AND tp.start_minute <= $2
       AND tp.end_minute > $2
     ORDER BY tp.class_id, tp.start_minute`,
    [clock.isoDay, clock.minuteOfDay],
  );
  return rows.rows as CurrentPeriod[];
}

async function studentsForClass(classId: number): Promise<StudentRow[]> {
  const rows = await pool.query(
    `SELECT u.id AS student_id, u.student_code, u.name AS student_name
     FROM class_memberships cm
     INNER JOIN users u ON u.id = cm.student_id
     WHERE cm.class_id = $1
       AND u.role = 'student'
       AND u.student_code IS NOT NULL
     ORDER BY u.name`,
    [classId],
  );
  return rows.rows as StudentRow[];
}

async function subjectRule(studentCode: string, subject: string) {
  const subjectKey = normalizeSubject(subject);
  const rows = await pool.query(
    `SELECT takes_subject, fallback_zone_type
     FROM student_subject_overrides
     WHERE student_code = $1 AND subject_key = $2
     LIMIT 1`,
    [studentCode, subjectKey],
  );
  return {
    takesSubject: rows.rows[0]?.takes_subject !== false,
    fallbackZoneType: rows.rows[0]?.fallback_zone_type ?? null,
  };
}

async function expectedZone(period: CurrentPeriod, expectedZoneType: string): Promise<ZoneRow | null> {
  if (expectedZoneType === "classroom") {
    const exact = await pool.query(
      `SELECT id, code, name, zone_type, class_id, room
       FROM campus_zones
       WHERE active = TRUE
         AND zone_type = 'classroom'
         AND (
           ($1::text IS NOT NULL AND room IS NOT NULL AND LOWER(room) = LOWER($1))
           OR class_id = $2
         )
       ORDER BY CASE WHEN $1::text IS NOT NULL AND room IS NOT NULL AND LOWER(room) = LOWER($1) THEN 0 ELSE 1 END, id
       LIMIT 1`,
      [period.room, period.class_id],
    );
    return (exact.rows[0] as ZoneRow | undefined) ?? null;
  }

  const generic = await pool.query(
    `SELECT id, code, name, zone_type, class_id, room
     FROM campus_zones
     WHERE active = TRUE AND zone_type = $1
     ORDER BY id
     LIMIT 1`,
    [expectedZoneType],
  );
  return (generic.rows[0] as ZoneRow | undefined) ?? null;
}

async function latestPresence(studentCode: string, lookbackMinutes: number): Promise<PresenceRow | null> {
  const rows = await pool.query(
    `SELECT
       e.id AS event_id,
       e.student_code,
       e.camera_id,
       e.zone_id,
       e.confidence::float8 AS confidence,
       e.face_quality::float8 AS face_quality,
       e.captured_at,
       e.model_version,
       z.code AS zone_code,
       z.name AS zone_name,
       z.zone_type
     FROM student_presence_events e
     LEFT JOIN campus_zones z ON z.id = e.zone_id
     WHERE e.student_code = $1
       AND e.captured_at >= NOW() - ($2::text || ' minutes')::interval
     ORDER BY e.captured_at DESC
     LIMIT 1`,
    [studentCode, lookbackMinutes],
  );
  return (rows.rows[0] as PresenceRow | undefined) ?? null;
}

type ZoneCoverage = {
  enabledCameraCount: number;
  /** Enabled cameras that produced ANY event (any student) inside the lookback. */
  activeCameraCount: number;
};

/**
 * Ask whether the expected zone actually has viable camera coverage right now.
 * We say a zone has coverage when at least one enabled camera assigned to it
 * has produced any student-presence event within the campus search window.
 * If nothing at all was captured, we assume the stream is offline / mis-plugged
 * / camera broken, and refuse to blame the student.
 */
async function zoneCoverage(zone: ZoneRow | null, lookbackMinutes: number): Promise<ZoneCoverage> {
  if (!zone) return { enabledCameraCount: 0, activeCameraCount: 0 };
  const rows = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE c.enabled)::int AS enabled_count,
       COUNT(DISTINCT recent.camera_id)::int AS active_count
     FROM campus_cameras c
     LEFT JOIN (
       SELECT DISTINCT camera_id
       FROM student_presence_events
       WHERE captured_at >= NOW() - ($2::text || ' minutes')::interval
     ) recent ON recent.camera_id = c.camera_id AND c.enabled
     WHERE c.zone_id = $1`,
    [zone.id, lookbackMinutes],
  );
  const row = rows.rows[0] ?? {};
  return {
    enabledCameraCount: Number(row.enabled_count ?? 0),
    activeCameraCount: Number(row.active_count ?? 0),
  };
}

async function latestPresenceInExpectedZone(
  studentCode: string,
  expectedZoneType: string,
  expectedZoneId: number | null,
): Promise<PresenceRow | null> {
  const rows = await pool.query(
    `SELECT
       e.id AS event_id,
       e.student_code,
       e.camera_id,
       e.zone_id,
       e.confidence::float8 AS confidence,
       e.face_quality::float8 AS face_quality,
       e.captured_at,
       e.model_version,
       z.code AS zone_code,
       z.name AS zone_name,
       z.zone_type
     FROM student_presence_events e
     LEFT JOIN campus_zones z ON z.id = e.zone_id
     WHERE e.student_code = $1
       AND e.captured_at >= NOW() - ($2::text || ' minutes')::interval
       AND (
         ($3::bigint IS NOT NULL AND e.zone_id = $3)
         OR ($3::bigint IS NULL AND z.zone_type = $4)
       )
     ORDER BY e.captured_at DESC
     LIMIT 1`,
    [studentCode, EXPECTED_ZONE_LOOKBACK_MINUTES, expectedZoneId, expectedZoneType],
  );
  return (rows.rows[0] as PresenceRow | undefined) ?? null;
}

function classifyPresence(args: {
  expectedZoneType: string;
  expectedZone: ZoneRow | null;
  expectedZoneCoverage: ZoneCoverage;
  expectedHit: PresenceRow | null;
  campusHit: PresenceRow | null;
}): {
  status: PresenceResultStatus;
  requiresReview: boolean;
  actual: PresenceRow | null;
  reason: string;
} {
  if (args.expectedHit) {
    if (args.expectedHit.confidence < MATCH_CONFIDENCE_THRESHOLD) {
      return {
        status: "low_confidence",
        requiresReview: true,
        actual: args.expectedHit,
        reason: "Student was seen in the expected zone but the face match was below the configured confidence threshold.",
      };
    }
    return {
      status: "on_schedule",
      requiresReview: false,
      actual: args.expectedHit,
      reason: "Student was seen in the timetable-expected zone during the checkpoint evidence window.",
    };
  }

  if (!args.campusHit) {
    // Before we blame the student, verify the expected zone actually has a
    // working camera. If not, this is a coverage exception (IT problem), not
    // a "student is missing" exception.
    if (args.expectedZone) {
      if (args.expectedZoneCoverage.enabledCameraCount === 0) {
        return {
          status: "insufficient_camera_coverage",
          requiresReview: true,
          actual: null,
          reason: `Expected zone ${args.expectedZone.name} has no enabled camera assigned; the student can't be checked in automatically.`,
        };
      }
      if (args.expectedZoneCoverage.activeCameraCount === 0) {
        return {
          status: "insufficient_camera_coverage",
          requiresReview: true,
          actual: null,
          reason: `Expected zone ${args.expectedZone.name} has enabled cameras but none of them produced any events during the lookback window; the stream is likely down.`,
        };
      }
    }
    return {
      status: "not_seen",
      requiresReview: true,
      actual: null,
      reason: "Student was not found in the expected zone, so the monitor searched recent events from all registered campus cameras and found no match.",
    };
  }

  if (args.campusHit.confidence < MATCH_CONFIDENCE_THRESHOLD) {
    return {
      status: "low_confidence",
      requiresReview: true,
      actual: args.campusHit,
      reason: "The all-campus camera search found a possible match, but confidence is too low for an automatic attendance decision.",
    };
  }

  if (!args.expectedZone && !args.campusHit.zone_type) {
    return {
      status: "configuration_missing",
      requiresReview: true,
      actual: args.campusHit,
      reason: "The face was recognized, but the camera or timetable room is not mapped to a campus zone.",
    };
  }

  return {
    status: "wrong_location",
    requiresReview: true,
    actual: args.campusHit,
    reason: `Student was found by the all-campus camera search in ${args.campusHit.zone_name ?? args.campusHit.zone_type ?? "another zone"}, not the expected ${args.expectedZone?.name ?? args.expectedZoneType}.`,
  };
}

export async function runPresenceCheckpoint(options?: {
  source?: "scheduler" | "manual" | "startup";
  startedBy?: number | null;
  at?: Date;
}) {
  await ensurePresenceTables();
  const at = options?.at ?? new Date();
  const clock = schoolClock(at);
  const checkpointResult = await pool.query(
    `INSERT INTO presence_checkpoints (
       run_at, school_date, school_minute, day_of_week, source, started_by, status
     ) VALUES ($1, $2::date, $3, $4, $5, $6, 'running') RETURNING *`,
    [
      at.toISOString(),
      clock.localDate,
      clock.minuteOfDay,
      clock.isoDay,
      options?.source ?? "scheduler",
      options?.startedBy ?? null,
    ],
  );
  const checkpoint = checkpointResult.rows[0];

  let total = 0;
  let onSchedule = 0;
  let flagged = 0;
  let notSeen = 0;

  try {
    const periods = await currentPeriods(clock);
    if (periods.length === 0) {
      const summary = {
        total_students_checked: 0,
        on_schedule: 0,
        flagged: 0,
        not_seen: 0,
        active_periods: 0,
        timezone: SCHOOL_TIMEZONE,
        note: "No active timetable periods at this checkpoint.",
      };
      await pool.query(
        `UPDATE presence_checkpoints
         SET status = 'completed', summary = $2::jsonb, completed_at = NOW()
         WHERE id = $1`,
        [checkpoint.id, JSON.stringify(summary)],
      );
      return { checkpoint: { ...checkpoint, summary, status: "completed" }, results: [] };
    }

    const results: unknown[] = [];
    // Coverage is per-zone, not per-student — cache within a checkpoint so
    // 40 students in the same classroom share one COUNT query.
    const coverageCache = new Map<number, ZoneCoverage>();
    const NO_COVERAGE: ZoneCoverage = { enabledCameraCount: 0, activeCameraCount: 0 };
    let coverageIssues = 0;

    for (const period of periods) {
      const students = await studentsForClass(period.class_id);
      for (const student of students) {
        total += 1;
        const rule = await subjectRule(student.student_code, period.subject);
        const expectedZoneType = defaultExpectedZoneType(
          period.subject,
          rule.takesSubject,
          rule.fallbackZoneType,
        );
        const expected = await expectedZone(period, expectedZoneType);
        let coverage = NO_COVERAGE;
        if (expected) {
          const cached = coverageCache.get(expected.id);
          if (cached) {
            coverage = cached;
          } else {
            coverage = await zoneCoverage(expected, CAMPUS_SEARCH_LOOKBACK_MINUTES);
            coverageCache.set(expected.id, coverage);
          }
        }
        const expectedHit = await latestPresenceInExpectedZone(
          student.student_code,
          expectedZoneType,
          expected?.id ?? null,
        );
        const campusHit = expectedHit ?? (await latestPresence(student.student_code, CAMPUS_SEARCH_LOOKBACK_MINUTES));
        const classification = classifyPresence({
          expectedZoneType,
          expectedZone: expected,
          expectedZoneCoverage: coverage,
          expectedHit,
          campusHit,
        });

        if (classification.status === "on_schedule") onSchedule += 1;
        if (classification.requiresReview) flagged += 1;
        if (classification.status === "not_seen") notSeen += 1;
        if (classification.status === "insufficient_camera_coverage") coverageIssues += 1;

        const inserted = await pool.query(
          `INSERT INTO presence_checkpoint_results (
             checkpoint_id, student_id, student_code, student_name,
             class_id, class_name, period_id, subject,
             expected_zone_id, expected_zone_type,
             actual_zone_id, actual_camera_id, actual_seen_at, confidence,
             status, requires_review, details
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8,
             $9, $10, $11, $12, $13, $14,
             $15, $16, $17::jsonb
           )
           ON CONFLICT (checkpoint_id, student_code, period_id)
           DO UPDATE SET
             actual_zone_id = EXCLUDED.actual_zone_id,
             actual_camera_id = EXCLUDED.actual_camera_id,
             actual_seen_at = EXCLUDED.actual_seen_at,
             confidence = EXCLUDED.confidence,
             status = EXCLUDED.status,
             requires_review = EXCLUDED.requires_review,
             details = EXCLUDED.details
           RETURNING *`,
          [
            checkpoint.id,
            student.student_id,
            student.student_code,
            student.student_name,
            period.class_id,
            period.class_name,
            period.period_id,
            period.subject,
            expected?.id ?? null,
            expectedZoneType,
            classification.actual?.zone_id ?? null,
            classification.actual?.camera_id ?? null,
            classification.actual?.captured_at ?? null,
            classification.actual?.confidence ?? null,
            classification.status,
            classification.requiresReview,
            JSON.stringify({
              reason: classification.reason,
              takes_subject: rule.takesSubject,
              timetable_room: period.room,
              expected_zone_name: expected?.name ?? null,
              expected_zone_code: expected?.code ?? null,
              actual_zone_name: classification.actual?.zone_name ?? null,
              actual_zone_code: classification.actual?.zone_code ?? null,
              campus_search_performed: !expectedHit,
              campus_search_lookback_minutes: CAMPUS_SEARCH_LOOKBACK_MINUTES,
              expected_zone_lookback_minutes: EXPECTED_ZONE_LOOKBACK_MINUTES,
              model_version: classification.actual?.model_version ?? null,
              automated_action: "flag_for_human_review_only",
            }),
          ],
        );
        results.push(inserted.rows[0]);
      }
    }

    const summary = {
      total_students_checked: total,
      on_schedule: onSchedule,
      flagged,
      not_seen: notSeen,
      camera_coverage_issues: coverageIssues,
      active_periods: periods.length,
      timezone: SCHOOL_TIMEZONE,
      checkpoint_interval_minutes: CHECKPOINT_INTERVAL_MINUTES,
      match_threshold: MATCH_CONFIDENCE_THRESHOLD,
    };
    await pool.query(
      `UPDATE presence_checkpoints
       SET status = 'completed', summary = $2::jsonb, completed_at = NOW()
       WHERE id = $1`,
      [checkpoint.id, JSON.stringify(summary)],
    );
    return { checkpoint: { ...checkpoint, summary, status: "completed" }, results };
  } catch (err) {
    await pool.query(
      `UPDATE presence_checkpoints
       SET status = 'failed', summary = $2::jsonb, completed_at = NOW()
       WHERE id = $1`,
      [
        checkpoint.id,
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      ],
    ).catch(() => undefined);
    throw err;
  }
}

function millisecondsUntilNextBoundary(intervalMinutes: number): number {
  const intervalMs = intervalMinutes * 60_000;
  const now = Date.now();
  const next = Math.ceil(now / intervalMs) * intervalMs;
  return Math.max(1_000, next - now);
}

export function startPresenceMonitor(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  ensurePresenceTables().catch((err) =>
    logger.error({ err }, "presence tables initialization failed"),
  );

  const scheduleNext = () => {
    const delay = millisecondsUntilNextBoundary(CHECKPOINT_INTERVAL_MINUTES);
    schedulerTimer = setTimeout(async () => {
      try {
        const outcome = await runPresenceCheckpoint({ source: "scheduler" });
        logger.info(
          { checkpoint_id: outcome.checkpoint.id, summary: outcome.checkpoint.summary },
          "presence checkpoint completed",
        );
      } catch (err) {
        logger.error({ err }, "presence checkpoint failed");
      } finally {
        scheduleNext();
      }
    }, delay);
    schedulerTimer.unref();
  };

  scheduleNext();
  logger.info(
    {
      checkpoint_interval_minutes: CHECKPOINT_INTERVAL_MINUTES,
      school_timezone: SCHOOL_TIMEZONE,
    },
    "presence monitor scheduled",
  );
}

export function stopPresenceMonitor(): void {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = null;
  schedulerStarted = false;
}

export const presenceConfig = {
  schoolTimezone: SCHOOL_TIMEZONE,
  checkpointIntervalMinutes: CHECKPOINT_INTERVAL_MINUTES,
  expectedZoneLookbackMinutes: EXPECTED_ZONE_LOOKBACK_MINUTES,
  campusSearchLookbackMinutes: CAMPUS_SEARCH_LOOKBACK_MINUTES,
  matchConfidenceThreshold: MATCH_CONFIDENCE_THRESHOLD,
};
