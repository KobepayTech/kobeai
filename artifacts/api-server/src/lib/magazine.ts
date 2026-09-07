import { pool } from "@workspace/db";
import { logger } from "./logger";
import { presenceConfig } from "./presence-monitor";
import { getMergedProfile } from "./learning-profile";

const WEEKLY_INTERVAL_MS =
  Math.max(1, Number(process.env["MAGAZINE_INTERVAL_HOURS"] ?? 24 * 7)) * 60 * 60 * 1000;

let tablesReady: Promise<void> | null = null;
let schedulerStarted = false;
let schedulerTimer: NodeJS.Timeout | null = null;

/** Structured section types the magazine UI knows how to render. */
export type MagazineSection =
  | { kind: "hero"; title: string; subtitle: string | null }
  | { kind: "attendance"; rate: number | null; days_present: number; days_expected: number }
  | { kind: "achievements"; items: string[] }
  | { kind: "topics"; strong: string[]; weak: string[] }
  | { kind: "quiz_results"; items: Array<{ title: string; score: number; date: string }> }
  | { kind: "questions"; count: number; sample: string[] }
  | { kind: "class_themes"; items: string[] }
  | { kind: "upcoming"; items: Array<{ label: string; when: string }> }
  | { kind: "school_highlight"; items: Array<{ title: string; body: string | null }> }
  | { kind: "birthday"; name: string; date_label: string }
  | { kind: "practice"; suggestion: string };

export type MagazineEditionContent = {
  hero: Extract<MagazineSection, { kind: "hero" }>;
  sections: MagazineSection[];
};

export function ensureMagazineTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS magazine_editions (
          id BIGSERIAL PRIMARY KEY,
          edition_type TEXT NOT NULL,
          student_code TEXT,
          week_start TEXT NOT NULL,
          content JSONB NOT NULL DEFAULT '{}'::jsonb,
          generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          generated_by INTEGER
        )
      `);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS magazine_editions_type_week_student_uk
          ON magazine_editions (edition_type, week_start, COALESCE(student_code, ''))
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS magazine_editions_week_idx
          ON magazine_editions (week_start)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS magazine_editions_student_idx
          ON magazine_editions (student_code, week_start)
      `);
    })().catch((err) => {
      tablesReady = null;
      throw err;
    });
  }
  return tablesReady;
}

async function currentWeekMonday(): Promise<string> {
  const row = await pool.query(
    `SELECT TO_CHAR(date_trunc('week', (NOW() AT TIME ZONE $1)::date)::date, 'YYYY-MM-DD') AS d`,
    [presenceConfig.schoolTimezone],
  );
  return row.rows[0].d as string;
}

// ---------------------------------------------------------------------------
// Data collectors — safe against missing upstream tables (each try/catch
// returns a neutral default so we can still generate a partial magazine).
// ---------------------------------------------------------------------------

async function safeQuery<T>(fn: () => Promise<T>, fallback: T, tag: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), tag },
      "magazine collector fell back to neutral default",
    );
    return fallback;
  }
}

async function attendanceForWeek(studentCode: string, weekStart: string) {
  return safeQuery(
    async () => {
      const rows = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE r.status IN ('on_schedule', 'low_confidence', 'wrong_location'))::int AS seen,
           COUNT(*) FILTER (WHERE r.status = 'not_seen')::int AS missing
         FROM presence_checkpoint_results r
         INNER JOIN presence_checkpoints cp ON cp.id = r.checkpoint_id
         WHERE r.student_code = $1
           AND cp.school_date >= $2::date
           AND cp.school_date < $2::date + INTERVAL '7 days'`,
        [studentCode, weekStart],
      );
      const seen: number = rows.rows[0]?.seen ?? 0;
      const missing: number = rows.rows[0]?.missing ?? 0;
      const denom = seen + missing;
      return {
        rate: denom > 0 ? Math.round((seen / denom) * 100) : null,
        days_present: seen,
        days_expected: denom,
      };
    },
    { rate: null as number | null, days_present: 0, days_expected: 0 },
    "attendance",
  );
}

async function quizResultsForWeek(studentCode: string, weekStart: string) {
  return safeQuery(
    async () => {
      const rows = await pool.query(
        `SELECT q.title, a.score, a.created_at
         FROM quiz_attempts a
         INNER JOIN quizzes q ON q.id = a.quiz_id
         WHERE a.student_code = $1
           AND a.created_at >= $2::date
           AND a.created_at < $2::date + INTERVAL '7 days'
         ORDER BY a.created_at DESC
         LIMIT 5`,
        [studentCode, weekStart],
      );
      return rows.rows.map((r) => ({
        title: r.title as string,
        score: Number(r.score),
        date: new Date(r.created_at).toISOString().slice(0, 10),
      }));
    },
    [] as Array<{ title: string; score: number; date: string }>,
    "quiz-results",
  );
}

async function questionsForWeek(studentCode: string, weekStart: string) {
  return safeQuery(
    async () => {
      const rows = await pool.query(
        `SELECT text
         FROM classroom_discussion_insights
         WHERE student_code = $1
           AND insight_type = 'question'
           AND captured_at >= $2::date
           AND captured_at < $2::date + INTERVAL '7 days'
         ORDER BY captured_at DESC
         LIMIT 4`,
        [studentCode, weekStart],
      );
      const countRow = await pool.query(
        `SELECT COUNT(*)::int AS n
         FROM classroom_discussion_insights
         WHERE student_code = $1
           AND insight_type = 'question'
           AND captured_at >= $2::date
           AND captured_at < $2::date + INTERVAL '7 days'`,
        [studentCode, weekStart],
      );
      return {
        count: Number(countRow.rows[0]?.n ?? 0),
        sample: rows.rows.map((r) => r.text as string),
      };
    },
    { count: 0, sample: [] as string[] },
    "questions",
  );
}

async function classThemesForWeek(studentCode: string, weekStart: string) {
  return safeQuery(
    async () => {
      const rows = await pool.query(
        `SELECT DISTINCT ci.text
         FROM classroom_discussion_insights ci
         INNER JOIN class_memberships cm
           ON cm.class_id = ci.class_id
         INNER JOIN users u ON u.id = cm.student_id
         WHERE u.student_code = $1
           AND ci.insight_type = 'theme'
           AND ci.captured_at >= $2::date
           AND ci.captured_at < $2::date + INTERVAL '7 days'
         LIMIT 5`,
        [studentCode, weekStart],
      );
      return rows.rows.map((r) => r.text as string);
    },
    [] as string[],
    "class-themes",
  );
}

async function schoolWideHighlights(weekStart: string) {
  return safeQuery(
    async () => {
      const rows = await pool.query(
        `SELECT ci.text AS title, NULL::text AS body
         FROM classroom_discussion_insights ci
         WHERE ci.insight_type = 'theme'
           AND ci.captured_at >= $1::date
           AND ci.captured_at < $1::date + INTERVAL '7 days'
         GROUP BY ci.text
         ORDER BY COUNT(*) DESC
         LIMIT 5`,
        [weekStart],
      );
      return rows.rows.map((r) => ({ title: r.title as string, body: null }));
    },
    [] as Array<{ title: string; body: string | null }>,
    "school-highlights",
  );
}

async function studentBirthdayThisWeek(studentCode: string, weekStart: string) {
  return safeQuery(
    async () => {
      const row = await pool.query(
        `SELECT lp.birthday, u.name
         FROM student_learning_profile lp
         INNER JOIN users u ON u.student_code = lp.student_code
         WHERE lp.student_code = $1 AND lp.birthday IS NOT NULL`,
        [studentCode],
      );
      const bd: string | undefined = row.rows[0]?.birthday;
      const name: string | undefined = row.rows[0]?.name;
      if (!bd || !name) return null;
      // bd is "MM-DD". Check if it falls inside [weekStart, weekStart+7).
      const [wy, wm, wd] = weekStart.split("-").map((x) => Number(x));
      if (![wy, wm, wd].every(Number.isFinite)) return null;
      const start = new Date(Date.UTC(wy!, wm! - 1, wd!));
      for (let i = 0; i < 7; i += 1) {
        const d = new Date(start.getTime() + i * 86400000);
        const key = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        if (key === bd) {
          const label = d.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          });
          return { name, date_label: label };
        }
      }
      return null;
    },
    null as null | { name: string; date_label: string },
    "birthday",
  );
}

async function upcomingItems(studentCode: string) {
  return safeQuery(
    async () => {
      const rows = await pool.query(
        `SELECT es.title AS label, es.start_at AS when_iso
         FROM exam_sessions es
         INNER JOIN class_memberships cm ON cm.class_id = es.class_id
         INNER JOIN users u ON u.id = cm.student_id
         WHERE u.student_code = $1
           AND es.start_at >= NOW()
           AND es.start_at < NOW() + INTERVAL '14 days'
         ORDER BY es.start_at ASC
         LIMIT 5`,
        [studentCode],
      );
      return rows.rows.map((r) => ({
        label: (r.label as string) ?? "Exam",
        when: new Date(r.when_iso).toISOString(),
      }));
    },
    [] as Array<{ label: string; when: string }>,
    "upcoming",
  );
}

// ---------------------------------------------------------------------------
// Composers
// ---------------------------------------------------------------------------

export async function generateStudentEdition(
  studentCode: string,
  weekStart?: string,
  generatedBy: number | null = null,
): Promise<{ id: number; content: MagazineEditionContent } | null> {
  await ensureMagazineTables();
  const week = weekStart ?? (await currentWeekMonday());
  const profile = await getMergedProfile(studentCode);
  if (!profile) return null;

  const [attendance, quizzes, questions, themes, birthday, upcoming] = await Promise.all([
    attendanceForWeek(studentCode, week),
    quizResultsForWeek(studentCode, week),
    questionsForWeek(studentCode, week),
    classThemesForWeek(studentCode, week),
    studentBirthdayThisWeek(studentCode, week),
    upcomingItems(studentCode),
  ]);

  const sections: MagazineSection[] = [];
  if (birthday) sections.push({ kind: "birthday", ...birthday });
  sections.push({ kind: "attendance", ...attendance });
  if (profile.achievements.length > 0)
    sections.push({ kind: "achievements", items: profile.achievements });
  sections.push({ kind: "topics", strong: profile.topics_strong, weak: profile.topics_weak });
  if (quizzes.length > 0) sections.push({ kind: "quiz_results", items: quizzes });
  if (questions.count > 0)
    sections.push({ kind: "questions", count: questions.count, sample: questions.sample });
  if (themes.length > 0) sections.push({ kind: "class_themes", items: themes });
  if (upcoming.length > 0) sections.push({ kind: "upcoming", items: upcoming });
  if (profile.topics_weak.length > 0) {
    sections.push({
      kind: "practice",
      suggestion: `A short revision on ${profile.topics_weak[0]} would help most this week.`,
    });
  }

  const content: MagazineEditionContent = {
    hero: {
      kind: "hero",
      title: `${profile.student_name ?? profile.student_code}'s Edition`,
      subtitle: `Week of ${week}`,
    },
    sections,
  };

  const result = await pool.query(
    `INSERT INTO magazine_editions (edition_type, student_code, week_start, content, generated_by)
     VALUES ('student', $1, $2, $3::jsonb, $4)
     ON CONFLICT (edition_type, week_start, COALESCE(student_code, ''))
     DO UPDATE SET content = EXCLUDED.content, generated_at = NOW(), generated_by = EXCLUDED.generated_by
     RETURNING id`,
    [studentCode, week, JSON.stringify(content), generatedBy],
  );
  return { id: Number(result.rows[0].id), content };
}

export async function generateSchoolEdition(
  weekStart?: string,
  generatedBy: number | null = null,
): Promise<{ id: number; content: MagazineEditionContent }> {
  await ensureMagazineTables();
  const week = weekStart ?? (await currentWeekMonday());

  const highlights = await schoolWideHighlights(week);
  const attendance = await safeQuery(
    async () => {
      const rows = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE r.status IN ('on_schedule', 'low_confidence', 'wrong_location'))::int AS seen,
           COUNT(*) FILTER (WHERE r.status = 'not_seen')::int AS missing
         FROM presence_checkpoint_results r
         INNER JOIN presence_checkpoints cp ON cp.id = r.checkpoint_id
         WHERE cp.school_date >= $1::date
           AND cp.school_date < $1::date + INTERVAL '7 days'`,
        [week],
      );
      const seen: number = rows.rows[0]?.seen ?? 0;
      const missing: number = rows.rows[0]?.missing ?? 0;
      const denom = seen + missing;
      return {
        rate: denom > 0 ? Math.round((seen / denom) * 100) : null,
        days_present: seen,
        days_expected: denom,
      };
    },
    { rate: null as number | null, days_present: 0, days_expected: 0 },
    "school-attendance",
  );

  const sections: MagazineSection[] = [];
  sections.push({ kind: "attendance", ...attendance });
  if (highlights.length > 0)
    sections.push({ kind: "school_highlight", items: highlights });

  const content: MagazineEditionContent = {
    hero: {
      kind: "hero",
      title: "KobeAI School Weekly",
      subtitle: `Week of ${week}`,
    },
    sections,
  };

  const result = await pool.query(
    `INSERT INTO magazine_editions (edition_type, student_code, week_start, content, generated_by)
     VALUES ('school', NULL, $1, $2::jsonb, $3)
     ON CONFLICT (edition_type, week_start, COALESCE(student_code, ''))
     DO UPDATE SET content = EXCLUDED.content, generated_at = NOW(), generated_by = EXCLUDED.generated_by
     RETURNING id`,
    [week, JSON.stringify(content), generatedBy],
  );
  return { id: Number(result.rows[0].id), content };
}

export async function generateAllEditions(
  weekStart?: string,
  generatedBy: number | null = null,
): Promise<{ week_start: string; school: number; students: number; failed: number }> {
  await ensureMagazineTables();
  const week = weekStart ?? (await currentWeekMonday());
  const school = await generateSchoolEdition(week, generatedBy);
  const students = await pool.query(
    `SELECT student_code FROM users WHERE role = 'student' AND student_code IS NOT NULL`,
  );
  let generated = 0;
  let failed = 0;
  for (const row of students.rows) {
    try {
      const outcome = await generateStudentEdition(row.student_code, week, generatedBy);
      if (outcome) generated += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        { err: err instanceof Error ? err.message : String(err), studentCode: row.student_code },
        "student magazine generation failed",
      );
    }
  }
  return { week_start: week, school: school.id, students: generated, failed };
}

export async function latestEditionForStudent(
  studentCode: string,
): Promise<{ week_start: string; content: MagazineEditionContent; generated_at: string } | null> {
  await ensureMagazineTables();
  const rows = await pool.query(
    `SELECT week_start, content, generated_at
     FROM magazine_editions
     WHERE edition_type = 'student' AND student_code = $1
     ORDER BY week_start DESC
     LIMIT 1`,
    [studentCode],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return {
    week_start: row.week_start,
    content: row.content as MagazineEditionContent,
    generated_at: new Date(row.generated_at).toISOString(),
  };
}

export async function latestSchoolEdition(): Promise<
  { week_start: string; content: MagazineEditionContent; generated_at: string } | null
> {
  await ensureMagazineTables();
  const rows = await pool.query(
    `SELECT week_start, content, generated_at
     FROM magazine_editions
     WHERE edition_type = 'school'
     ORDER BY week_start DESC
     LIMIT 1`,
  );
  const row = rows.rows[0];
  if (!row) return null;
  return {
    week_start: row.week_start,
    content: row.content as MagazineEditionContent,
    generated_at: new Date(row.generated_at).toISOString(),
  };
}

export function startMagazineScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  ensureMagazineTables().catch((err) =>
    logger.error({ err }, "magazine tables initialization failed"),
  );

  const scheduleNext = () => {
    schedulerTimer = setTimeout(async () => {
      try {
        const outcome = await generateAllEditions();
        logger.info(outcome, "magazine weekly generation completed");
      } catch (err) {
        logger.error({ err }, "magazine weekly generation failed");
      } finally {
        scheduleNext();
      }
    }, WEEKLY_INTERVAL_MS);
    schedulerTimer.unref();
  };

  scheduleNext();
  logger.info({ interval_hours: WEEKLY_INTERVAL_MS / 3_600_000 }, "magazine scheduler started");
}

export function stopMagazineScheduler(): void {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = null;
  schedulerStarted = false;
}
