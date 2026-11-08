// node --import tsx --test artifacts/api-server/src/lib/skill-engine.test.ts
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { SKILL_TAXONOMY, taxonomySize } from "./skill-taxonomy";

// skill-engine imports @workspace/db, which refuses to load without a
// DATABASE_URL. `pg.Pool` does not dial until the first query, so a dummy URL
// is enough to exercise the mapping, error rules and mastery arithmetic with
// no database anywhere near the test.
process.env["DATABASE_URL"] ??= "postgres://test:test@127.0.0.1:5432/test";

type Engine = typeof import("./skill-engine");
let engine: Engine;

before(async () => {
  engine = await import("./skill-engine");
});

// A stand-in for the rows `skills` holds, built straight from the taxonomy so
// the tests exercise the shipped keywords rather than invented ones.
function skillsFor(subject: string) {
  return (SKILL_TAXONOMY[subject] ?? []).map((s, i) => ({
    id: i + 1,
    subject,
    code: s.code,
    name: s.name,
    strand: s.strand,
    form_level: null,
    syllabus_ref: null,
    keywords: s.keywords,
    active: true,
    created_at: new Date(),
  }));
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

// ---------------------------------------------------------------------------
// The taxonomy
// ---------------------------------------------------------------------------

test("every skill code is globally unique", () => {
  const codes = Object.values(SKILL_TAXONOMY).flatMap((list) => list.map((s) => s.code));
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(taxonomySize() > 50, "the taxonomy should cover the O-level core");
});

test("every skill carries keywords the offline mapper can use", () => {
  for (const [subject, skills] of Object.entries(SKILL_TAXONOMY)) {
    for (const skill of skills) {
      assert.ok(skill.keywords.length > 0, `${subject}/${skill.code} has no keywords`);
      assert.ok(skill.strand, `${subject}/${skill.code} has no strand`);
    }
  }
});

// ---------------------------------------------------------------------------
// Mapping a question to a skill
// ---------------------------------------------------------------------------

test("the offline mapper places the questions from the brief", () => {
  const chem = skillsFor("Chemistry");
  const maths = skillsFor("Mathematics");
  const geo = skillsFor("Geography");

  assert.equal(
    engine.matchByKeyword(chem, "Balance the equation: Fe + O2 -> Fe2O3")?.skill.code,
    "CHEM.REACT.BALANCE",
  );
  assert.equal(
    engine.matchByKeyword(maths, "Make x the subject of the formula v = u + at")?.skill.code,
    "MATH.ALG.REARRANGE",
  );
  assert.equal(
    engine.matchByKeyword(maths, "Read from the graph the value of y when x = 3")?.skill.code,
    "MATH.DATA.GRAPHS",
  );
  assert.equal(
    engine.matchByKeyword(geo, "Give the six-figure grid reference of the school on the map")?.skill.code,
    "GEO.SKILL.MAPS",
  );
});

test("a multi-word phrase outweighs a single shared word", () => {
  const chem = skillsFor("Chemistry");
  // "equation" alone appears in several skills; "balance the equation" does not.
  const match = engine.matchByKeyword(chem, "Balance the equation and give state symbols");
  assert.equal(match?.skill.code, "CHEM.REACT.BALANCE");
  assert.ok(match!.confidence > 50);
});

test("the topic a teacher wrote wins outright when it names the skill", () => {
  const maths = skillsFor("Mathematics");
  const match = engine.matchByKeyword(maths, "Question 4b", "Trigonometry");
  assert.equal(match?.skill.code, "MATH.GEO.TRIG");
});

test("a question the keywords cannot place is handed on, not guessed", () => {
  const maths = skillsFor("Mathematics");
  assert.equal(engine.matchByKeyword(maths, "State your answer clearly in the box below"), null);
  assert.equal(engine.matchByKeyword(maths, ""), null);
  assert.equal(engine.matchByKeyword([], "Balance the equation"), null);
});

// ---------------------------------------------------------------------------
// Why the mark was lost
// ---------------------------------------------------------------------------

test("full marks is not an error", () => {
  assert.equal(
    engine.classifyErrorRules({ is_correct: true, marks_awarded: 3, marks_possible: 3 }),
    null,
  );
  assert.equal(engine.classifyErrorRules({ is_correct: true }), null);
});

test("a blank answer is 'unanswered', never 'concept'", () => {
  // A teacher reading "concept not understood" against a question the student
  // never attempted would rightly stop trusting the whole profile.
  for (const answer of ["", "   ", "-", "—"]) {
    assert.equal(
      engine.classifyErrorRules({
        is_correct: false,
        student_answer: answer,
        marks_awarded: 0,
        marks_possible: 4,
      }),
      "unanswered",
    );
  }
});

test("a wrong answer with working needs real judgement, so the rules defer", () => {
  assert.equal(
    engine.classifyErrorRules({
      is_correct: false,
      student_answer: "2Fe + 3O2 -> 2Fe2O3",
      marks_awarded: 1,
      marks_possible: 3,
    }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// Mastery
// ---------------------------------------------------------------------------

test("no evidence is not a score of zero with confidence", () => {
  const m = engine.computeMastery([]);
  assert.equal(m.mastery, 0);
  assert.equal(m.confidence, 0);
  assert.equal(m.attempts, 0);
});

test("one question is a hint, not a diagnosis", () => {
  const one = engine.computeMastery([{ ratio: 20, observed_at: daysAgo(1) }]);
  const nine = engine.computeMastery(
    Array.from({ length: 9 }, (_, i) => ({ ratio: 20, observed_at: daysAgo(i + 1) })),
  );
  assert.equal(one.mastery, 20);
  assert.equal(nine.mastery, 20);
  // Same score, very different standing — which is exactly what a teacher
  // needs to see before spending an intervention on it.
  assert.ok(one.confidence < 40, `one observation gave ${one.confidence}% confidence`);
  assert.ok(nine.confidence > 90, `nine observations gave ${nine.confidence}% confidence`);
});

test("recent work outweighs last term's", () => {
  const now = new Date();
  // Failed everything six months ago, passing everything this week.
  const m = engine.computeMastery(
    [
      ...Array.from({ length: 4 }, () => ({ ratio: 10, observed_at: daysAgo(180) })),
      ...Array.from({ length: 4 }, () => ({ ratio: 90, observed_at: daysAgo(3) })),
    ],
    now,
  );
  assert.ok(m.mastery > 70, `decay should favour the recent work, got ${m.mastery}`);
  assert.ok(m.trend > 40, `trend should show the improvement, got ${m.trend}`);
});

test("trend is only reported once there is enough to see one", () => {
  const three = engine.computeMastery([
    { ratio: 10, observed_at: daysAgo(9) },
    { ratio: 50, observed_at: daysAgo(6) },
    { ratio: 90, observed_at: daysAgo(3) },
  ]);
  assert.equal(three.trend, 0, "three observations is noise, not a trend");

  const four = engine.computeMastery([
    { ratio: 10, observed_at: daysAgo(12) },
    { ratio: 20, observed_at: daysAgo(9) },
    { ratio: 80, observed_at: daysAgo(6) },
    { ratio: 90, observed_at: daysAgo(3) },
  ]);
  assert.ok(four.trend > 0);
});

test("a declining student shows a negative trend", () => {
  const m = engine.computeMastery([
    { ratio: 90, observed_at: daysAgo(20) },
    { ratio: 85, observed_at: daysAgo(15) },
    { ratio: 40, observed_at: daysAgo(8) },
    { ratio: 30, observed_at: daysAgo(2) },
  ]);
  assert.ok(m.trend < -40, `expected a clear decline, got ${m.trend}`);
});

test("the dominant error is the one that keeps happening, weighted by recency", () => {
  const m = engine.computeMastery([
    { ratio: 0, observed_at: daysAgo(200), error_type: "concept" },
    { ratio: 60, observed_at: daysAgo(5), error_type: "calculation" },
    { ratio: 50, observed_at: daysAgo(3), error_type: "calculation" },
  ]);
  // They understood it in the end and now keep dropping the arithmetic —
  // a drill lesson, not a re-teach.
  assert.equal(m.dominant_error, "calculation");
});

test("mastery and ratios stay inside 0-100 whatever arrives", () => {
  const m = engine.computeMastery([
    { ratio: -50, observed_at: daysAgo(1) },
    { ratio: 400, observed_at: daysAgo(1) },
  ]);
  assert.ok(m.mastery >= 0 && m.mastery <= 100);
});

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

test("a well-evidenced weakness outranks an uncertain worse one", () => {
  // 43% off nine questions is a real gap; 20% off one is a rumour. Sending a
  // teacher after the rumour wastes the intervention.
  const evidenced = engine.priorityScore({ mastery: 43, confidence: 95, trend: 0 });
  const rumour = engine.priorityScore({ mastery: 20, confidence: 25, trend: 0 });
  assert.ok(evidenced > rumour, `${evidenced} should outrank ${rumour}`);
});

test("a student already climbing is deprioritised against one standing still", () => {
  const climbing = engine.priorityScore({ mastery: 40, confidence: 90, trend: 25 });
  const stuck = engine.priorityScore({ mastery: 40, confidence: 90, trend: 0 });
  const sliding = engine.priorityScore({ mastery: 40, confidence: 90, trend: -25 });
  assert.ok(climbing < stuck);
  assert.ok(sliding > stuck);
});

test("a mastered skill earns no priority at all", () => {
  assert.equal(engine.priorityScore({ mastery: 95, confidence: 100, trend: 0 }), 0);
});
