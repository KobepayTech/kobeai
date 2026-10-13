// Idempotent lens uploads. The id parsing runs anywhere; the claim itself is
// SQL (ON CONFLICT ... DO UPDATE ... WHERE) and is only meaningful against a
// real Postgres, so those tests follow db-integration.test.ts: skipped, not
// failed, when K9_TEST_DATABASE_URL is absent.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

const DB = process.env["K9_TEST_DATABASE_URL"];
process.env["DATABASE_URL"] ??= DB ?? "postgres://test:test@127.0.0.1:5432/unused";

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
    for (const bad of ["short", "x".repeat(65), "has space in the id 1234", "semi;colon;1234567890", 42, {}])
      assert.equal(capture.parseCaptureId(bad), "invalid");
  });
});

describe("capture claim", { skip: DB ? false : "set K9_TEST_DATABASE_URL to run" }, () => {
  let db: typeof import("@workspace/db");
  const teacher = 910_001;
  const other = 910_002;
  const id = () => `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

  before(async () => {
    db = await import("@workspace/db");
  });
  after(async () => {
    await db.pool.query(`DELETE FROM teacher_lens_captures WHERE teacher_user_id IN ($1, $2)`, [teacher, other]);
    await db.pool.end();
  });

  test("a retry after success gets the first result and is not ingested again", async () => {
    const captureId = id();
    assert.deepEqual(await capture.claimLensCapture(teacher, captureId), { kind: "claimed" });
    await capture.finishLensCapture(teacher, captureId, { requestId: 77, imageKey: "2026-10-13/a.mark_paper.jpg" });
    assert.deepEqual(await capture.claimLensCapture(teacher, captureId), {
      kind: "done",
      requestId: 77,
      imageKey: "2026-10-13/a.mark_paper.jpg",
    });
  });

  test("two simultaneous attempts cannot both ingest", async () => {
    const captureId = id();
    const results = await Promise.all([
      capture.claimLensCapture(teacher, captureId),
      capture.claimLensCapture(teacher, captureId),
      capture.claimLensCapture(teacher, captureId),
    ]);
    assert.equal(results.filter((r) => r.kind === "claimed").length, 1);
    assert.equal(results.filter((r) => r.kind === "in_progress").length, 2);
  });

  test("a failed ingest releases the claim so the next retry proceeds", async () => {
    const captureId = id();
    await capture.claimLensCapture(teacher, captureId);
    await capture.releaseLensCapture(teacher, captureId);
    assert.deepEqual(await capture.claimLensCapture(teacher, captureId), { kind: "claimed" });
  });

  test("release never discards a recorded result", async () => {
    const captureId = id();
    await capture.claimLensCapture(teacher, captureId);
    await capture.finishLensCapture(teacher, captureId, { requestId: 78, imageKey: null });
    await capture.releaseLensCapture(teacher, captureId);
    assert.equal((await capture.claimLensCapture(teacher, captureId)).kind, "done");
  });

  test("an abandoned claim is taken over once it goes stale, a fresh one is not", async () => {
    const captureId = id();
    await capture.claimLensCapture(teacher, captureId);
    assert.equal((await capture.claimLensCapture(teacher, captureId)).kind, "in_progress");
    await db.pool.query(
      `UPDATE teacher_lens_captures SET claimed_at = NOW() - make_interval(secs => $3)
       WHERE teacher_user_id = $1 AND capture_id = $2`,
      [teacher, captureId, capture.CAPTURE_CLAIM_STALE_SECONDS + 5],
    );
    assert.equal((await capture.claimLensCapture(teacher, captureId)).kind, "claimed");
  });

  test("a capture id answers only for the teacher who uploaded it", async () => {
    const captureId = id();
    await capture.claimLensCapture(teacher, captureId);
    await capture.finishLensCapture(teacher, captureId, { requestId: 79, imageKey: null });
    assert.deepEqual(await capture.claimLensCapture(other, captureId), { kind: "claimed" });
  });
});
