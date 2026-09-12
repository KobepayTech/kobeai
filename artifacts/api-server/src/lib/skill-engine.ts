import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  markingFeedbackTable,
  pool,
  skillObservationsTable,
  skillsTable,
  studentSkillMasteryTable,
  usersTable,
  type Skill,
} from "@workspace/db";
import { brainJson } from "./kobe-brain";
import { entitlementFor } from "./entitlements";
import { logger } from "./logger";
import {
  ERROR_TYPES,
  SKILL_TAXONOMY,
  taxonomySize,
  type ErrorType,
  type SkillSeed,
} from "./skill-taxonomy";

// ===========================================================================
// The skill engine.
//
// K9 does not mark. The teacher marks, exactly as they always have, and this
// reads the marking they already did:
//
//   graded_paper_items ──► map to a skill      (keywords, then the model)
//                      ──► classify the error  (why the mark was lost)
//                      ──► skill_observations  (append-only evidence)
//                      ──► student_skill_mastery (decayed rolling score)
//
// Three rules hold throughout:
//
//   * **The teacher's mark is final.** Where a vision pass proposed something
//     different, the disagreement is recorded (marking_feedback) and the
//     teacher's number is what counts. Every time. That table is the only
//     honest measure of whether K9's reading matches what teachers accept.
//   * **The evidence is the truth.** `student_skill_mastery` is a cache;
//     delete it and `reindexAll()` rebuilds it from the observations.
//   * **It works with no model.** Keyword mapping and the deterministic error
//     rules cover the common case offline; the brain only sees what they
//     cannot place, and a school without one still gets a skill profile.
// ===========================================================================

const HALF_LIFE_DAYS = Number(process.env["SKILL_HALF_LIFE_DAYS"] ?? 60);
/** Effective observations at which confidence reaches ~95%. */
const CONFIDENCE_SATURATION = 3;
/** Below this, a skill is "weak" in the profile and the school-wide view. */
export const WEAK_THRESHOLD = 50;
export const STRONG_THRESHOLD = 75;

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

let seeded: Promise<void> | null = null;

/**
 * Put the taxonomy in the database. Additive and idempotent: a new skill
 * appears, an existing one keeps its id (and therefore every observation
 * already attached to it), and nothing is renamed under a student's feet.
 */
export function ensureSkillsSeeded(): Promise<void> {
  if (!seeded) {
    seeded = (async () => {
      let added = 0;
      for (const [subject, skills] of Object.entries(SKILL_TAXONOMY)) {
        for (const skill of skills as SkillSeed[]) {
          const rows = await db
            .insert(skillsTable)
            .values({
              subject,
              code: skill.code,
              name: skill.name,
              strand: skill.strand,
              form_level: skill.form_level ?? null,
              keywords: skill.keywords,
            })
            .onConflictDoNothing({ target: [skillsTable.subject, skillsTable.code] })
            .returning({ id: skillsTable.id });
          if (rows.length > 0) added += 1;
        }
      }
      if (added > 0) logger.info({ added, total: taxonomySize() }, "skill taxonomy seeded");
    })().catch((err) => {
      seeded = null;
      throw err;
    });
  }
  return seeded;
}

let skillCache: { at: number; skills: Skill[] } | null = null;
const SKILL_CACHE_MS = 60_000;

async function allSkills(): Promise<Skill[]> {
  if (skillCache && Date.now() - skillCache.at < SKILL_CACHE_MS) return skillCache.skills;
  await ensureSkillsSeeded();
  const skills = await db.select().from(skillsTable).where(eq(skillsTable.active, true));
  skillCache = { at: Date.now(), skills };
  return skills;
}

// ---------------------------------------------------------------------------
// Mapping a marked question to a skill
// ---------------------------------------------------------------------------

export type SkillMatch = {
  skill: Skill;
  mapped_by: "keyword" | "model" | "topic";
  confidence: number;
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Deterministic first pass. Scores each of the subject's skills by how many
 * of its keywords appear in the question text (and in whatever topic string
 * the marking pass wrote), longest keyword first because "balance the
 * equation" is worth more than "equation".
 *
 * Exported for the tests: this is the path that runs on a school with no
 * model box, and it is the one that has to be right.
 */
export function matchByKeyword(
  skills: Skill[],
  questionText: string,
  topicHint?: string | null,
): SkillMatch | null {
  const haystack = norm(`${questionText} ${topicHint ?? ""}`);
  if (haystack.length < 3) return null;

  let best: { skill: Skill; score: number } | null = null;
  let runnerUp = 0;
  for (const skill of skills) {
    const keywords = Array.isArray(skill.keywords) ? (skill.keywords as string[]) : [];
    let score = 0;
    for (const keyword of keywords) {
      const k = norm(String(keyword));
      if (!k || !haystack.includes(k)) continue;
      // A long, specific phrase is far stronger evidence than a single word
      // that half the syllabus shares.
      score += k.includes(" ") ? 3 : 1;
    }
    // The topic the marking pass wrote, when it names the skill outright.
    if (topicHint && norm(topicHint) === norm(skill.name)) score += 6;
    if (score === 0) continue;
    if (!best || score > best.score) {
      runnerUp = best?.score ?? 0;
      best = { skill, score };
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  if (!best) return null;
  // Two skills matching about equally means the keywords did not actually
  // discriminate — hand it to the model rather than guessing.
  if (runnerUp > 0 && best.score - runnerUp < 2) return null;
  return {
    skill: best.skill,
    mapped_by: "keyword",
    confidence: Math.min(90, 40 + best.score * 10),
  };
}

const MAPPER_SYSTEM =
  "You classify Tanzanian secondary-school exam questions by the syllabus skill " +
  "they test. You only ever answer with a code from the list you are given. " +
  "Output JSON only.";

/**
 * Model fallback, with the taxonomy as a closed vocabulary. The model picks a
 * code from the list or returns null — it cannot invent a skill, so it cannot
 * drift the taxonomy over a term.
 */
async function matchByModel(
  skills: Skill[],
  questionText: string,
  subject: string,
): Promise<SkillMatch | null> {
  if (skills.length === 0 || questionText.trim().length < 8) return null;
  const menu = skills.map((s) => `${s.code} = ${s.name}`).join("\n");
  const out = await brainJson<{ code?: unknown; confidence?: unknown }>(
    `Which ${subject} skill does this exam question test?\n\n` +
      `QUESTION: ${questionText.slice(0, 600)}\n\n` +
      `Choose exactly one code from this list, or null if none fits:\n${menu}\n\n` +
      `Return {"code":"<code or null>","confidence":0-100}`,
    { tag: "skill-engine:map", system: MAPPER_SYSTEM, maxTokens: 200, temperature: 0 },
  );
  const code = String(out?.value?.code ?? "").trim();
  const skill = skills.find((s) => s.code === code);
  if (!skill) return null;
  const confidence = Number(out?.value?.confidence);
  return {
    skill,
    mapped_by: "model",
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(85, Math.round(confidence))) : 60,
  };
}

// Questions repeat across a class set — thirty papers, the same twenty
// questions. Cache by subject+text so one class costs twenty model calls, not
// six hundred.
const mapCache = new Map<string, SkillMatch | null>();
const MAP_CACHE_MAX = 5000;

export async function mapToSkill(
  subject: string | null,
  questionText: string,
  topicHint?: string | null,
  useModel = true,
): Promise<SkillMatch | null> {
  const skills = await allSkills();
  const scoped = subject ? skills.filter((s) => s.subject === subject) : skills;
  if (scoped.length === 0) return null;

  const key = `${subject ?? "*"}|${norm(questionText)}|${norm(topicHint ?? "")}`;
  if (mapCache.has(key)) return mapCache.get(key)!;

  let match = matchByKeyword(scoped, questionText, topicHint);
  if (!match && useModel) match = await matchByModel(scoped, questionText, subject ?? "this subject");

  if (mapCache.size >= MAP_CACHE_MAX) mapCache.clear();
  mapCache.set(key, match);
  return match;
}

// ---------------------------------------------------------------------------
// Why the mark was lost
// ---------------------------------------------------------------------------

export type ItemForClassification = {
  question_text?: string | null;
  student_answer?: string | null;
  expected_answer?: string | null;
  is_correct: boolean;
  marks_awarded?: number | null;
  marks_possible?: number | null;
};

/**
 * The deterministic part of error classification — the cases that need no
 * model and must never be got wrong.
 *
 * Returns undefined when the answer needs real judgement, which is when the
 * model runs. Exported for the tests.
 */
export function classifyErrorRules(item: ItemForClassification): ErrorType | null | undefined {
  const awarded = item.marks_awarded ?? null;
  const possible = item.marks_possible ?? null;
  const answer = (item.student_answer ?? "").trim();

  // Full marks, or a tick with no mark scheme: nothing was lost.
  if (item.is_correct && (possible == null || awarded == null || awarded >= possible)) return null;
  if (possible != null && awarded != null && awarded >= possible) return null;

  // Nothing written is never a "concept" error — it is a blank, and a teacher
  // reading "concept not understood" against an unattempted question would
  // rightly stop trusting the profile.
  if (!answer || /^[-–—.]+$/.test(answer)) return "unanswered";

  return undefined;
}

const CLASSIFIER_SYSTEM =
  "You are a Tanzanian secondary-school teacher explaining, in one word, why a " +
  "student lost marks on a question you have already marked. Output JSON only.";

/**
 * Classify one lost mark. Rules first, model second, `concept` as the last
 * resort — a wrong answer we cannot explain is still worth recording against
 * the skill, because the mastery score is what drives the profile and the
 * error type only sharpens it.
 */
export async function classifyError(
  item: ItemForClassification,
  useModel = true,
): Promise<ErrorType | null> {
  const ruled = classifyErrorRules(item);
  if (ruled !== undefined) return ruled;
  if (!useModel) {
    // No model pass for this student: fall straight to the same default the
    // model path uses when it cannot decide. The observation is still
    // recorded, so subscribing later and reindexing fills in the detail.
    return (item.marks_awarded ?? 0) > 0 ? "incomplete" : "concept";
  }

  const out = await brainJson<{ error_type?: unknown }>(
    `A teacher marked this answer and took marks off. Say why.\n\n` +
      `QUESTION: ${(item.question_text ?? "").slice(0, 400)}\n` +
      `STUDENT WROTE: ${(item.student_answer ?? "").slice(0, 400)}\n` +
      `EXPECTED: ${(item.expected_answer ?? "not given").slice(0, 400)}\n` +
      `MARKS: ${item.marks_awarded ?? 0} of ${item.marks_possible ?? "?"}\n\n` +
      `Return {"error_type":"<one of: ${ERROR_TYPES.join(", ")}>"}\n` +
      `- calculation: right method, arithmetic slip\n` +
      `- careless: knew it, mis-read or mis-copied\n` +
      `- incomplete: correct as far as it goes, stopped early\n` +
      `- concept: has not understood the idea`,
    { tag: "skill-engine:classify", system: CLASSIFIER_SYSTEM, maxTokens: 120, temperature: 0 },
  );
  const value = String(out?.value?.error_type ?? "").trim().toLowerCase();
  if ((ERROR_TYPES as readonly string[]).includes(value)) return value as ErrorType;

  // Partial credit with no better explanation is "incomplete" far more often
  // than it is anything else; a bare cross defaults to concept.
  const awarded = item.marks_awarded ?? 0;
  return awarded > 0 ? "incomplete" : "concept";
}

// ---------------------------------------------------------------------------
// Mastery
// ---------------------------------------------------------------------------

export type Observation = { ratio: number; observed_at: Date; error_type?: string | null };

export type MasteryResult = {
  mastery: number;
  confidence: number;
  trend: number;
  attempts: number;
  dominant_error: string | null;
  last_seen_at: Date | null;
};

/**
 * Turn a skill's evidence into a score.
 *
 * Time-decayed so this week's work outweighs last term's: a student who has
 * fixed their fractions should not carry October's failures into February.
 * The half-life is `SKILL_HALF_LIFE_DAYS` (60 by default — roughly a term).
 *
 *   mastery    weighted mean of the per-question mark ratios, 0-100
 *   confidence how much evidence is behind it, so a teacher can tell a hint
 *              from a diagnosis. One question is never a diagnosis.
 *   trend      recent half minus older half, in points. Improving or not.
 *
 * Pure and exported, so the arithmetic is tested without a database.
 */
export function computeMastery(observations: Observation[], now = new Date()): MasteryResult {
  if (observations.length === 0) {
    return { mastery: 0, confidence: 0, trend: 0, attempts: 0, dominant_error: null, last_seen_at: null };
  }
  const sorted = [...observations].sort(
    (a, b) => a.observed_at.getTime() - b.observed_at.getTime(),
  );

  const weightOf = (at: Date) => {
    const ageDays = Math.max(0, (now.getTime() - at.getTime()) / 86_400_000);
    return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  };

  let weighted = 0;
  let weight = 0;
  for (const o of sorted) {
    const w = weightOf(o.observed_at);
    weighted += w * clamp(o.ratio);
    weight += w;
  }
  const mastery = weight > 0 ? Math.round(weighted / weight) : 0;

  // Effective evidence, not raw count: three fresh questions are worth more
  // than three from a year ago, and the confidence should say so.
  const confidence = Math.round(100 * (1 - Math.exp(-weight / CONFIDENCE_SATURATION)));

  // Trend needs two halves with something in each; below four observations
  // there is no trend worth reporting, only noise.
  let trend = 0;
  if (sorted.length >= 4) {
    const mid = Math.floor(sorted.length / 2);
    const older = mean(sorted.slice(0, mid).map((o) => clamp(o.ratio)));
    const recent = mean(sorted.slice(mid).map((o) => clamp(o.ratio)));
    trend = Math.round(recent - older);
  }

  // The most common reason marks were lost, weighted the same way — "they
  // keep dropping the arithmetic" is a different lesson from "they have never
  // understood it".
  const errorWeights = new Map<string, number>();
  for (const o of sorted) {
    if (!o.error_type) continue;
    errorWeights.set(o.error_type, (errorWeights.get(o.error_type) ?? 0) + weightOf(o.observed_at));
  }
  const dominant = [...errorWeights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    mastery,
    confidence: Math.max(0, Math.min(100, confidence)),
    trend,
    attempts: sorted.length,
    dominant_error: dominant,
    last_seen_at: sorted[sorted.length - 1]!.observed_at,
  };
}

/**
 * What to work on next. Weak *and* well-evidenced ranks above weak-and-
 * uncertain: sending a teacher after a 20% built on one question wastes the
 * intervention that a 43% built on nine would have earned.
 */
export function priorityScore(m: { mastery: number; confidence: number; trend: number }): number {
  const gap = Math.max(0, WEAK_THRESHOLD + 20 - m.mastery);
  const evidence = m.confidence / 100;
  // A student already climbing needs less help than one standing still at the
  // same score, so improvement discounts the priority rather than hiding it.
  const momentum = m.trend > 10 ? 0.7 : m.trend < -10 ? 1.2 : 1;
  return Math.round(gap * evidence * momentum);
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Recompute one (student, skill) pair from its evidence and cache it. */
export async function recomputeMastery(studentId: number, skillId: number): Promise<void> {
  const rows = await db
    .select({
      ratio: skillObservationsTable.ratio,
      observed_at: skillObservationsTable.observed_at,
      error_type: skillObservationsTable.error_type,
      marks_awarded: skillObservationsTable.marks_awarded,
      marks_possible: skillObservationsTable.marks_possible,
    })
    .from(skillObservationsTable)
    .where(
      and(
        eq(skillObservationsTable.student_id, studentId),
        eq(skillObservationsTable.skill_id, skillId),
      ),
    );
  if (rows.length === 0) {
    await db
      .delete(studentSkillMasteryTable)
      .where(
        and(
          eq(studentSkillMasteryTable.student_id, studentId),
          eq(studentSkillMasteryTable.skill_id, skillId),
        ),
      );
    return;
  }
  const result = computeMastery(rows);
  const marksAwarded = rows.reduce((n, r) => n + (r.marks_awarded ?? 0), 0);
  const marksPossible = rows.reduce((n, r) => n + (r.marks_possible ?? 0), 0);
  await db
    .insert(studentSkillMasteryTable)
    .values({
      student_id: studentId,
      skill_id: skillId,
      mastery: result.mastery,
      confidence: result.confidence,
      trend: result.trend,
      attempts: result.attempts,
      marks_awarded: marksAwarded,
      marks_possible: marksPossible,
      dominant_error: result.dominant_error,
      last_seen_at: result.last_seen_at,
    })
    .onConflictDoUpdate({
      target: [studentSkillMasteryTable.student_id, studentSkillMasteryTable.skill_id],
      set: {
        mastery: result.mastery,
        confidence: result.confidence,
        trend: result.trend,
        attempts: result.attempts,
        marks_awarded: marksAwarded,
        marks_possible: marksPossible,
        dominant_error: result.dominant_error,
        last_seen_at: result.last_seen_at,
        updated_at: new Date(),
      },
    });
}

// ---------------------------------------------------------------------------
// Ingest: a marked paper becomes evidence
// ---------------------------------------------------------------------------

export type IngestResult = {
  items: number;
  mapped: number;
  unmapped: number;
  skills_touched: number;
  disagreements: number;
};

/**
 * Read one marked paper into the skill profile. Called straight after the
 * lens posts it; safe to re-run (the unique index on paper_item_id means a
 * re-index updates rather than double-counts).
 *
 * `metadata.ai_is_correct` / `metadata.ai_marks_awarded` on an item, when the
 * marking pass proposed something, are compared with what the teacher
 * actually recorded. The teacher's value is used — always — and any
 * difference is written to marking_feedback.
 */
export async function ingestGradedPaper(paperId: number): Promise<IngestResult> {
  await ensureSkillsSeeded();

  const { rows: paperRows } = await pool.query(
    `SELECT id, student_code, subject FROM graded_papers WHERE id = $1`,
    [paperId],
  );
  const paper = paperRows[0];
  if (!paper) return { items: 0, mapped: 0, unmapped: 0, skills_touched: 0, disagreements: 0 };

  const [student] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.student_code, String(paper.student_code)))
    .limit(1);
  if (!student) return { items: 0, mapped: 0, unmapped: 0, skills_touched: 0, disagreements: 0 };

  // Deep analysis is the subscribed tier, and it is the part that costs real
  // GPU time — a thousand-student school is a lot of model calls. So for an
  // unsubscribed student the evidence is still recorded (keyword mapping and
  // the deterministic error rules are free), but no model runs. Subscribing
  // later and reindexing fills in everything that was skipped, which is why
  // this records rather than discards.
  const entitlement = await entitlementFor(String(paper.student_code));
  const useModel = entitlement.entitled;

  const { rows: items } = await pool.query(
    `SELECT id, question_number, question_text, question_topic, student_answer,
            expected_answer, is_correct, marks_awarded, marks_possible, metadata
       FROM graded_paper_items WHERE paper_id = $1 ORDER BY question_number NULLS LAST, id`,
    [paperId],
  );

  const subject: string | null = paper.subject ?? null;
  const touched = new Set<number>();
  let mapped = 0;
  let disagreements = 0;

  for (const item of items as Array<Record<string, unknown>>) {
    const isCorrect = Boolean(item["is_correct"]);
    const awarded = item["marks_awarded"] == null ? null : Number(item["marks_awarded"]);
    const possible = item["marks_possible"] == null ? null : Number(item["marks_possible"]);
    const questionText = String(item["question_text"] ?? "");
    const topicHint = item["question_topic"] == null ? null : String(item["question_topic"]);

    // Part marks are the whole point: "nearly right" and "no idea" are
    // different diagnoses, and a tick/cross alone throws that away.
    const ratio =
      possible && possible > 0 && awarded != null
        ? clamp((awarded / possible) * 100)
        : isCorrect
          ? 100
          : 0;

    const match = await mapToSkill(subject, questionText, topicHint, useModel);
    const errorType =
      ratio >= 100
        ? null
        : await classifyError(
            {
              question_text: questionText,
              student_answer: item["student_answer"] == null ? null : String(item["student_answer"]),
              expected_answer: item["expected_answer"] == null ? null : String(item["expected_answer"]),
              is_correct: isCorrect,
              marks_awarded: awarded,
              marks_possible: possible,
            },
            useModel,
          );

    await db
      .insert(skillObservationsTable)
      .values({
        student_id: student.id,
        skill_id: match?.skill.id ?? null,
        paper_item_id: Number(item["id"]),
        paper_id: paperId,
        source: "paper",
        ratio,
        marks_awarded: awarded,
        marks_possible: possible,
        error_type: errorType,
        mapped_by: match?.mapped_by ?? "topic",
        map_confidence: match?.confidence ?? null,
      })
      .onConflictDoUpdate({
        target: skillObservationsTable.paper_item_id,
        set: {
          skill_id: match?.skill.id ?? null,
          ratio,
          marks_awarded: awarded,
          marks_possible: possible,
          error_type: errorType,
          mapped_by: match?.mapped_by ?? "topic",
          map_confidence: match?.confidence ?? null,
        },
      });

    if (match) {
      mapped += 1;
      touched.add(match.skill.id);
    }

    // Teacher authority: what K9 proposed against what the teacher decided.
    const meta = (item["metadata"] ?? {}) as Record<string, unknown>;
    const aiCorrect = typeof meta["ai_is_correct"] === "boolean" ? (meta["ai_is_correct"] as boolean) : null;
    const aiMarks = meta["ai_marks_awarded"] == null ? null : Number(meta["ai_marks_awarded"]);
    if (aiCorrect !== null || aiMarks !== null) {
      const agreed =
        (aiCorrect === null || aiCorrect === isCorrect) &&
        (aiMarks === null || awarded === null || aiMarks === awarded);
      if (!agreed) disagreements += 1;
      await db.insert(markingFeedbackTable).values({
        paper_item_id: Number(item["id"]),
        paper_id: paperId,
        student_id: student.id,
        skill_id: match?.skill.id ?? null,
        subject,
        ai_is_correct: aiCorrect,
        ai_marks_awarded: aiMarks,
        teacher_is_correct: isCorrect,
        teacher_marks_awarded: awarded,
        marks_possible: possible,
        agreed,
        question_text: questionText.slice(0, 1000),
        student_answer: item["student_answer"] == null ? null : String(item["student_answer"]).slice(0, 1000),
      });
    }
  }

  for (const skillId of touched) {
    await recomputeMastery(student.id, skillId);
  }

  logger.info(
    { paperId, items: items.length, mapped, skills: touched.size, disagreements, deep: useModel },
    "graded paper folded into the skill profile",
  );
  return {
    items: items.length,
    mapped,
    unmapped: items.length - mapped,
    skills_touched: touched.size,
    disagreements,
  };
}

/** Rebuild every mastery row from the evidence. The cache is disposable. */
export async function reindexAll(): Promise<{ papers: number }> {
  const { rows } = await pool.query(`SELECT id FROM graded_papers ORDER BY id`);
  let done = 0;
  for (const row of rows as Array<{ id: number }>) {
    await ingestGradedPaper(Number(row.id)).catch((err) =>
      logger.warn({ err, paperId: row.id }, "reindex skipped a paper"),
    );
    done += 1;
  }
  return { papers: done };
}

// ---------------------------------------------------------------------------
// Reading the profile
// ---------------------------------------------------------------------------

export type SkillRow = {
  skill_id: number;
  code: string;
  name: string;
  subject: string;
  strand: string | null;
  mastery: number;
  confidence: number;
  trend: number;
  attempts: number;
  dominant_error: string | null;
  last_seen_at: Date | null;
  priority: number;
};

export type StudentSkillProfile = {
  student: { id: number; name: string; student_code: string | null; grade: string | null };
  subjects: Array<{
    subject: string;
    average: number;
    skills: SkillRow[];
  }>;
  priority: SkillRow[];
};

export async function studentSkillProfile(studentCode: string): Promise<StudentSkillProfile | null> {
  await ensureSkillsSeeded();
  const [student] = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      student_code: usersTable.student_code,
      grade: usersTable.grade,
    })
    .from(usersTable)
    .where(and(eq(usersTable.role, "student"), eq(usersTable.student_code, studentCode)))
    .limit(1);
  if (!student) return null;

  const rows = await db
    .select({
      skill_id: skillsTable.id,
      code: skillsTable.code,
      name: skillsTable.name,
      subject: skillsTable.subject,
      strand: skillsTable.strand,
      mastery: studentSkillMasteryTable.mastery,
      confidence: studentSkillMasteryTable.confidence,
      trend: studentSkillMasteryTable.trend,
      attempts: studentSkillMasteryTable.attempts,
      dominant_error: studentSkillMasteryTable.dominant_error,
      last_seen_at: studentSkillMasteryTable.last_seen_at,
    })
    .from(studentSkillMasteryTable)
    .innerJoin(skillsTable, eq(skillsTable.id, studentSkillMasteryTable.skill_id))
    .where(eq(studentSkillMasteryTable.student_id, student.id));

  const skills: SkillRow[] = rows.map((r) => ({ ...r, priority: priorityScore(r) }));

  const bySubject = new Map<string, SkillRow[]>();
  for (const s of skills) {
    const list = bySubject.get(s.subject) ?? [];
    list.push(s);
    bySubject.set(s.subject, list);
  }

  return {
    student,
    subjects: [...bySubject.entries()]
      .map(([subject, list]) => ({
        subject,
        average: Math.round(mean(list.map((s) => s.mastery))),
        skills: list.sort((a, b) => a.mastery - b.mastery),
      }))
      .sort((a, b) => a.subject.localeCompare(b.subject)),
    // What this student needs next, in order. The whole point of modelling
    // skills instead of subjects.
    priority: skills
      .filter((s) => s.mastery < WEAK_THRESHOLD && s.confidence >= 30)
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 5),
  };
}

/**
 * The school's OWN record of a student, with no K9 analysis in it: the
 * subject averages that come straight off exams the teachers marked.
 *
 * This is the baseline tier — it is never withheld from anyone, paid or not,
 * because it is the school's record of its own pupil and not a KobeAI
 * product. It is also what a locked profile shows instead of a blank page:
 * "48% in Mathematics" stays visible, and the subscription is what adds the
 * answer to *why* 48%.
 */
export async function baselineSubjectMarks(
  studentCode: string,
): Promise<Array<{ subject: string; average: number; exams: number; latest_percent: number | null }>> {
  const { rows } = await pool.query(
    `SELECT e.subject,
            ROUND(AVG(r.percent))::int AS average,
            COUNT(*)::int             AS exams,
            (ARRAY_AGG(ROUND(r.percent)::int ORDER BY r.recorded_at DESC))[1] AS latest_percent
       FROM exam_results r
       JOIN result_exams e ON e.id = r.exam_id
       JOIN users u        ON u.id = r.student_id
      WHERE u.student_code = $1
      GROUP BY e.subject
      ORDER BY e.subject`,
    [studentCode],
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    subject: String(r["subject"]),
    average: Number(r["average"] ?? 0),
    exams: Number(r["exams"] ?? 0),
    latest_percent: r["latest_percent"] == null ? null : Number(r["latest_percent"]),
  }));
}

export type SkillGap = {
  skill_id: number;
  code: string;
  name: string;
  subject: string;
  strand: string | null;
  students: number;
  struggling: number;
  share: number; // 0-100
  average: number;
};

/**
 * The head teacher's view: which skills is a whole form failing?
 *
 * "68% of Form 3 are below half on simultaneous equations" is a remedial
 * lesson someone can timetable next week. A list of 180 individual scores is
 * not.
 */
export async function schoolSkillGaps(opts: {
  formLevel?: string | null;
  subject?: string | null;
  minStudents?: number;
} = {}): Promise<SkillGap[]> {
  await ensureSkillsSeeded();
  const minStudents = opts.minStudents ?? 3;

  const rows = await db
    .select({
      skill_id: skillsTable.id,
      code: skillsTable.code,
      name: skillsTable.name,
      subject: skillsTable.subject,
      strand: skillsTable.strand,
      students: sql<number>`count(*)::int`,
      struggling: sql<number>`count(*) FILTER (WHERE ${studentSkillMasteryTable.mastery} < ${WEAK_THRESHOLD})::int`,
      average: sql<number>`round(avg(${studentSkillMasteryTable.mastery}))::int`,
    })
    .from(studentSkillMasteryTable)
    .innerJoin(skillsTable, eq(skillsTable.id, studentSkillMasteryTable.skill_id))
    .innerJoin(usersTable, eq(usersTable.id, studentSkillMasteryTable.student_id))
    .where(
      and(
        eq(usersTable.role, "student"),
        opts.formLevel ? eq(usersTable.grade, opts.formLevel) : sql`true`,
        opts.subject ? eq(skillsTable.subject, opts.subject) : sql`true`,
        // A score nobody has any evidence for should not drive a whole
        // form's remedial timetable.
        sql`${studentSkillMasteryTable.confidence} >= 30`,
      ),
    )
    .groupBy(skillsTable.id)
    .having(sql`count(*) >= ${minStudents}`);

  return rows
    .map((r) => ({ ...r, share: Math.round((r.struggling / Math.max(1, r.students)) * 100) }))
    .sort((a, b) => b.share - a.share || b.struggling - a.struggling);
}

export type AgreementReport = {
  total: number;
  agreed: number;
  agreement_rate: number;
  by_subject: Array<{ subject: string | null; total: number; agreed: number; rate: number }>;
  recent_disagreements: Array<{
    subject: string | null;
    question_text: string | null;
    student_answer: string | null;
    ai_marks_awarded: number | null;
    teacher_marks_awarded: number | null;
    marks_possible: number | null;
    created_at: Date;
  }>;
};

/**
 * How often K9's reading of an answer matched what the teacher actually
 * awarded. This is the number that would have to be very high, for a long
 * time, before anyone should even discuss letting K9 mark anything itself —
 * and publishing it is what keeps that conversation honest.
 */
export async function teacherAgreement(): Promise<AgreementReport> {
  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      agreed: sql<number>`count(*) FILTER (WHERE ${markingFeedbackTable.agreed})::int`,
    })
    .from(markingFeedbackTable);

  const bySubject = await db
    .select({
      subject: markingFeedbackTable.subject,
      total: sql<number>`count(*)::int`,
      agreed: sql<number>`count(*) FILTER (WHERE ${markingFeedbackTable.agreed})::int`,
    })
    .from(markingFeedbackTable)
    .groupBy(markingFeedbackTable.subject);

  const recent = await db
    .select({
      subject: markingFeedbackTable.subject,
      question_text: markingFeedbackTable.question_text,
      student_answer: markingFeedbackTable.student_answer,
      ai_marks_awarded: markingFeedbackTable.ai_marks_awarded,
      teacher_marks_awarded: markingFeedbackTable.teacher_marks_awarded,
      marks_possible: markingFeedbackTable.marks_possible,
      created_at: markingFeedbackTable.created_at,
    })
    .from(markingFeedbackTable)
    .where(eq(markingFeedbackTable.agreed, false))
    .orderBy(desc(markingFeedbackTable.created_at))
    .limit(20);

  const total = totals?.total ?? 0;
  return {
    total,
    agreed: totals?.agreed ?? 0,
    agreement_rate: total > 0 ? Math.round(((totals?.agreed ?? 0) / total) * 100) : 0,
    by_subject: bySubject.map((s) => ({
      ...s,
      rate: s.total > 0 ? Math.round((s.agreed / s.total) * 100) : 0,
    })),
    recent_disagreements: recent,
  };
}

/** Questions the mapper could not place — the taxonomy's own to-do list. */
export async function unmappedQuestions(limit = 50) {
  const rows = await db
    .select({
      paper_item_id: skillObservationsTable.paper_item_id,
      observed_at: skillObservationsTable.observed_at,
    })
    .from(skillObservationsTable)
    .where(sql`${skillObservationsTable.skill_id} IS NULL`)
    .orderBy(desc(skillObservationsTable.observed_at))
    .limit(limit);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.paper_item_id).filter((id): id is number => id != null);
  if (ids.length === 0) return [];
  const { rows: items } = await pool.query(
    `SELECT i.id, i.question_text, i.question_topic, p.subject
       FROM graded_paper_items i
       JOIN graded_papers p ON p.id = i.paper_id
      WHERE i.id = ANY($1::int[])`,
    [ids],
  );
  return items;
}

export async function skillTaxonomy(): Promise<Skill[]> {
  return allSkills();
}

/** Mastery for a set of students on one skill — the class drill-down. */
export async function skillCohort(skillId: number, formLevel?: string | null) {
  return db
    .select({
      student_id: usersTable.id,
      name: usersTable.name,
      student_code: usersTable.student_code,
      grade: usersTable.grade,
      mastery: studentSkillMasteryTable.mastery,
      confidence: studentSkillMasteryTable.confidence,
      trend: studentSkillMasteryTable.trend,
      dominant_error: studentSkillMasteryTable.dominant_error,
    })
    .from(studentSkillMasteryTable)
    .innerJoin(usersTable, eq(usersTable.id, studentSkillMasteryTable.student_id))
    .where(
      and(
        eq(studentSkillMasteryTable.skill_id, skillId),
        formLevel ? eq(usersTable.grade, formLevel) : sql`true`,
      ),
    )
    .orderBy(studentSkillMasteryTable.mastery);
}

/** Skill ids by code, for callers that want to talk in codes. */
export async function skillsByCode(codes: string[]): Promise<Map<string, Skill>> {
  if (codes.length === 0) return new Map();
  const rows = await db.select().from(skillsTable).where(inArray(skillsTable.code, codes));
  return new Map(rows.map((r) => [r.code, r]));
}
