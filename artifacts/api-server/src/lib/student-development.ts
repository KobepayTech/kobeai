import { pool } from "@workspace/db";
import { logger } from "./logger";
import { presenceConfig } from "./presence-monitor";
import { enqueueVisionAnalysisSafe } from "./vision-queue";

// ---------------------------------------------------------------------------
// Student-development toolkit. Curated notes, adaptive retests, behavior
// observations, personalized lesson plans, and an auto-authored question
// bank — all keyed off graded_paper_items and student_behavior_observations.
//
// Generators today are rule-based. Every function that produces prose is
// documented with a "// LLM slot" comment pointing to where the Qwen worker
// should later swap in. The DB shape doesn't change when the swap happens.
// ---------------------------------------------------------------------------

const RETEST_ITEMS_PER_TOPIC = Math.max(
  1,
  Number(process.env["RETEST_ITEMS_PER_TOPIC"] ?? 3),
);
const RETEST_PASS_THRESHOLD = Math.max(
  50,
  Math.min(100, Number(process.env["RETEST_PASS_PERCENT"] ?? 80)),
);
const LESSON_PLAN_INTERVAL_MS =
  Math.max(1, Number(process.env["LESSON_PLAN_INTERVAL_HOURS"] ?? 24 * 7)) * 60 * 60 * 1000;

let tablesReady: Promise<void> | null = null;
let schedulerStarted = false;
let schedulerTimer: NodeJS.Timeout | null = null;

export function ensureStudentDevelopmentTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS student_curated_notes (
          id SERIAL PRIMARY KEY,
          student_code TEXT NOT NULL,
          source_paper_id INTEGER REFERENCES graded_papers(id) ON DELETE CASCADE,
          subject TEXT,
          topic TEXT NOT NULL,
          student_answer TEXT,
          ideal_answer TEXT,
          body_markdown TEXT NOT NULL,
          generator TEXT NOT NULL DEFAULT 'rule-based-v1',
          status TEXT NOT NULL DEFAULT 'published',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS student_curated_notes_student_time_idx ON student_curated_notes (student_code, created_at)`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS retest_sessions (
          id SERIAL PRIMARY KEY,
          student_code TEXT NOT NULL,
          source_paper_id INTEGER REFERENCES graded_papers(id) ON DELETE SET NULL,
          subject TEXT,
          strategy TEXT NOT NULL DEFAULT 'wrong-only',
          difficulty_level INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'pending',
          generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          administered_at TIMESTAMPTZ,
          result_paper_id INTEGER,
          score_percent INTEGER
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS retest_sessions_student_idx ON retest_sessions (student_code, status)`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS retest_items (
          id SERIAL PRIMARY KEY,
          session_id INTEGER NOT NULL REFERENCES retest_sessions(id) ON DELETE CASCADE,
          topic TEXT NOT NULL,
          question_text TEXT NOT NULL,
          expected_answer TEXT,
          generator TEXT NOT NULL DEFAULT 'rule-based-v1',
          difficulty_level INTEGER NOT NULL DEFAULT 1
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS retest_items_session_idx ON retest_items (session_id)`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS student_behavior_observations (
          id SERIAL PRIMARY KEY,
          student_code TEXT NOT NULL,
          camera_id TEXT,
          zone_id INTEGER,
          category TEXT NOT NULL,
          confidence INTEGER NOT NULL DEFAULT 70,
          description TEXT,
          period_id INTEGER,
          subject TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS student_behavior_student_time_idx ON student_behavior_observations (student_code, captured_at)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS student_behavior_category_idx ON student_behavior_observations (category)`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS personalized_lesson_plans (
          id SERIAL PRIMARY KEY,
          student_code TEXT NOT NULL,
          week_start TEXT NOT NULL,
          plan_markdown TEXT NOT NULL,
          snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
          generator TEXT NOT NULL DEFAULT 'rule-based-v1',
          generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          generated_by INTEGER
        )
      `);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS personalized_lesson_plans_week_student_uk ON personalized_lesson_plans (week_start, student_code)`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS generated_questions (
          id SERIAL PRIMARY KEY,
          topic TEXT NOT NULL,
          subject TEXT,
          difficulty_level INTEGER NOT NULL DEFAULT 1,
          question_text TEXT NOT NULL,
          expected_answer TEXT,
          generator TEXT NOT NULL DEFAULT 'rule-based-v1',
          used_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS generated_questions_topic_diff_idx ON generated_questions (topic, difficulty_level)`);
    })().catch((err) => {
      tablesReady = null;
      throw err;
    });
  }
  return tablesReady;
}

// ---------------------------------------------------------------------------
// Curated notes generator.
// ---------------------------------------------------------------------------
type WrongItem = {
  topic: string;
  subject: string | null;
  student_answer: string | null;
  expected_answer: string | null;
};

function noteBody(item: WrongItem, studentName: string | null): string {
  // LLM slot: replace with Qwen call once wired. For now a templated
  // explainer that reads naturally when the topic + expected answer are
  // present, and degrades gracefully when only one is.
  const name = studentName ?? "This student";
  const lines: string[] = [];
  lines.push(`## ${item.topic}\n`);
  if (item.student_answer) {
    lines.push(`**Your answer:** ${item.student_answer.trim()}`);
  }
  if (item.expected_answer) {
    lines.push(`**A stronger answer:** ${item.expected_answer.trim()}`);
  }
  lines.push(``);
  lines.push(
    `Your answer touched on the right area, but it can be sharper. Focus on ` +
      `**${item.topic.toLowerCase()}** for the next lesson: revise the key ` +
      `definition, then try to write one example in your own words. If you ` +
      `can explain it in a sentence a Form 1 student would understand, you ` +
      `have it.`,
  );
  lines.push(``);
  lines.push(`_${name}, next time you see this topic on a paper, look for the ` +
    `word "${item.topic.split(/\s+/)[0]}" and pause: what's the definition ` +
    `first, then the example?_`);
  return lines.join("\n");
}

export async function generateCuratedNotesForPaper(
  paperId: number,
): Promise<number> {
  await ensureStudentDevelopmentTables();
  const paper = await pool.query(
    `SELECT p.id, p.student_code, p.subject, u.name AS student_name
     FROM graded_papers p
     LEFT JOIN users u ON u.student_code = p.student_code
     WHERE p.id = $1`,
    [paperId],
  );
  const paperRow = paper.rows[0];
  if (!paperRow) return 0;

  const items = await pool.query(
    `SELECT DISTINCT ON (question_topic)
            question_topic AS topic, student_answer, expected_answer
     FROM graded_paper_items
     WHERE paper_id = $1 AND is_correct = FALSE AND question_topic IS NOT NULL
     ORDER BY question_topic, id ASC`,
    [paperId],
  );

  let inserted = 0;
  for (const raw of items.rows) {
    if (!raw.topic) continue;
    const wrong: WrongItem = {
      topic: String(raw.topic),
      subject: paperRow.subject ?? null,
      student_answer: raw.student_answer ?? null,
      expected_answer: raw.expected_answer ?? null,
    };
    const body = noteBody(wrong, paperRow.student_name ?? null);
    await pool.query(
      `INSERT INTO student_curated_notes (
         student_code, source_paper_id, subject, topic,
         student_answer, ideal_answer, body_markdown, generator
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'rule-based-v1')`,
      [
        paperRow.student_code,
        paperRow.id,
        paperRow.subject,
        wrong.topic,
        wrong.student_answer,
        wrong.expected_answer,
        body,
      ],
    );
    inserted += 1;

    // LLM slot: also enqueue a Qwen job so the note can be re-authored
    // richer once the on-prem worker lands. Fire-and-forget.
    enqueueVisionAnalysisSafe({
      studentCode: paperRow.student_code,
      question: `Write a 200-word student-facing curated note for topic "${wrong.topic}" in ${paperRow.subject ?? "the relevant subject"}. Student's answer was "${wrong.student_answer ?? "not captured"}"; expected "${wrong.expected_answer ?? "not captured"}". Explain the concept, correct the misconception, give one Tanzanian example.`,
      reason: "auto:curated_note",
      priority: 6,
      context: { topic: wrong.topic, source_paper_id: paperRow.id },
    });
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Question bank — auto-authored questions per topic + difficulty.
// ---------------------------------------------------------------------------
function stubQuestionsForTopic(
  topic: string,
  subject: string | null,
  difficulty: number,
): Array<{ question_text: string; expected_answer: string }> {
  // LLM slot: swap with Qwen. Deterministic seed so a topic keeps its
  // question wording across runs (nicer for teachers who see the bank).
  const t = topic.trim();
  const s = subject ?? "the subject";
  const easy = [
    { question_text: `Define "${t}" in your own words.`, expected_answer: `A concise definition of ${t}.` },
    { question_text: `Give one example of ${t} in daily life.`, expected_answer: `A concrete real-world example.` },
    { question_text: `What is the opposite of ${t}?`, expected_answer: `A contrasting concept the student should be able to name.` },
  ];
  const medium = [
    { question_text: `Explain how ${t} works, step by step.`, expected_answer: `A short numbered explanation.` },
    { question_text: `Compare ${t} to a similar concept in ${s}. What is different?`, expected_answer: `At least two clear differences.` },
    { question_text: `Solve this practice problem involving ${t}: <insert>.`, expected_answer: `Correct working shown.` },
  ];
  const hard = [
    { question_text: `Design an experiment that would demonstrate ${t}.`, expected_answer: `An experiment with variables + expected result.` },
    { question_text: `Where might ${t} fail or break down? Give an example.`, expected_answer: `An edge case or misconception.` },
    { question_text: `Explain ${t} to a Form 1 student in three sentences.`, expected_answer: `Simple language, right level of detail.` },
  ];
  if (difficulty <= 1) return easy;
  if (difficulty <= 3) return medium;
  return hard;
}

async function ensureQuestionBankFor(
  topic: string,
  subject: string | null,
  difficulty: number,
): Promise<void> {
  const existing = await pool.query(
    `SELECT COUNT(*)::int AS n FROM generated_questions
     WHERE topic = $1 AND difficulty_level = $2`,
    [topic, difficulty],
  );
  if ((existing.rows[0]?.n ?? 0) >= 3) return;
  const stubs = stubQuestionsForTopic(topic, subject, difficulty);
  for (const s of stubs) {
    await pool.query(
      `INSERT INTO generated_questions
         (topic, subject, difficulty_level, question_text, expected_answer, generator)
       VALUES ($1, $2, $3, $4, $5, 'rule-based-v1')`,
      [topic, subject, difficulty, s.question_text, s.expected_answer],
    );
  }
}

async function pickBankQuestion(
  topic: string,
  subject: string | null,
  difficulty: number,
  excludeIds: Set<number>,
): Promise<{ id: number; text: string; expected: string | null } | null> {
  await ensureQuestionBankFor(topic, subject, difficulty);
  const rows = await pool.query(
    `SELECT id, question_text, expected_answer
     FROM generated_questions
     WHERE topic = $1 AND difficulty_level = $2
     ORDER BY used_count ASC, created_at ASC`,
    [topic, difficulty],
  );
  for (const r of rows.rows) {
    if (excludeIds.has(Number(r.id))) continue;
    return {
      id: Number(r.id),
      text: r.question_text,
      expected: r.expected_answer,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Adaptive retest builder.
// ---------------------------------------------------------------------------
export async function generateRetestForPaper(
  paperId: number,
): Promise<{ retest_id: number; items: number } | null> {
  await ensureStudentDevelopmentTables();
  const paper = await pool.query(
    `SELECT id, student_code, subject FROM graded_papers WHERE id = $1`,
    [paperId],
  );
  const paperRow = paper.rows[0];
  if (!paperRow) return null;

  const wrongTopics = await pool.query(
    `SELECT question_topic, COUNT(*)::int AS n
     FROM graded_paper_items
     WHERE paper_id = $1 AND is_correct = FALSE AND question_topic IS NOT NULL
     GROUP BY question_topic
     ORDER BY n DESC`,
    [paperId],
  );
  if (wrongTopics.rows.length === 0) return null;

  // Level = 1 the first time we see this student; bump by 1 each time
  // they pass a retest at the current level.
  const passedCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM retest_sessions
     WHERE student_code = $1 AND status = 'passed'`,
    [paperRow.student_code],
  );
  const difficulty = 1 + Math.min(4, Number(passedCount.rows[0]?.n ?? 0));

  const session = await pool.query(
    `INSERT INTO retest_sessions (
       student_code, source_paper_id, subject, strategy,
       difficulty_level, status
     ) VALUES ($1, $2, $3, 'wrong-only', $4, 'pending')
     RETURNING id`,
    [paperRow.student_code, paperRow.id, paperRow.subject, difficulty],
  );
  const sessionId = Number(session.rows[0].id);

  const usedIds = new Set<number>();
  let itemsInserted = 0;
  for (const t of wrongTopics.rows) {
    for (let i = 0; i < RETEST_ITEMS_PER_TOPIC; i += 1) {
      const q = await pickBankQuestion(t.question_topic, paperRow.subject, difficulty, usedIds);
      if (!q) break;
      usedIds.add(q.id);
      await pool.query(
        `INSERT INTO retest_items (
           session_id, topic, question_text, expected_answer, generator, difficulty_level
         ) VALUES ($1, $2, $3, $4, 'rule-based-v1', $5)`,
        [sessionId, t.question_topic, q.text, q.expected, difficulty],
      );
      // Bump used_count so the same question isn't the top pick next time.
      await pool.query(
        `UPDATE generated_questions SET used_count = used_count + 1 WHERE id = $1`,
        [q.id],
      );
      itemsInserted += 1;
    }
  }
  return { retest_id: sessionId, items: itemsInserted };
}

/**
 * Mark a retest session administered + record the score. Optionally
 * references the graded_papers row that captured the results.
 */
export async function recordRetestResult(args: {
  sessionId: number;
  scorePercent: number;
  resultPaperId?: number | null;
}): Promise<void> {
  await ensureStudentDevelopmentTables();
  const passed = args.scorePercent >= RETEST_PASS_THRESHOLD;
  await pool.query(
    `UPDATE retest_sessions
     SET status = $2,
         administered_at = NOW(),
         result_paper_id = $3,
         score_percent = $4
     WHERE id = $1`,
    [args.sessionId, passed ? "passed" : "failed", args.resultPaperId ?? null, args.scorePercent],
  );
}

// ---------------------------------------------------------------------------
// Behavior observations
// ---------------------------------------------------------------------------
export const BEHAVIOR_CATEGORIES = [
  "attentive",
  "reading",
  "writing",
  "sleeping",
  "idle",
  "collaborating",
  "drawing",
  "restless",
  "distracted",
] as const;
type BehaviorCategory = (typeof BEHAVIOR_CATEGORIES)[number];

export async function recordBehaviorObservation(input: {
  studentCode: string;
  cameraId?: string | null;
  zoneId?: number | null;
  category: BehaviorCategory;
  confidence?: number;
  description?: string | null;
  periodId?: number | null;
  subject?: string | null;
  metadata?: Record<string, unknown>;
  capturedAt?: Date | null;
}): Promise<{ id: number }> {
  await ensureStudentDevelopmentTables();
  const rows = await pool.query(
    `INSERT INTO student_behavior_observations (
       student_code, camera_id, zone_id, category, confidence, description,
       period_id, subject, metadata, captured_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, COALESCE($10::timestamptz, NOW()))
     RETURNING id`,
    [
      input.studentCode,
      input.cameraId ?? null,
      input.zoneId ?? null,
      input.category,
      Math.max(0, Math.min(100, Math.round((input.confidence ?? 70)))),
      input.description ?? null,
      input.periodId ?? null,
      input.subject ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.capturedAt ? input.capturedAt.toISOString() : null,
    ],
  );
  return { id: Number(rows.rows[0].id) };
}

// ---------------------------------------------------------------------------
// Personalized lesson plan generator
// ---------------------------------------------------------------------------
export async function generateLessonPlanForStudent(
  studentCode: string,
  weekStart?: string,
  generatedBy: number | null = null,
): Promise<{ id: number; plan_markdown: string } | null> {
  await ensureStudentDevelopmentTables();
  const week =
    weekStart ??
    (
      await pool.query(
        `SELECT TO_CHAR(date_trunc('week', (NOW() AT TIME ZONE $1)::date)::date, 'YYYY-MM-DD') AS d`,
        [presenceConfig.schoolTimezone],
      )
    ).rows[0].d;

  const profile = await pool.query(
    `SELECT lp.*, u.name AS student_name
     FROM student_learning_profile lp
     LEFT JOIN users u ON u.student_code = lp.student_code
     WHERE lp.student_code = $1
     LIMIT 1`,
    [studentCode],
  );
  const p = profile.rows[0];
  if (!p) return null;
  const studentName: string = p.student_name ?? studentCode;

  // Weekly behavior aggregate.
  const behavior = await pool.query(
    `SELECT category, COUNT(*)::int AS n
     FROM student_behavior_observations
     WHERE student_code = $1
       AND captured_at >= NOW() - INTERVAL '7 days'
     GROUP BY category
     ORDER BY n DESC`,
    [studentCode],
  );
  const behaviorMap = new Map<string, number>(behavior.rows.map((r) => [r.category as string, Number(r.n)]));
  const dominantHabit = behavior.rows[0]?.category as string | undefined;

  // Open retests count.
  const openRetests = await pool.query(
    `SELECT id, subject, difficulty_level
     FROM retest_sessions
     WHERE student_code = $1 AND status = 'pending'
     ORDER BY generated_at DESC
     LIMIT 5`,
    [studentCode],
  );

  // Recent curated notes.
  const notes = await pool.query(
    `SELECT topic, subject
     FROM student_curated_notes
     WHERE student_code = $1
     ORDER BY created_at DESC
     LIMIT 5`,
    [studentCode],
  );

  const weakTopics: string[] = Array.isArray(p.override_topics_weak)
    ? (p.override_topics_weak as string[])
    : Array.isArray(p.computed_topics_weak)
      ? (p.computed_topics_weak as string[])
      : [];
  const strongTopics: string[] = Array.isArray(p.override_topics_strong)
    ? (p.override_topics_strong as string[])
    : Array.isArray(p.computed_topics_strong)
      ? (p.computed_topics_strong as string[])
      : [];
  const remediations: Array<{ topic: string; urgency: string; wrong_count: number }> = Array.isArray(p.computed_remediations)
    ? p.computed_remediations
    : [];

  // Build the plan markdown. LLM slot for a richer voice.
  const lines: string[] = [];
  lines.push(`# Personalized lesson plan — ${studentName}`);
  lines.push(`_Week starting ${week}_\n`);

  lines.push(`## Focus this week`);
  if (weakTopics.length === 0 && remediations.length === 0) {
    lines.push(`Nothing urgent surfaced from marking. Keep reinforcing ${strongTopics.slice(0, 2).join(" and ") || "core basics"} while introducing new material.`);
  } else {
    for (const r of remediations.slice(0, 3)) {
      lines.push(`- **${r.topic}** (${r.urgency}) — ${r.wrong_count} wrong recently; rebuild the definition first, then work an example.`);
    }
    for (const t of weakTopics.slice(0, 3)) {
      if (!remediations.find((r) => r.topic === t)) {
        lines.push(`- **${t}** — cover once more with a fresh worked example.`);
      }
    }
  }
  lines.push("");

  lines.push(`## Practice`);
  if (openRetests.rows.length > 0) {
    lines.push(`${openRetests.rows.length} adaptive retest${openRetests.rows.length === 1 ? "" : "s"} pending — administer this week to confirm improvement:`);
    for (const r of openRetests.rows) {
      lines.push(`- Retest #${r.id} · ${r.subject ?? "General"} · difficulty ${r.difficulty_level}`);
    }
  } else {
    lines.push(`No retests pending. Reserve ~10 minutes for spaced review of ${weakTopics[0] ?? "recent material"}.`);
  }
  lines.push("");

  lines.push(`## Watch out for`);
  if (dominantHabit) {
    const habitAdvice: Record<string, string> = {
      sleeping: `${studentName} was seen sleeping ${behaviorMap.get("sleeping")} times during prep. Move them to the front row and shorten focused work chunks to 15 minutes.`,
      idle: `${studentName} appeared idle ${behaviorMap.get("idle")} times. Give a concrete task ("finish these three problems") with a checkbox they can hand in.`,
      distracted: `${studentName} looked distracted ${behaviorMap.get("distracted")} times. Try a peer-buddy pairing for the next reading session.`,
      restless: `${studentName} was restless ${behaviorMap.get("restless")} times. Build in a two-minute movement break every 25 minutes.`,
      drawing: `${studentName} drew ${behaviorMap.get("drawing")} times during prep — lean into it. Ask them to draw a diagram of the concept before writing the explanation.`,
      reading: `${studentName} was reading well (${behaviorMap.get("reading")} obs). Give them a follow-up chapter to summarise.`,
      writing: `${studentName} was writing consistently (${behaviorMap.get("writing")}). Consider asking for a one-page personal reflection.`,
      collaborating: `${studentName} collaborates well. Pair them with a student who needs support on ${weakTopics[0] ?? "the current topic"}.`,
      attentive: `${studentName} was attentive most of the week — no changes needed to seating or pacing.`,
    };
    lines.push(habitAdvice[dominantHabit] ?? `Habit observed most this week: **${dominantHabit}**.`);
  } else {
    lines.push(`No prep-time observations yet this week. The cameras will fill this in as the term progresses.`);
  }
  if (notes.rows.length > 0) {
    lines.push("");
    lines.push(`Recently generated notes to hand out: ${notes.rows.map((n) => n.topic).join(", ")}.`);
  }
  const plan = lines.join("\n");

  const snapshot = {
    week_start: week,
    weak_topics: weakTopics,
    strong_topics: strongTopics,
    remediations,
    behavior_counts: Object.fromEntries(behaviorMap),
    open_retest_ids: openRetests.rows.map((r) => Number(r.id)),
    recent_note_topics: notes.rows.map((n) => n.topic),
  };

  const result = await pool.query(
    `INSERT INTO personalized_lesson_plans
       (student_code, week_start, plan_markdown, snapshot, generator, generated_by)
     VALUES ($1, $2, $3, $4::jsonb, 'rule-based-v1', $5)
     ON CONFLICT (week_start, student_code) DO UPDATE SET
       plan_markdown = EXCLUDED.plan_markdown,
       snapshot = EXCLUDED.snapshot,
       generator = EXCLUDED.generator,
       generated_at = NOW(),
       generated_by = EXCLUDED.generated_by
     RETURNING id, plan_markdown`,
    [studentCode, week, plan, JSON.stringify(snapshot), generatedBy],
  );
  return { id: Number(result.rows[0].id), plan_markdown: result.rows[0].plan_markdown };
}

export async function generateAllLessonPlans(
  weekStart?: string,
  generatedBy: number | null = null,
): Promise<{ generated: number; failed: number; week_start: string }> {
  await ensureStudentDevelopmentTables();
  const students = await pool.query(
    `SELECT student_code FROM users WHERE role = 'student' AND student_code IS NOT NULL`,
  );
  let generated = 0;
  let failed = 0;
  let week = weekStart ?? "";
  for (const row of students.rows) {
    try {
      const out = await generateLessonPlanForStudent(row.student_code, weekStart, generatedBy);
      if (out) {
        generated += 1;
        if (!week) {
          const w = await pool.query(
            `SELECT week_start FROM personalized_lesson_plans WHERE id = $1`,
            [out.id],
          );
          week = w.rows[0]?.week_start ?? "";
        }
      }
    } catch (err) {
      failed += 1;
      logger.error(
        { err: err instanceof Error ? err.message : String(err), studentCode: row.student_code },
        "lesson-plan generation failed",
      );
    }
  }
  return { generated, failed, week_start: week };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
export function startLessonPlanScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  ensureStudentDevelopmentTables().catch((err) =>
    logger.error({ err }, "student-development tables initialization failed"),
  );
  const tick = async () => {
    try {
      const out = await generateAllLessonPlans();
      logger.info(out, "weekly lesson-plan generation completed");
    } catch (err) {
      logger.error({ err }, "weekly lesson-plan generation failed");
    } finally {
      schedulerTimer = setTimeout(tick, LESSON_PLAN_INTERVAL_MS);
      schedulerTimer.unref();
    }
  };
  schedulerTimer = setTimeout(tick, LESSON_PLAN_INTERVAL_MS);
  schedulerTimer.unref();
  logger.info({ interval_hours: LESSON_PLAN_INTERVAL_MS / 3_600_000 }, "lesson-plan scheduler started");
}

export function stopLessonPlanScheduler(): void {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = null;
  schedulerStarted = false;
}
