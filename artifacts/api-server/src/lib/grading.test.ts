// node --import tsx --test artifacts/api-server/src/lib/grading.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NECTA_A_LEVEL,
  NECTA_O_LEVEL,
  gradeFor,
  levelForClassGrade,
  nectaDivision,
  officialScore,
  ordinal,
  rankPositions,
  subjectScores,
  validateBands,
} from "./grading";

test("NECTA O-level boundaries", () => {
  assert.equal(gradeFor(75, NECTA_O_LEVEL).grade, "A");
  assert.equal(gradeFor(74.9, NECTA_O_LEVEL).grade, "B");
  assert.equal(gradeFor(45, NECTA_O_LEVEL).grade, "C");
  assert.equal(gradeFor(30, NECTA_O_LEVEL).grade, "D");
  assert.equal(gradeFor(29.9, NECTA_O_LEVEL).grade, "F");
});

test("NECTA A-level boundaries", () => {
  assert.equal(gradeFor(80, NECTA_A_LEVEL).grade, "A");
  assert.equal(gradeFor(39.9, NECTA_A_LEVEL).grade, "S");
  assert.equal(gradeFor(34.9, NECTA_A_LEVEL).grade, "F");
});

test("class grade decides the NECTA level", () => {
  assert.equal(levelForClassGrade("Form 2"), "o_level");
  assert.equal(levelForClassGrade("form 5"), "a_level");
  assert.equal(levelForClassGrade(null), "o_level");
});

test("O-level division uses the best seven subjects", () => {
  assert.deepEqual(nectaDivision("o_level", [1, 1, 2, 2, 3, 3, 4, 5, 5]), { division: "I", points: 16, subjects_counted: 7 });
  assert.equal(nectaDivision("o_level", [3, 3, 3, 3, 3, 3, 3])?.division, "II");
  assert.equal(nectaDivision("o_level", [5, 5, 5, 5, 5, 5, 5])?.division, "0");
  assert.equal(nectaDivision("o_level", [1, 1, 1]), null, "fewer than seven subjects has no division yet");
});

test("A-level division uses the best three principal subjects", () => {
  assert.equal(nectaDivision("a_level", [2, 3, 4])?.division, "I");
  assert.equal(nectaDivision("a_level", [5, 5, 6])?.division, "III");
});

test("subject scores support all three calculation methods", () => {
  const scores = subjectScores(
    [
      { kind: "ca", percent: 60 },
      { kind: "ca", percent: 80 },
      { kind: "terminal", percent: 50 },
    ],
    { ca: 30, exam: 70 },
  );
  assert.deepEqual(scores, { ca: 70, terminal: 50, average: 63.3, weighted: 56 });
  assert.equal(officialScore(scores, "weighted"), 56);
  assert.equal(officialScore(scores, "average"), 63.3);
  assert.equal(officialScore(scores, "terminal"), 50);

  const caOnly = subjectScores([{ kind: "ca", percent: 72 }], { ca: 30, exam: 70 });
  assert.equal(caOnly.weighted, 72, "without a terminal exam the weighted score is the CA so far");
  assert.equal(officialScore(caOnly, "terminal"), null);
});

test("positions share ties", () => {
  const positions = rankPositions([
    { key: "a", score: 90 },
    { key: "b", score: 80 },
    { key: "c", score: 80 },
    { key: "d", score: 70 },
  ]);
  assert.deepEqual([...positions.entries()], [["a", 1], ["b", 2], ["c", 2], ["d", 4]]);
});

test("school grading schemes are validated", () => {
  assert.equal(validateBands(NECTA_O_LEVEL), null);
  assert.match(validateBands([{ grade: "A", min: 50 }, { grade: "B", min: 20 }]) ?? "", /start at 0/);
  assert.match(validateBands([{ grade: "A", min: 50 }, { grade: "A", min: 0 }]) ?? "", /appears twice/);
});

test("ordinals", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st"]);
});
