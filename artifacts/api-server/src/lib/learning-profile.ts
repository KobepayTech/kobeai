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

  ensureLearningProfileTables().catch((err) =>
    logger.error({ err }, "learning-profile tables initialization failed"),
  );

  const scheduleNext = () => {
    schedulerTimer = setTimeout(async () => {
      try {
        const outcome = await rollupAllStudents();
        logger.info(outcome, "learning-profile nightly rollup completed");
      } catch (err) {
        logger.error({ err }, "learning-profile nightly rollup failed");
      } finally {
        scheduleNext();
      }
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
