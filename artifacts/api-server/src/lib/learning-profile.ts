import { pool } from "@workspace/db";
import { logger } from "./logger";
import { presenceConfig } from "./presence-monitor";

const ATTENDANCE_LOOKBACK_DAYS = Math.max(
  1,
  Number(process.env["LEARNING_PROFILE_ATTENDANCE_DAYS"] ?? 30),
);
const STRONG_THRESHOLD = 80;
const WEAK_THRESHOLD = 60;
const MIN_ATTEMPTS_FOR_TOPIC = 2;
const ROLLUP_INTERVAL_MS =
  Math.max(1, Number(process.env["LEARNING_PROFILE_ROLLUP_HOURS"] ?? 24)) * 60 * 60 * 1000;

let tablesReady: Promise<void> | null = null;
let schedulerStarted = false;
let schedulerTimer: NodeJS.Timeout | null = null;

export type LearningProfileMerged = {
  student_code: string;
  student_name: string | null;
  birthday: string | null;
  topics_strong: string[];
  topics_weak: string[];
  questions_asked_count: number;
  achievements: string[];
  attendance_rate: number | null;
  override_notes: string | null;
  computed_at: string | null;
  updated_at: string | null;
};

/**
 * Idempotent schema ensure for the learning profile. Runs the same pattern
 * as ensurePresenceTables: CREATE IF NOT EXISTS + additive migrations, so
 * an existing install can just redeploy.
 */
export function ensureLearningProfileTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS student_learning_profile (
          student_code TEXT PRIMARY KEY,
          student_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          birthday TEXT,
          computed_topics_strong JSONB NOT NULL DEFAULT '[]'::jsonb,
          computed_topics_weak JSONB NOT NULL DEFAULT '[]'::jsonb,
          computed_questions_asked_count INTEGER NOT NULL DEFAULT 0,
          computed_achievements JSONB NOT NULL DEFAULT '[]'::jsonb,
          computed_attendance_rate INTEGER,
          override_topics_strong JSONB,
          override_topics_weak JSONB,
          override_achievements JSONB,
          override_notes TEXT,
          updated_by INTEGER,
          computed_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    })().catch((err) => {
      tablesReady = null;
      throw err;
    });
  }
  return tablesReady;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
}

function mergeArrays(override: unknown, computed: unknown): string[] {
  if (Array.isArray(override)) return coerceStringArray(override);
  return coerceStringArray(computed);
}

export function mergeProfile(row: Record<string, unknown>): LearningProfileMerged {
  const rate = row["computed_attendance_rate"];
  return {
    student_code: String(row["student_code"] ?? ""),
    student_name: (row["student_name"] as string) ?? null,
    birthday: (row["birthday"] as string) ?? null,
    topics_strong: mergeArrays(row["override_topics_strong"], row["computed_topics_strong"]),
    topics_weak: mergeArrays(row["override_topics_weak"], row["computed_topics_weak"]),
    questions_asked_count: Number(row["computed_questions_asked_count"] ?? 0),
    achievements: mergeArrays(row["override_achievements"], row["computed_achievements"]),
    attendance_rate: rate == null ? null : Number(rate),
    override_notes: (row["override_notes"] as string) ?? null,
    computed_at: row["computed_at"] ? new Date(row["computed_at"] as string).toISOString() : null,
    updated_at: row["updated_at"] ? new Date(row["updated_at"] as string).toISOString() : null,
  };
}

/**
 * Roll up all learning-profile signals for one student and upsert into
 * student_learning_profile. Called by the nightly scheduler and by the
 * manual /rollup admin endpoint. Never touches override_* fields.
 */
export async function rollupStudent(studentCode: string): Promise<LearningProfileMerged | null> {
  await ensureLearningProfileTables();
  const student = await pool.query(
    `SELECT id, name FROM users WHERE role = 'student' AND student_code = $1 LIMIT 1`,
    [studentCode],
  );
  if (!student.rows[0]) return null;
  const userId: number = student.rows[0].id;

  // 1. Topics strong / weak: bucket by quiz.subject, average score, apply
  //    min-attempts and thresholds.
  const subjectAvg = await pool.query(
    `SELECT q.subject,
            AVG(a.score)::float8 AS avg_score,
            COUNT(*)::int AS attempts
     FROM quiz_attempts a
     INNER JOIN quizzes q ON q.id = a.quiz_id
     WHERE a.student_code = $1
     GROUP BY q.subject
     HAVING COUNT(*) >= $2`,
    [studentCode, MIN_ATTEMPTS_FOR_TOPIC],
  );
  const topicsStrong: string[] = [];
  const topicsWeak: string[] = [];
  for (const row of subjectAvg.rows) {
    const avg: number = row.avg_score;
    if (avg >= STRONG_THRESHOLD) topicsStrong.push(row.subject);
    else if (avg < WEAK_THRESHOLD) topicsWeak.push(row.subject);
  }
  topicsStrong.sort();
  topicsWeak.sort();

  // 2. Achievements: any quiz attempt scoring >= 90 becomes an achievement
  //    line "Quiz: {title} — {score}%". Keep the most recent 5.
  const wins = await pool.query(
    `SELECT q.title, a.score, a.created_at
     FROM quiz_attempts a
     INNER JOIN quizzes q ON q.id = a.quiz_id
     WHERE a.student_code = $1 AND a.score >= 90
     ORDER BY a.created_at DESC
     LIMIT 5`,
    [studentCode],
  );
  const achievements: string[] = wins.rows.map(
    (r) => `${r.title} — ${r.score}%`,
  );

  // 3. Questions asked count: /v1/watch/ask calls aren't persisted anywhere
  //    with student attribution today. Leave as 0 until that surface lands.
  const questionsAsked = 0;

  // 4. Attendance rate: last N days of presence_checkpoint_results, treating
  //    on_schedule / low_confidence / wrong_location (student was seen
  //    somewhere) as "seen", and not_seen as "missing". Camera coverage
  //    issues aren't counted either way — they're IT problems.
  let attendanceRate: number | null = null;
  try {
    const attn = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE r.status IN ('on_schedule', 'low_confidence', 'wrong_location'))::int AS seen,
         COUNT(*) FILTER (WHERE r.status = 'not_seen')::int AS missing
       FROM presence_checkpoint_results r
       INNER JOIN presence_checkpoints cp ON cp.id = r.checkpoint_id
       WHERE r.student_code = $1
         AND cp.school_date >= (NOW() AT TIME ZONE $2)::date - ($3::text || ' days')::interval`,
      [studentCode, presenceConfig.schoolTimezone, ATTENDANCE_LOOKBACK_DAYS],
    );
    const seen: number = attn.rows[0]?.seen ?? 0;
    const missing: number = attn.rows[0]?.missing ?? 0;
    const denom = seen + missing;
    if (denom > 0) attendanceRate = Math.round((seen / denom) * 100);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), studentCode },
      "learning-profile: attendance rate skipped (presence tables not initialized yet)",
    );
  }

  // Upsert without touching any override_* fields.
  const result = await pool.query(
    `INSERT INTO student_learning_profile (
       student_code, student_user_id,
       computed_topics_strong, computed_topics_weak,
       computed_questions_asked_count, computed_achievements,
       computed_attendance_rate, computed_at, updated_at
     ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7, NOW(), NOW())
     ON CONFLICT (student_code) DO UPDATE SET
       student_user_id = EXCLUDED.student_user_id,
       computed_topics_strong = EXCLUDED.computed_topics_strong,
       computed_topics_weak = EXCLUDED.computed_topics_weak,
       computed_questions_asked_count = EXCLUDED.computed_questions_asked_count,
       computed_achievements = EXCLUDED.computed_achievements,
       computed_attendance_rate = EXCLUDED.computed_attendance_rate,
       computed_at = NOW(),
       updated_at = NOW()
     RETURNING *`,
    [
      studentCode,
      userId,
      JSON.stringify(topicsStrong),
      JSON.stringify(topicsWeak),
      questionsAsked,
      JSON.stringify(achievements),
      attendanceRate,
    ],
  );
  return mergeProfile({ ...result.rows[0], student_name: student.rows[0].name });
}

export async function rollupAllStudents(): Promise<{ rolled_up: number; failed: number }> {
  await ensureLearningProfileTables();
  const students = await pool.query(
    `SELECT student_code FROM users WHERE role = 'student' AND student_code IS NOT NULL`,
  );
  let rolledUp = 0;
  let failed = 0;
  for (const row of students.rows) {
    try {
      await rollupStudent(row.student_code);
      rolledUp += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        { err: err instanceof Error ? err.message : String(err), studentCode: row.student_code },
        "learning-profile rollup failed for student",
      );
    }
  }
  return { rolled_up: rolledUp, failed };
}

/**
 * Fetch the merged view for one student. If the row doesn't exist yet, we
 * run a rollup on-demand so first-time views aren't empty.
 */
export async function getMergedProfile(studentCode: string): Promise<LearningProfileMerged | null> {
  await ensureLearningProfileTables();
  const rows = await pool.query(
    `SELECT lp.*, u.name AS student_name
     FROM student_learning_profile lp
     LEFT JOIN users u ON u.student_code = lp.student_code
     WHERE lp.student_code = $1
     LIMIT 1`,
    [studentCode],
  );
  if (rows.rows[0]) return mergeProfile(rows.rows[0]);
  return await rollupStudent(studentCode);
}

/** Nightly scheduler. Anchors to the next `intervalHours` boundary from now. */
export function startLearningProfileScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  ensureLearningProfileTables()
    .then(() => ensureBirthdayCelebrationsTable())
    // Seed today's birthday celebrations at startup so a server that came
    // up after midnight still surfaces them without waiting for the timer.
    .then(() => ensureTodaysBirthdayCelebrations())
    .catch((err) => logger.error({ err }, "learning-profile init failed"));

  const scheduleNext = () => {
    schedulerTimer = setTimeout(async () => {
      try {
        const outcome = await rollupAllStudents();
        logger.info(outcome, "learning-profile nightly rollup completed");
      } catch (err) {
        logger.error({ err }, "learning-profile nightly rollup failed");
      }
      try {
        const seeded = await ensureTodaysBirthdayCelebrations();
        logger.info({ seeded }, "birthday celebrations seeded");
      } catch (err) {
        logger.error({ err }, "birthday celebrations seed failed");
      }
      scheduleNext();
    }, ROLLUP_INTERVAL_MS);
    schedulerTimer.unref();
  };

  scheduleNext();
  logger.info(
    { rollup_interval_hours: ROLLUP_INTERVAL_MS / 3_600_000 },
    "learning-profile scheduler started",
  );
}

export function stopLearningProfileScheduler(): void {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = null;
  schedulerStarted = false;
}

/**
 * Return a list of students whose birthday matches today's month/day in the
 * school timezone. Used by the K9 birthday notification path.
 */
export async function studentsWithBirthdayToday(): Promise<
  Array<{ student_code: string; student_name: string; birthday: string }>
> {
  await ensureLearningProfileTables();
  const rows = await pool.query(
    `SELECT lp.student_code, lp.birthday, u.name AS student_name
     FROM student_learning_profile lp
     INNER JOIN users u ON u.student_code = lp.student_code
     WHERE lp.birthday IS NOT NULL
       AND lp.birthday = TO_CHAR((NOW() AT TIME ZONE $1)::date, 'MM-DD')`,
    [presenceConfig.schoolTimezone],
  );
  return rows.rows.map((r) => ({
    student_code: r.student_code,
    student_name: r.student_name,
    birthday: r.birthday,
  }));
}

// ---------------------------------------------------------------------------
// Birthday celebrations lifecycle
// ---------------------------------------------------------------------------

let celebrationsReady: Promise<void> | null = null;

export function ensureBirthdayCelebrationsTable(): Promise<void> {
  if (!celebrationsReady) {
    celebrationsReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS birthday_celebrations (
          id BIGSERIAL PRIMARY KEY,
          student_code TEXT NOT NULL,
          celebration_date TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          approved_at TIMESTAMPTZ,
          played_at TIMESTAMPTZ,
          played_by_kiosk TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS birthday_celebrations_student_date_uk
          ON birthday_celebrations (student_code, celebration_date)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS birthday_celebrations_date_idx
          ON birthday_celebrations (celebration_date)
      `);
    })().catch((err) => {
      celebrationsReady = null;
      throw err;
    });
  }
  return celebrationsReady;
}

async function schoolToday(): Promise<string> {
  const row = await pool.query(
    `SELECT TO_CHAR((NOW() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`,
    [presenceConfig.schoolTimezone],
  );
  return row.rows[0].d as string;
}

/**
 * Seed pending birthday_celebration rows for every student whose birthday
 * matches today. Idempotent (unique on student_code + celebration_date).
 */
export async function ensureTodaysBirthdayCelebrations(): Promise<number> {
  await ensureLearningProfileTables();
  await ensureBirthdayCelebrationsTable();
  const today = await schoolToday();
  const birthdays = await studentsWithBirthdayToday();
  let inserted = 0;
  for (const b of birthdays) {
    const result = await pool.query(
      `INSERT INTO birthday_celebrations (student_code, celebration_date, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (student_code, celebration_date) DO NOTHING
       RETURNING id`,
      [b.student_code, today],
    );
    if (result.rows.length > 0) inserted += 1;
  }
  if (inserted > 0) {
    logger.info({ inserted, today }, "seeded pending birthday celebrations");
  }
  return inserted;
}

export type CelebrationRow = {
  id: number;
  student_code: string;
  student_name: string | null;
  birthday: string;
  celebration_date: string;
  status: "pending" | "approved" | "dismissed" | "played";
  approved_at: string | null;
  played_at: string | null;
  played_by_kiosk: string | null;
};

export async function listTodaysCelebrations(): Promise<CelebrationRow[]> {
  await ensureBirthdayCelebrationsTable();
  const today = await schoolToday();
  const rows = await pool.query(
    `SELECT bc.id, bc.student_code, bc.celebration_date, bc.status,
            bc.approved_at, bc.played_at, bc.played_by_kiosk,
            u.name AS student_name, lp.birthday
     FROM birthday_celebrations bc
     LEFT JOIN users u ON u.student_code = bc.student_code
     LEFT JOIN student_learning_profile lp ON lp.student_code = bc.student_code
     WHERE bc.celebration_date = $1
     ORDER BY u.name`,
    [today],
  );
  return rows.rows.map((r) => ({
    id: Number(r.id),
    student_code: r.student_code,
    student_name: r.student_name ?? null,
    birthday: r.birthday ?? "",
    celebration_date: r.celebration_date,
    status: r.status,
    approved_at: r.approved_at ? new Date(r.approved_at).toISOString() : null,
    played_at: r.played_at ? new Date(r.played_at).toISOString() : null,
    played_by_kiosk: r.played_by_kiosk ?? null,
  }));
}

export async function setCelebrationStatus(args: {
  studentCode: string;
  newStatus: "approved" | "dismissed";
  approvedByUserId: number | null;
}): Promise<CelebrationRow | null> {
  await ensureBirthdayCelebrationsTable();
  const today = await schoolToday();
  const result = await pool.query(
    `UPDATE birthday_celebrations
     SET status = $3,
         approved_by = CASE WHEN $3 = 'approved' THEN $4 ELSE approved_by END,
         approved_at = CASE WHEN $3 = 'approved' THEN NOW() ELSE approved_at END
     WHERE student_code = $1 AND celebration_date = $2
     RETURNING id`,
    [args.studentCode, today, args.newStatus, args.approvedByUserId],
  );
  if (result.rows.length === 0) return null;
  const list = await listTodaysCelebrations();
  return list.find((c) => c.student_code === args.studentCode) ?? null;
}

/**
 * Claim the next approved-but-unplayed celebration for a classroom kiosk.
 * Uses SELECT ... FOR UPDATE SKIP LOCKED so two kiosks polling at once
 * can't both claim the same celebration. Returns null when there's nothing
 * pending for this school-day.
 */
export async function claimPendingCelebrationForKiosk(kioskId: string): Promise<CelebrationRow | null> {
  await ensureBirthdayCelebrationsTable();
  const today = await schoolToday();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const picked = await client.query(
      `SELECT id, student_code
       FROM birthday_celebrations
       WHERE celebration_date = $1 AND status = 'approved'
       ORDER BY approved_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [today],
    );
    if (picked.rows.length === 0) {
      await client.query("COMMIT");
      return null;
    }
    const id: number = picked.rows[0].id;
    await client.query(
      `UPDATE birthday_celebrations
       SET status = 'played', played_at = NOW(), played_by_kiosk = $2
       WHERE id = $1`,
      [id, kioskId],
    );
    await client.query("COMMIT");
    const list = await listTodaysCelebrations();
    return list.find((c) => c.id === id) ?? null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
