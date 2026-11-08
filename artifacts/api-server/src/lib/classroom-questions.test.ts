// node --import tsx --test artifacts/api-server/src/lib/classroom-questions.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// skill-engine imports @workspace/db, which refuses to load without a
// DATABASE_URL. `pg.Pool` does not dial until the first query, so a dummy URL
// is enough to exercise the priority arithmetic with no database in sight.
process.env["DATABASE_URL"] ??= "postgres://test:test@127.0.0.1:5432/test";

type Engine = typeof import("./skill-engine");
let engine: Engine;

before(async () => {
  engine = await import("./skill-engine");
});

// ---------------------------------------------------------------------------
// The boundary this whole feature rests on.
//
// A marked paper is evidence of what a student can DO. A spoken question is
// evidence of what they are THINKING ABOUT. Adding them together inverts the
// measurement: the most curious child in the room asks the most questions and
// would score weakest, while a lost, silent one would look fine.
// ---------------------------------------------------------------------------

/** The file with comments removed, so a guard checks code and not prose. */
function codeOf(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("the classroom-question path never writes to skill_observations", () => {
  // Mastery is the teacher's alone. If someone ever wires questions into the
  // observations table, mastery silently starts measuring curiosity — which no
  // test of the arithmetic would catch, because the arithmetic stays correct.
  const code = codeOf("skill-engine.ts");
  const start = code.indexOf("export const QUESTION_WINDOW_DAYS");
  assert.ok(start > 0, "the classroom-questions code should be findable");
  const section = code.slice(start);
  assert.ok(
    !/skill_observations|skillObservationsTable/.test(section),
    "classroom questions must never reach skill_observations, which feeds mastery",
  );
  assert.ok(
    section.includes("classroom_skill_questions"),
    "classroom questions belong in their own table",
  );
});

test("recomputeMastery reads observations only", () => {
  const source = codeOf("skill-engine.ts");
  const start = source.indexOf("export async function recomputeMastery");
  assert.ok(start > 0);
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.ok(
    !body.includes("classroom_skill_questions"),
    "a question must not be able to move a mastery score",
  );
});

// ---------------------------------------------------------------------------
// What a question IS allowed to do: break ties on what to teach next.
// ---------------------------------------------------------------------------

test("asking about a weak skill raises its priority", () => {
  const silent = engine.priorityScore({
    mastery: 40,
    confidence: 90,
    trend: 0,
  });
  const asked = engine.priorityScore({
    mastery: 40,
    confidence: 90,
    trend: 0,
    recent_questions: 2,
  });
  assert.ok(
    asked > silent,
    "a topic they asked about is the one they are ready to hear",
  );
});

test("asking cannot invent priority where the marking shows none", () => {
  // A strong student asking about a skill is being curious, not struggling.
  // Curiosity multiplies the gap rather than adding to it, so no number of
  // questions can turn mastery of 95 into a reason to reteach.
  for (const questions of [0, 1, 3, 50]) {
    assert.equal(
      engine.priorityScore({
        mastery: 95,
        confidence: 100,
        trend: 0,
        recent_questions: questions,
      }),
      0,
      `${questions} questions about a mastered skill is curiosity, not need`,
    );
  }
});

test("the lift is bounded, so one talkative child cannot dominate the list", () => {
  const three = engine.priorityScore({
    mastery: 40,
    confidence: 90,
    trend: 0,
    recent_questions: 3,
  });
  const thirty = engine.priorityScore({
    mastery: 40,
    confidence: 90,
    trend: 0,
    recent_questions: 30,
  });
  assert.equal(three, thirty, "questions beyond a few add nothing");
  const silent = engine.priorityScore({
    mastery: 40,
    confidence: 90,
    trend: 0,
  });
  assert.ok(
    three <= silent * 1.6,
    "curiosity adjusts the ranking, it does not rewrite it",
  );
});

test("questions never outrank a genuinely weaker skill", () => {
  // The teacher's marking still decides. A skill at 20% nobody asked about is
  // more urgent than a skill at 55% three children asked about.
  const weakAndSilent = engine.priorityScore({
    mastery: 20,
    confidence: 90,
    trend: 0,
  });
  const middlingAndAsked = engine.priorityScore({
    mastery: 55,
    confidence: 90,
    trend: 0,
    recent_questions: 3,
  });
  assert.ok(weakAndSilent > middlingAndAsked);
});

test("omitting recent_questions changes nothing for existing callers", () => {
  assert.equal(
    engine.priorityScore({ mastery: 43, confidence: 95, trend: 0 }),
    engine.priorityScore({
      mastery: 43,
      confidence: 95,
      trend: 0,
      recent_questions: 0,
    }),
  );
});

test("a negative or nonsense question count cannot lower priority", () => {
  const base = engine.priorityScore({ mastery: 40, confidence: 90, trend: 0 });
  assert.equal(
    engine.priorityScore({
      mastery: 40,
      confidence: 90,
      trend: 0,
      recent_questions: -5,
    }),
    base,
  );
});
