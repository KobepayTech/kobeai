// node --import tsx --test artifacts/api-server/src/lib/kobe-brain.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonLoose } from "./kobe-brain";

// Ollama's `format: "json"` usually gives back a bare object, but a small
// quantised model ignores it often enough that every caller would otherwise
// lose a whole generation to a "Sure! Here's the JSON:" preamble.

test("a bare object parses", () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
});

test("a fenced block parses", () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
});

test("JSON buried in prose parses", () => {
  assert.deepEqual(
    parseJsonLoose('Sure! Here are the questions:\n{"questions":[{"prompt":"x"}]}\nHope that helps.'),
    { questions: [{ prompt: "x" }] },
  );
});

test("a bare array parses", () => {
  assert.deepEqual(parseJsonLoose("[1,2,3]"), [1, 2, 3]);
});

test("nested braces keep the whole object, not the first closing brace", () => {
  assert.deepEqual(parseJsonLoose('noise {"a":{"b":2}} trailing'), { a: { b: 2 } });
});

test("unparseable output returns null rather than throwing", () => {
  assert.equal(parseJsonLoose("I cannot answer that."), null);
  assert.equal(parseJsonLoose('{"a": '), null);
  assert.equal(parseJsonLoose(""), null);
});
