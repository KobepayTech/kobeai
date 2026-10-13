// What the lens may put in its idempotency headers. The exactly-once behaviour
// itself is SQL and is tested against the real route and a real Postgres in
// routes/teacher-lens.frame.test.ts.

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

process.env["DATABASE_URL"] ??= process.env["K9_TEST_DATABASE_URL"] ?? "postgres://test:test@127.0.0.1:5432/unused";

type Capture = typeof import("./lens-capture");
let capture: Capture;

before(async () => {
  capture = await import("./lens-capture");
});

describe("capture id", () => {
  test("absent header means the upload is not idempotent, not invalid", () => {
    assert.equal(capture.parseCaptureId(undefined), null);
    assert.equal(capture.parseCaptureId(""), null);
  });
  test("accepts the ids the lens generates", () => {
    assert.equal(capture.parseCaptureId("3f9c2a1b7d4e4c0e9a6b5d2f1c8e7a90"), "3f9c2a1b7d4e4c0e9a6b5d2f1c8e7a90");
    assert.equal(capture.parseCaptureId("0f8fad5b-d9cb-469f-a165-70867728950e"), "0f8fad5b-d9cb-469f-a165-70867728950e");
  });
  test("rejects anything that could not have come from the lens", () => {
    for (const bad of ["short", "x".repeat(65), "has space in the id 1234", "semi;colon;1234567890", "../../etc/passwd-0123456", 42, {}])
      assert.equal(capture.parseCaptureId(bad), "invalid");
  });
});

describe("capture age", () => {
  test("absent header means the client did not say", () => {
    assert.equal(capture.parseCaptureAgeMs(undefined), null);
    assert.equal(capture.parseCaptureAgeMs(""), null);
  });
  test("accepts whole milliseconds up to the longest a frame can be queued", () => {
    assert.equal(capture.parseCaptureAgeMs("0"), 0);
    assert.equal(capture.parseCaptureAgeMs("600000"), 600_000);
    assert.equal(capture.parseCaptureAgeMs(String(30 * 24 * 3600 * 1000)), 30 * 24 * 3600 * 1000);
  });
  test("rejects negatives, fractions, words and implausible ages", () => {
    for (const bad of ["-1", "1.5", "soon", "1e3", String(31 * 24 * 3600 * 1000), "9".repeat(13), 5])
      assert.equal(capture.parseCaptureAgeMs(bad), "invalid");
  });
});
