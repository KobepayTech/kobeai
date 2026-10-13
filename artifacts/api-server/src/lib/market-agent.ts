import crypto from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  kpLedgerTable,
  marketAgentRunsTable,
  marketAgentSettingsTable,
  marketQuestionsTable,
  questionLocksTable,
  quizQuestionsTable,
  quizzesTable,
  studentLearningProfileTable,
  studentSubjectsTable,
  type MarketAgentSettings,
} from "@workspace/db";
import { brainJson } from "./kobe-brain";
import { logger } from "./logger";

// ===========================================================================
// The question-market agent.
//
// The market used to be a shelf an operator stocked by hand: someone in
// Dar typed questions into a form and students across every school answered
// the same ones. That does not scale past a handful of schools and it never
// knew what any particular school was weak at.
//
// This module replaces that operator with an agent running on the school's
// own models. Every cycle it:
//
//   sweep  → expire questions nobody solved, release dead locks
//   read   → how thin is the floor per subject, what is actually selling,
//            which topics are students weak at (student_learning_profile),
//            which subjects does this school even teach (student_subjects)
//   plan   → a list of {subject, topic, difficulty, count} with a reason
//   write  → generate each batch as strict JSON on the on-prem brain
//   verify → re-solve every generated question with the answer key hidden
//            and drop the ones the two passes disagree on
//   price  → KP from difficulty × how starved that subject is
//   post   → insert, deduped on a prompt fingerprint
//
// Three properties are deliberate:
//
//   * **It cannot mint KP out of nothing.** The agent prices questions inside
//     the operator's [reward_min, reward_max] band and an open-floor ceiling
//     caps total liability. KP still only moves through the ledger.
//   * **It fails closed.** No brain installed, brain unreachable, JSON
//     garbage — the cycle falls back to recycling teacher-authored quiz
//     questions, and if there are none it posts nothing. It never posts a
//     question it could not verify.
//   * **It is auditable.** One market_agent_runs row per cycle records the
//     plan, the model, and how many questions were generated / accepted /
//     rejected, because the thing it is doing spends students' KP.
// ===========================================================================

export type Difficulty = "easy" | "medium" | "hard";

export type PlanItem = {
  subject: string;
  topic: string;
  difficulty: Difficulty;
  count: number;
  reason: string;
};

export type RunSummary = {
  run_id: number;
  status: "ok" | "partial" | "failed";
  model: string | null;
  plan: PlanItem[];
  generated: number;
  accepted: number;
  rejected: number;
  expired: number;
  locks_released: number;
  notes: string;
};

// The O-level subjects a Tanzanian secondary school actually teaches, with
// the topics the agent rotates through when the school has no weak-topic
// signal yet (a brand-new install, week one). Once results start landing,
// `student_learning_profile.computed_topics_weak` takes over.
const CURRICULUM: Record<string, string[]> = {
  Mathematics: [
    "fractions and decimals",
    "ratio and proportion",
    "linear equations",
    "quadratic equations",
    "sequences",
    "perimeter, area and volume",
    "trigonometry of right triangles",
    "probability",
    "statistics and averages",
  ],
  Physics: [
    "measurement and units",
    "forces and Newton's laws",
    "work, energy and power",
    "pressure in fluids",
    "heat and temperature",
    "light and reflection",
    "current electricity",
    "magnetism",
  ],
  Chemistry: [
    "matter and its states",
    "the periodic table",
    "chemical bonding",
    "acids, bases and salts",
    "the mole concept",
    "oxidation and reduction",
    "water treatment",
  ],
  Biology: [
    "cell structure",
    "classification of living things",
    "nutrition and digestion",
    "transport in plants",
    "respiration",
    "reproduction",
    "genetics",
    "health and disease",
  ],
  Geography: [
    "map reading",
    "the structure of the earth",
    "climate of East Africa",
    "soil and vegetation",
    "population and settlement",
    "mining and industry in Tanzania",
    "transport and communication",
  ],
  History: [
    "early communities of East Africa",
    "the trans-Saharan and Indian Ocean trade",
    "colonialism in Tanganyika",
    "the Maji Maji resistance",
    "the struggle for independence",
    "the Arusha Declaration",
    "the union of Tanganyika and Zanzibar",
  ],
  Civics: [
    "the constitution of Tanzania",
    "human rights and responsibilities",
    "the three arms of government",
    "elections and democracy",
    "national symbols and values",
  ],
  English: [
    "tenses",
    "direct and indirect speech",
    "articles and prepositions",
    "comprehension",
    "letter writing",
    "vocabulary in context",
  ],
  Kiswahili: [
    "ngeli za nomino",
    "vitenzi na nyakati",
    "methali na misemo",
    "ufahamu",
    "utungaji",
  ],
  "Computer Studies": [
    "computer hardware",
    "operating systems",
    "spreadsheets",
    "the internet and safety",
    "algorithms and flowcharts",
  ],
};

const DEFAULT_SUBJECTS = ["Mathematics", "Physics", "Chemistry", "Biology", "Geography", "English"];
const DIFFICULTY_MIX: Difficulty[] = ["easy", "medium", "medium", "hard"];

// Share of the operator's KP band each difficulty sits at before scarcity.
const DIFFICULTY_WEIGHT: Record<Difficulty, number> = { easy: 0.05, medium: 0.2, hard: 0.45 };

/** Questions asked for in one brain call. Small batches parse far more reliably. */
const BATCH_SIZE = 4;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function loadAgentSettings(): Promise<MarketAgentSettings> {
  const [row] = await db.select().from(marketAgentSettingsTable).limit(1);
  if (row) return row;
  const [created] = await db
    .insert(marketAgentSettingsTable)
    .values({ id: 1 })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [existing] = await db.select().from(marketAgentSettingsTable).limit(1);
  return existing!;
}

export async function saveAgentSettings(
  patch: Partial<MarketAgentSettings>,
): Promise<MarketAgentSettings> {
  await loadAgentSettings();
  const [updated] = await db
    .update(marketAgentSettingsTable)
    .set({ ...patch, updated_at: new Date() })
    .where(eq(marketAgentSettingsTable.id, 1))
    .returning();
  return updated!;
}

// ---------------------------------------------------------------------------
// Reading the floor
// ---------------------------------------------------------------------------

export type FloorReading = {
  /** Open, approved questions per subject. */
  open: Map<string, number>;
  /** Questions won in the last 24h per subject — the demand signal. */
  won24h: Map<string, number>;
  totalOpen: number;
  /** Weak topics rolled up across the school, most students first. */
  weakTopics: string[];
  /** Subjects the roster actually takes. Empty until a subject sheet is read. */
  rosterSubjects: string[];
};

export async function readFloor(): Promise<FloorReading> {
  const openRows = await db
    .select({ subject: marketQuestionsTable.subject, n: sql<number>`count(*)::int` })
    .from(marketQuestionsTable)
    .where(
      and(
        sql`${marketQuestionsTable.status} IN ('open', 'locked')`,
        eq(marketQuestionsTable.review_status, "approved"),
      ),
    )
    .groupBy(marketQuestionsTable.subject);

  const wonRows = await db
    .select({ subject: marketQuestionsTable.subject, n: sql<number>`count(*)::int` })
    .from(marketQuestionsTable)
    .where(
      and(
        eq(marketQuestionsTable.status, "won"),
        gte(marketQuestionsTable.won_at, new Date(Date.now() - 86_400_000)),
      ),
    )
    .groupBy(marketQuestionsTable.subject);

  const profiles = await db
    .select({
      computed: studentLearningProfileTable.computed_topics_weak,
      override: studentLearningProfileTable.override_topics_weak,
    })
    .from(studentLearningProfileTable)
    .limit(2000);

  const weakCounts = new Map<string, number>();
  for (const p of profiles) {
    // A teacher override replaces the computed list entirely — same rule the
    // merged profile view uses.
    const list = Array.isArray(p.override) ? p.override : Array.isArray(p.computed) ? p.computed : [];
    for (const topic of list as unknown[]) {
      const t = String(topic ?? "").trim();
      if (t.length < 3 || t.length > 80) continue;
      weakCounts.set(t, (weakCounts.get(t) ?? 0) + 1);
    }
  }

  const subjectRows = await db
    .select({ subject: studentSubjectsTable.subject, n: sql<number>`count(*)::int` })
    .from(studentSubjectsTable)
    .groupBy(studentSubjectsTable.subject)
    .orderBy(desc(sql`count(*)`));

  const open = new Map(openRows.map((r) => [r.subject, r.n]));
  return {
    open,
    won24h: new Map(wonRows.map((r) => [r.subject, r.n])),
    totalOpen: openRows.reduce((sum, r) => sum + r.n, 0),
    weakTopics: [...weakCounts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t),
    rosterSubjects: subjectRows.map((r) => r.subject),
  };
}

/**
 * Subjects the agent stocks. Operator override first, then what the roster
 * actually takes (so a school that dropped Computer Studies stops seeing it),
 * then a sane default for a school on day one.
 */
export function chooseSubjects(settings: MarketAgentSettings, floor: FloorReading): string[] {
  const configured = Array.isArray(settings.subjects)
    ? (settings.subjects as unknown[]).map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (configured.length > 0) return [...new Set(configured)];
  if (floor.rosterSubjects.length > 0) return floor.rosterSubjects.slice(0, 12);
  return DEFAULT_SUBJECTS;
}

/**
 * Weak topics that plausibly belong to this subject: either the subject is
 * named in the topic, or the topic looks like one of that subject's
 * curriculum entries. Anything we can't attribute stays out — quizzing
 * Biology students on "quadratic equations" because the string was in the
 * weak list would be worse than using the curriculum rotation.
 */
export function weakTopicsForSubject(subject: string, weakTopics: string[]): string[] {
  const curriculum = CURRICULUM[subject] ?? [];
  const subjectWord = subject.toLowerCase();
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3));
  return weakTopics.filter((topic) => {
    const lower = topic.toLowerCase();
    if (lower.includes(subjectWord)) return true;
    const topicWords = words(topic);
    return curriculum.some((c) => {
      const shared = [...words(c)].filter((w) => topicWords.has(w));
      return shared.length > 0;
    });
  });
}

/** Deterministic rotation so a school doesn't get the same topic every cycle. */
function rotateTopic(subject: string, seed: number): string {
  const topics = CURRICULUM[subject] ?? ["general revision"];
  return topics[seed % topics.length]!;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export function planMarket(settings: MarketAgentSettings, floor: FloorReading): PlanItem[] {
  const subjects = chooseSubjects(settings, floor);
  const headroom = Math.max(0, settings.max_open_questions - floor.totalOpen);
  if (headroom === 0) return [];

  const plan: PlanItem[] = [];
  let budget = headroom;
  const cycle = Math.floor(Date.now() / 3_600_000); // rotates hourly

  for (const [index, subject] of subjects.entries()) {
    if (budget <= 0) break;
    const open = floor.open.get(subject) ?? 0;
    const demand = floor.won24h.get(subject) ?? 0;
    // A subject students are actually clearing gets a deeper shelf: the floor
    // plus one for every two questions won in the last day, capped at double.
    const target = Math.min(settings.floor_per_subject * 2, settings.floor_per_subject + Math.floor(demand / 2));
    const need = Math.min(target - open, budget);
    if (need <= 0) continue;

    const weak = weakTopicsForSubject(subject, floor.weakTopics);
    for (let i = 0; i < need; i += BATCH_SIZE) {
      const count = Math.min(BATCH_SIZE, need - i);
      const fromWeak = weak[(cycle + i) % Math.max(1, weak.length)];
      const topic = weak.length > 0 ? fromWeak! : rotateTopic(subject, cycle + index + i);
      plan.push({
        subject,
        topic,
        difficulty: DIFFICULTY_MIX[(cycle + index + i) % DIFFICULTY_MIX.length]!,
        count,
        reason:
          weak.length > 0
            ? `${open}/${target} on the floor; students are weak on this topic`
            : `${open}/${target} on the floor; curriculum rotation`,
      });
      budget -= count;
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * KP for one question. Difficulty sets the band position; scarcity lifts it
 * by up to half again, so the subject nobody has stocked pays best and the
 * floor refills itself. Always inside the operator's band.
 */
export function priceQuestion(
  difficulty: Difficulty,
  open: number,
  target: number,
  settings: Pick<MarketAgentSettings, "reward_min" | "reward_max">,
): number {
  const span = Math.max(0, settings.reward_max - settings.reward_min);
  const base = settings.reward_min + span * DIFFICULTY_WEIGHT[difficulty];
  const scarcity = target <= 0 ? 0 : Math.max(0, Math.min(1, (target - open) / target));
  const priced = Math.round(base * (1 + scarcity * 0.5));
  return Math.max(settings.reward_min, Math.min(settings.reward_max, priced));
}

// ---------------------------------------------------------------------------
// Generation + verification
// ---------------------------------------------------------------------------

export type DraftQuestion = {
  prompt: string;
  choices: string[];
  correct_index: number;
  explanation?: string;
};

const WRITER_SYSTEM =
  "You write multiple-choice questions for Tanzanian secondary-school students " +
  "following the NECTA syllabus. Questions are self-contained, unambiguous, and " +
  "have exactly one defensible answer. Use Tanzanian contexts (shillings, local " +
  "places, local examples) where a context is needed. Output JSON only.";

function writerPrompt(item: PlanItem): string {
  return (
    `Write ${item.count} ${item.difficulty} multiple-choice questions on "${item.topic}" ` +
    `for ${item.subject}.\n\n` +
    `Return {"questions":[{"prompt":"…","choices":["…","…","…","…"],` +
    `"correct_index":0,"explanation":"…"}]}\n\n` +
    `Rules:\n` +
    `- Exactly 4 choices. Exactly one is correct; correct_index is its 0-based position.\n` +
    `- Vary which position is correct across the set.\n` +
    `- Wrong choices must be plausible mistakes a student really makes, never filler.\n` +
    `- No "all of the above", no "none of the above", no trick wording.\n` +
    `- explanation is one sentence saying why the answer is right.\n` +
    `- ${item.difficulty === "easy" ? "Answerable from recall in under a minute." : ""}` +
    `${item.difficulty === "medium" ? "Needs one step of working." : ""}` +
    `${item.difficulty === "hard" ? "Needs two or three steps of reasoning, still doable without a calculator." : ""}`
  );
}

export async function generateBatch(item: PlanItem): Promise<{ drafts: DraftQuestion[]; model: string } | null> {
  const out = await brainJson<{ questions?: unknown[] }>(writerPrompt(item), {
    tag: "market-agent:write",
    system: WRITER_SYSTEM,
    maxTokens: 1600,
    temperature: 0.8,
  });
  if (!out) return null;
  const drafts = sanitizeDrafts(out.value?.questions);
  if (drafts.length === 0) return null;
  return { drafts, model: out.model };
}

export function sanitizeDrafts(raw: unknown): DraftQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: DraftQuestion[] = [];
  for (const entry of raw) {
    const q = entry as Record<string, unknown>;
    const prompt = String(q?.["prompt"] ?? "").trim();
    const choices = Array.isArray(q?.["choices"])
      ? (q["choices"] as unknown[]).map((c) => String(c ?? "").trim()).filter(Boolean)
      : [];
    const correct = Number(q?.["correct_index"]);
    if (prompt.length < 12 || prompt.length > 600) continue;
    if (choices.length < 2 || choices.length > 6) continue;
    // Duplicate options make the question unanswerable — two "correct" answers
    // where only one index scores.
    if (new Set(choices.map((c) => c.toLowerCase())).size !== choices.length) continue;
    if (!Number.isInteger(correct) || correct < 0 || correct >= choices.length) continue;
    if (/all of the above|none of the above/i.test(choices.join(" "))) continue;
    const explanation = String(q?.["explanation"] ?? "").trim();
    out.push({
      prompt,
      choices,
      correct_index: correct,
      ...(explanation ? { explanation: explanation.slice(0, 400) } : {}),
    });
  }
  return out;
}

const CHECKER_SYSTEM =
  "You are a Tanzanian secondary-school examiner checking a colleague's draft " +
  "question. Answer honestly, including when the draft is faulty. Output JSON only.";

/**
 * Second opinion on a draft, with the answer key hidden. A question the
 * checker cannot solve to the same option is a question a student would be
 * robbed by, so we drop it rather than post it.
 *
 * Returns true only on an explicit, matching, confident answer — an
 * unreachable brain means "not verified", which means not posted.
 */
export async function verifyDraft(draft: DraftQuestion, subject: string): Promise<boolean> {
  const out = await brainJson<{ answer_index?: unknown; single_answer?: unknown; confidence?: unknown }>(
    `Subject: ${subject}\nQuestion: ${draft.prompt}\n` +
      draft.choices.map((c, i) => `${i}. ${c}`).join("\n") +
      `\n\nAnswer it yourself, then judge the draft.\n` +
      `Return {"answer_index":<0-based index of the one correct option>,` +
      `"single_answer":true|false,"confidence":0-100}\n` +
      `single_answer is false if two options are both defensible, none is correct, ` +
      `or the question is ambiguous.`,
    { tag: "market-agent:verify", system: CHECKER_SYSTEM, maxTokens: 300, temperature: 0 },
  );
  if (!out) return false;
  const answer = Number(out.value?.answer_index);
  const single = out.value?.single_answer;
  const confidence = Number(out.value?.confidence);
  if (!Number.isInteger(answer) || answer !== draft.correct_index) return false;
  if (single === false) return false;
  if (Number.isFinite(confidence) && confidence < 60) return false;
  return true;
}

/** Normalised hash of a prompt, so the same question is never posted twice. */
export function fingerprint(subject: string, prompt: string): string {
  const norm = `${subject}|${prompt}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return crypto.createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// No-brain fallback: recycle teacher-authored quiz questions
// ---------------------------------------------------------------------------

/**
 * A school with no LLM box still deserves a live market. Teachers have
 * already written thousands of multiple-choice questions into quizzes, with
 * an answer key — so when the brain is unavailable the agent puts those on
 * the floor instead, deduped by the same fingerprint. It is strictly better
 * than an empty market and the questions are already syllabus-accurate.
 */
export async function recycleQuizQuestions(
  subjects: string[],
  limit: number,
): Promise<Array<DraftQuestion & { subject: string }>> {
  if (limit <= 0 || subjects.length === 0) return [];
  const rows = await db
    .select({
      subject: quizzesTable.subject,
      text: quizQuestionsTable.text,
      options: quizQuestionsTable.options,
      correct_letter: quizQuestionsTable.correct_letter,
    })
    .from(quizQuestionsTable)
    .innerJoin(quizzesTable, eq(quizQuestionsTable.quiz_id, quizzesTable.id))
    .where(inArray(quizzesTable.subject, subjects))
    .orderBy(sql`random()`)
    .limit(limit * 4);

  const out: Array<DraftQuestion & { subject: string }> = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    const choices = Array.isArray(row.options) ? row.options.map((o) => String(o).trim()).filter(Boolean) : [];
    const index = (row.correct_letter ?? "").trim().toUpperCase().charCodeAt(0) - 65;
    if (choices.length < 2 || !Number.isInteger(index) || index < 0 || index >= choices.length) continue;
    out.push({ subject: row.subject, prompt: row.text.trim(), choices, correct_index: index });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/**
 * Housekeeping the floor needs whether or not a model is installed: expire
 * questions nobody solved inside the operator's window, and release locks
 * whose renter walked away (the KP they paid is not refunded — they rented
 * the time and got it).
 */
export async function sweepMarket(staleHours: number): Promise<{ expired: number; locksReleased: number }> {
  const now = new Date();
  const released = await db
    .update(questionLocksTable)
    .set({ released_at: now })
    .where(and(isNull(questionLocksTable.released_at), sql`${questionLocksTable.expires_at} <= ${now}`))
    .returning({ id: questionLocksTable.id });

  // A question whose lock just died goes back on the floor.
  if (released.length > 0) {
    await db
      .update(marketQuestionsTable)
      .set({ status: "open" })
      .where(
        and(
          eq(marketQuestionsTable.status, "locked"),
          sql`NOT EXISTS (
            SELECT 1 FROM question_locks l
            WHERE l.question_id = ${marketQuestionsTable.id} AND l.released_at IS NULL
          )`,
        ),
      );
  }

  const cutoff = new Date(Date.now() - Math.max(1, staleHours) * 3_600_000);
  const expired = await db
    .update(marketQuestionsTable)
    .set({ status: "expired" })
    .where(
      and(
        eq(marketQuestionsTable.status, "open"),
        sql`${marketQuestionsTable.released_at} <= ${cutoff}`,
        sql`(${marketQuestionsTable.expires_at} IS NULL OR ${marketQuestionsTable.expires_at} <= ${now})`,
      ),
    )
    .returning({ id: marketQuestionsTable.id });

  return { expired: expired.length, locksReleased: released.length };
}

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

let cycleInFlight = false;

export async function runMarketAgent(
  trigger: "schedule" | "manual" | "restock" = "schedule",
): Promise<RunSummary> {
  if (cycleInFlight) {
    throw new Error("market agent cycle already running");
  }
  cycleInFlight = true;
  const [run] = await db
    .insert(marketAgentRunsTable)
    .values({ trigger, status: "running" })
    .returning();
  const runId = run!.id;

  const summary: RunSummary = {
    run_id: runId,
    status: "ok",
    model: null,
    plan: [],
    generated: 0,
    accepted: 0,
    rejected: 0,
    expired: 0,
    locks_released: 0,
    notes: "",
  };

  try {
    const settings = await loadAgentSettings();
    const swept = await sweepMarket(settings.stale_hours);
    summary.expired = swept.expired;
    summary.locks_released = swept.locksReleased;

    if (!settings.enabled) {
      summary.notes = "agent disabled; swept only";
      await finishRun(runId, summary);
      return summary;
    }

    const floor = await readFloor();
    const plan = planMarket(settings, floor);
    summary.plan = plan;
    if (plan.length === 0) {
      summary.notes = `floor is stocked (${floor.totalOpen} open)`;
      await finishRun(runId, summary);
      return summary;
    }

    const reviewStatus = settings.human_review ? "pending" : "approved";
    let brainWorked = false;

    for (const item of plan) {
      const batch = await generateBatch(item);
      if (!batch) continue;
      brainWorked = true;
      summary.model ??= batch.model;
      summary.generated += batch.drafts.length;

      for (const draft of batch.drafts) {
        const ok = await verifyDraft(draft, item.subject);
        if (!ok) {
          summary.rejected += 1;
          continue;
        }
        const target = Math.max(1, settings.floor_per_subject);
        const inserted = await postQuestion({
          draft,
          subject: item.subject,
          topic: item.topic,
          difficulty: item.difficulty,
          model: batch.model,
          runId,
          reviewStatus,
          kp: priceQuestion(item.difficulty, floor.open.get(item.subject) ?? 0, target, settings),
        });
        if (inserted) {
          summary.accepted += 1;
          floor.open.set(item.subject, (floor.open.get(item.subject) ?? 0) + 1);
        } else {
          // Fingerprint clash — the agent already wrote this one.
          summary.rejected += 1;
        }
      }
    }

    if (!brainWorked) {
      // The brain is off or unreachable. Keep the floor alive from the
      // teachers' own quiz banks instead of posting nothing.
      const wanted = plan.reduce((n, p) => n + p.count, 0);
      const recycled = await recycleQuizQuestions(
        [...new Set(plan.map((p) => p.subject))],
        wanted,
      );
      for (const r of recycled) {
        const posted = await postQuestion({
          draft: r,
          subject: r.subject,
          topic: "teacher quiz bank",
          difficulty: "medium",
          model: null,
          runId,
          reviewStatus,
          kp: priceQuestion("medium", floor.open.get(r.subject) ?? 0, Math.max(1, settings.floor_per_subject), settings),
        });
        if (posted) summary.accepted += 1;
      }
      summary.generated += recycled.length;
      summary.status = summary.accepted > 0 ? "partial" : "failed";
      summary.notes =
        recycled.length > 0
          ? `brain unavailable — recycled ${summary.accepted} teacher quiz questions`
          : "brain unavailable and no teacher quiz questions to recycle";
    } else if (summary.accepted === 0) {
      summary.status = "partial";
      summary.notes = `every draft failed verification (${summary.rejected} rejected)`;
    } else {
      summary.notes = `posted ${summary.accepted}, rejected ${summary.rejected}`;
    }

    await finishRun(runId, summary);
    return summary;
  } catch (err) {
    summary.status = "failed";
    summary.notes = err instanceof Error ? err.message : String(err);
    await db
      .update(marketAgentRunsTable)
      .set({
        status: "failed",
        error: summary.notes,
        expired: summary.expired,
        locks_released: summary.locks_released,
        finished_at: new Date(),
      })
      .where(eq(marketAgentRunsTable.id, runId))
      .catch(() => undefined);
    throw err;
  } finally {
    cycleInFlight = false;
  }
}

async function finishRun(runId: number, s: RunSummary): Promise<void> {
  await db
    .update(marketAgentRunsTable)
    .set({
      status: s.status,
      model: s.model,
      plan: s.plan,
      generated: s.generated,
      accepted: s.accepted,
      rejected: s.rejected,
      expired: s.expired,
      locks_released: s.locks_released,
      notes: s.notes,
      finished_at: new Date(),
    })
    .where(eq(marketAgentRunsTable.id, runId));
}

async function postQuestion(args: {
  draft: DraftQuestion;
  subject: string;
  topic: string;
  difficulty: Difficulty;
  model: string | null;
  runId: number;
  reviewStatus: string;
  kp: number;
}): Promise<boolean> {
  const rows = await db
    .insert(marketQuestionsTable)
    .values({
      subject: args.subject,
      prompt: args.draft.prompt,
      choices: args.draft.choices,
      correct_index: args.draft.correct_index,
      kp_reward: args.kp,
      status: "open",
      topic: args.topic,
      difficulty: args.difficulty,
      source: "agent",
      model: args.model,
      agent_run_id: args.runId,
      explanation: args.draft.explanation ?? null,
      fingerprint: fingerprint(args.subject, args.draft.prompt),
      review_status: args.reviewStatus,
    })
    // The fingerprint unique index is the dedupe: a question the agent has
    // already written is silently skipped, not raised.
    .onConflictDoNothing({ target: marketQuestionsTable.fingerprint })
    .returning({ id: marketQuestionsTable.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Economy guard rails
// ---------------------------------------------------------------------------

/**
 * What the market has paid out recently. The operator console shows it
 * beside the agent's settings so a reward band that turns out to be too
 * generous is obvious before it has run for a term.
 */
export async function kpPayoutStats(): Promise<{
  paid_24h: number;
  paid_7d: number;
  open_liability: number;
}> {
  const sum = async (since: Date) => {
    const [row] = await db
      .select({ total: sql<number>`COALESCE(SUM(${kpLedgerTable.delta}), 0)::int` })
      .from(kpLedgerTable)
      .where(and(eq(kpLedgerTable.reason, "question_won"), gte(kpLedgerTable.created_at, since)));
    return row?.total ?? 0;
  };
  const [liability] = await db
    .select({ total: sql<number>`COALESCE(SUM(${marketQuestionsTable.kp_reward}), 0)::int` })
    .from(marketQuestionsTable)
    .where(
      and(
        sql`${marketQuestionsTable.status} IN ('open', 'locked')`,
        eq(marketQuestionsTable.review_status, "approved"),
      ),
    );
  return {
    paid_24h: await sum(new Date(Date.now() - 86_400_000)),
    paid_7d: await sum(new Date(Date.now() - 7 * 86_400_000)),
    open_liability: liability?.total ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let schedulerStarted = false;
let schedulerTimer: NodeJS.Timeout | null = null;

export function startMarketAgent(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const tick = async () => {
    let minutes = 15;
    try {
      const settings = await loadAgentSettings();
      minutes = settings.cycle_minutes;
      if (settings.enabled && minutes > 0) {
        const summary = await runMarketAgent("schedule");
        logger.info(
          {
            run_id: summary.run_id,
            accepted: summary.accepted,
            rejected: summary.rejected,
            expired: summary.expired,
          },
          "market agent cycle finished",
        );
      }
    } catch (err) {
      logger.error({ err }, "market agent cycle failed");
    } finally {
      // Re-read the interval every tick so an operator changing it in the
      // dashboard takes effect on the next cycle, not the next reboot.
      schedulerTimer = setTimeout(tick, Math.max(1, minutes || 15) * 60_000);
      schedulerTimer.unref();
    }
  };

  // First cycle a minute after boot: long enough for the database to be up,
  // short enough that a fresh install has a stocked market before assembly.
  schedulerTimer = setTimeout(tick, 60_000);
  schedulerTimer.unref();
  logger.info("market agent scheduler started");
}

export function stopMarketAgent(): void {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = null;
  schedulerStarted = false;
}
