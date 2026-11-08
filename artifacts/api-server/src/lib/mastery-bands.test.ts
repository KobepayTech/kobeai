// node --import tsx --test artifacts/api-server/src/lib/mastery-bands.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BANDS, ENOUGH_EVIDENCE, bandOf, nextFocus, studentView } from "./mastery-bands";

const row = (over: Partial<Parameters<typeof studentView>[0]> = {}) => ({
  skill_id: 1,
  name: "Negative acceleration",
  subject: "Physics",
  mastery: 50,
  confidence: 90,
  trend: 0,
  ...over,
});

test("a child is never sent a number they could read as a score", () => {
  // The rule this file exists for. If a percentage ever reaches the student
  // view, "Acceleration 43.7%" appears on a tablet and becomes something to
  // compare with the child at the next desk.
  const view = studentView(row({ mastery: 43.7 as number, confidence: 91, trend: -12 }));
  const serialised = JSON.stringify(view);
  assert.ok(!serialised.includes("43"), "no mastery figure may survive into the student view");
  assert.ok(!serialised.includes("91"), "nor a confidence figure");
  assert.ok(!serialised.includes("-12"), "nor a trend in points");
  assert.equal(view.moving, "down", "a direction is enough");
});

test("the bands cover the whole range with no gap", () => {
  const seen = new Set(Array.from({ length: 101 }, (_, i) => bandOf(i)));
  assert.deepEqual([...seen].sort(), [...BANDS].sort());
});

test("bands are wide enough that one question does not re-label a child", () => {
  assert.equal(bandOf(59), bandOf(45), "the middle of a band is stable");
  assert.equal(bandOf(0), "starting");
  assert.equal(bandOf(100), "strong");
});

test("thin evidence is told honestly rather than dressed as a verdict", () => {
  const view = studentView(row({ mastery: 12, confidence: ENOUGH_EVIDENCE - 1 }));
  assert.equal(view.band, null);
  assert.equal(view.needs_practice_to_tell, true);
  assert.equal(view.label, "Not enough practice yet");
  assert.equal(view.pips, 0, "no pips to misread as a low score");
});

test("a small wobble is not reported as sliding", () => {
  assert.equal(studentView(row({ trend: 5 })).moving, null);
  assert.equal(studentView(row({ trend: -5 })).moving, null);
  assert.equal(studentView(row({ trend: 20 })).moving, "up");
});

test("one thing to work on, never a list of failures", () => {
  const views = [
    studentView(row({ skill_id: 1, name: "Speed", mastery: 95 })),
    studentView(row({ skill_id: 2, name: "Negative acceleration", mastery: 20 })),
    studentView(row({ skill_id: 3, name: "Motion graphs", mastery: 55 })),
  ];
  const focus = nextFocus(views);
  assert.equal(focus?.name, "Negative acceleration", "the weakest known skill");
});

test("a skill with too little evidence is never the thing to work on", () => {
  // Telling a child to focus on something K9 has barely seen is a guess
  // dressed as advice.
  const views = [
    studentView(row({ skill_id: 1, name: "Thin", mastery: 5, confidence: 10 })),
    studentView(row({ skill_id: 2, name: "Known", mastery: 50, confidence: 90 })),
  ];
  assert.equal(nextFocus(views)?.name, "Known");
});

test("a child who is strong everywhere is told nothing to fix", () => {
  assert.equal(nextFocus([studentView(row({ mastery: 90 }))]), null);
});

test("the student view type carries no numeric mastery field at all", () => {
  // A guard on the shape, not just one instance: a field added later called
  // `mastery` or `confidence` would leak on every skill at once.
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, "mastery-bands.ts"), "utf8");
  const start = source.indexOf("export type StudentSkillView");
  const body = source.slice(start, source.indexOf("};", start));
  for (const leak of ["mastery:", "confidence:", "percent", "score:"])
    assert.ok(!body.includes(leak), `StudentSkillView must not carry ${leak}`);
});
