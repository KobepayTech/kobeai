import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classColour,
  parseLessons,
  proofProblems,
  renderPack,
  type Proof,
  type PackContent,
} from "./learning-pack-content";
const proof: Proof = {
  id: 1,
  paper_id: 2,
  question_number: 1,
  question_text: "What is 2+3?",
  question_topic: "Addition",
  student_answer: "4",
  expected_answer: "5",
  is_correct: false,
  marks_awarded: 0,
  marks_possible: 1,
  paper_image_key: "page.jpg",
  metadata: { marking_confidence: 0.99, expected_answer_source: "answer_key" },
  paper_metadata: { profile_attachment_confidence: 0.99, paper_complete: true },
};
const lesson = {
  evidence_id: 1,
  explanation: "Count all five objects, including the last one.",
  example: "Two pencils plus three pencils gives five pencils.",
  question: "What is 3+4? Show your steps.",
};
const content: PackContent = {
  name: "Asha Juma",
  code: "S001",
  grade: "Form One",
  subject: "Mathematics",
  title: "Term assessment",
  kind: "quick",
  proof: [proof],
  lessons: [lesson],
  generator: "test",
};
test("uncertain, missing and unverified evidence cannot auto print", () => {
  assert.deepEqual(proofProblems([proof]), []);
  assert.ok(
    proofProblems([{ ...proof, marks_awarded: null }]).includes(
      "Written marks need confirmation",
    ),
  );
  assert.ok(
    proofProblems([{ ...proof, metadata: { marking_confidence: 0.5 } }])
      .length >= 2,
  );
  assert.ok(
    proofProblems([proof, { ...proof, id: 2 }]).includes(
      "Missing or duplicate question numbers",
    ),
  );
});
test("form colours support names and class suffixes", () => {
  assert.equal(classColour("Form One"), classColour("Form 1A"));
  assert.equal(classColour("Form 4"), "#eab308");
});
test("invented evidence and overlong lessons rejected", () => {
  assert.deepEqual(parseLessons(JSON.stringify([lesson]), [proof], 2), [
    lesson,
  ]);
  assert.throws(() =>
    parseLessons(JSON.stringify([{ ...lesson, evidence_id: 99 }]), [proof], 2),
  );
  assert.throws(() =>
    parseLessons(
      JSON.stringify([{ ...lesson, explanation: "x".repeat(501) }]),
      [proof],
      2,
    ),
  );
});
test("quick PDF is exactly two A4 pages and extended six", async () => {
  const quick = await renderPack(content, 1);
  assert.equal(
    (quick.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length,
    2,
  );
  assert.match(quick.toString("latin1"), /595.28 841.89/);
  const extended = await renderPack({ ...content, kind: "extended" }, 2);
  assert.equal(
    (extended.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length,
    6,
  );
});
test("overflow rejects rather than silently adding a billed page", async () => {
  await assert.rejects(
    renderPack(
      {
        ...content,
        lessons: [{ ...lesson, explanation: "Long explanation ".repeat(1000) }],
      },
      3,
    ),
    /page budget/,
  );
});
