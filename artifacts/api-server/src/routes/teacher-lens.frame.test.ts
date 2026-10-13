// POST /v1/teacher-lens/frame against the real app and a real Postgres.
//
//   K9_TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/k9test \
//     pnpm --filter @workspace/db run push-force      (with DATABASE_URL set the same)
//   K9_TEST_DATABASE_URL=... node --import tsx --test \
//     artifacts/api-server/src/routes/teacher-lens.frame.test.ts
//
// The lens retries a stored frame until the server accepts it, so this route
// has to ingest each capture exactly once whatever happens to the attempts:
// several at the same moment, one that takes minutes, one whose reply is lost,
// one the server dies in the middle of. None of that is visible to a type
// checker or a mock; it is advisory locks and transaction boundaries, so it is
// exercised here for real. CI runs this (.github/workflows/ci.yml); it is
// skipped, not failed, only where K9_TEST_DATABASE_URL is absent.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const DB = process.env["K9_TEST_DATABASE_URL"];
process.env["DATABASE_URL"] ??= DB ?? "postgres://test:test@127.0.0.1:5432/unused";
process.env["JWT_SECRET"] ??= "lens-frame-test-secret";
const framesDir = mkdtempSync(join(tmpdir(), "k9-lens-frames-"));
process.env["KOBEAI_LENS_FRAMES_DIR"] = framesDir;

type Db = typeof import("@workspace/db");
let db: Db;
let server: http.Server;
let base = "";
let asha = { id: 0, token: "" };
let baraka = { id: 0, token: "" };
let student = { id: 0, code: "" };
let classId = 0;
let termId = 0;
let examId = 0;
const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)]);
let serial = 0;
const captureId = () => `itest-${run}-${String(++serial).padStart(4, "0")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Reply = { status: number; body: { request?: { id: number; context?: Record<string, unknown> }; image_key?: string; duplicate?: boolean; error?: string }; retryAfter: string | null };

async function post(to: string, token: string, headers: Record<string, string>): Promise<Reply> {
  const response = await fetch(`${to}/api/v1/teacher-lens/frame`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "image/jpeg", "x-lens-mode": "lookup", ...headers },
    body: jpeg,
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Reply["body"], retryAfter: response.headers.get("retry-after") };
}

/** Vision requests created for a capture. Exactly-once means this has length 1. */
async function requestsFor(id: string): Promise<Array<{ id: number; requested_by: number; context: Record<string, unknown> }>> {
  const { rows } = await db.pool.query(
    `SELECT id, requested_by, context FROM vision_analysis_requests WHERE context->>'capture_id' = $1 ORDER BY id`,
    [id],
  );
  return rows.map((r) => ({ id: Number(r.id), requested_by: Number(r.requested_by), context: r.context }));
}

async function whispers(teacherId: number): Promise<number> {
  const { rows } = await db.pool.query(`SELECT COUNT(*)::int AS n FROM teacher_lens_whispers WHERE teacher_user_id = $1`, [teacherId]);
  return rows[0].n;
}

/** Is some attempt holding this capture's ingestion lock right now? */
async function ingesting(teacherId: number, id: string): Promise<boolean> {
  const { rows } = await db.pool.query(
    `WITH k AS (SELECT hashtextextended($1, 0) AS key)
     SELECT COUNT(*)::int AS n FROM pg_locks, k
     WHERE locktype = 'advisory' AND granted AND objsubid = 1
       AND classid = ((k.key >> 32) & 4294967295)::oid
       AND objid = (k.key & 4294967295)::oid`,
    [`lens-capture:${teacherId}:${id}`],
  );
  return rows[0].n > 0;
}

async function until(what: string, check: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * Freeze ingestion at the point where it has taken the capture's lock and is
 * about to write the vision request — a slow disk, a saturated database, a
 * stalled worker. Returns the function that lets it continue.
 */
async function stallIngestion(): Promise<() => Promise<void>> {
  const client = await db.pool.connect();
  await client.query("BEGIN");
  await client.query("LOCK TABLE vision_analysis_requests IN SHARE MODE");
  return async () => {
    await client.query("COMMIT");
    client.release();
  };
}

function startServerProcess(): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../test-support/lens-frame-server.ts")], {
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /LISTENING (\d+)/.exec(out);
      if (match) resolve({ child, url: `http://127.0.0.1:${match[1]}` });
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`server process exited early (${code})`)));
  });
}

describe("lens frame upload", { skip: DB ? false : "set K9_TEST_DATABASE_URL to run" }, () => {
  before(async () => {
    db = await import("@workspace/db");
    const { signToken } = await import("../lib/auth");
    const { ensureResultsTables } = await import("../lib/results");
    const app = (await import("../app")).default;
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const teacher = async (name: string) => {
      const { rows } = await db.pool.query(`INSERT INTO users (role, name, email) VALUES ('teacher', $1, $2) RETURNING id`, [
        name,
        `${name.toLowerCase()}-${run}@lens.test`,
      ]);
      const id = Number(rows[0].id);
      return { id, token: signToken({ role: "teacher", user_id: id, name }) };
    };
    asha = await teacher("Asha");
    baraka = await teacher("Baraka");

    await ensureResultsTables();
    student.code = `LENS-${run}`;
    student.id = Number(
      (await db.pool.query(`INSERT INTO users (role, name, student_code) VALUES ('student', 'Neema', $1) RETURNING id`, [student.code])).rows[0].id,
    );
    classId = Number((await db.pool.query(`INSERT INTO classes (name, grade) VALUES ($1, 'Form 2') RETURNING id`, [`Lens ${run}`])).rows[0].id);
    await db.pool.query(`INSERT INTO class_memberships (class_id, student_id) VALUES ($1, $2)`, [classId, student.id]);
    termId = Number((await db.pool.query(`INSERT INTO academic_terms (name, academic_year) VALUES ('Term 1', $1) RETURNING id`, [`lens-${run}`])).rows[0].id);
    examId = Number(
      (
        await db.pool.query(
          `INSERT INTO result_exams (term_id, class_id, subject, title, kind, total_marks) VALUES ($1, $2, 'Biology', 'Mid-term', 'ca', 40) RETURNING id`,
          [termId, classId],
        )
      ).rows[0].id,
    );
    // First request creates the route's tables; do it before any test stalls one.
    assert.equal((await post(base, asha.token, { "x-lens-capture-id": captureId() })).status, 202);
  });

  after(async () => {
    // Whatever setup or a test left behind, the server and pool are closed, or
    // the test process never exits.
    try {
      const teachers = [asha.id, baraka.id];
      await db.pool.query(`DELETE FROM vision_analysis_requests WHERE requested_by = ANY($1::int[])`, [teachers]);
      await db.pool.query(`DELETE FROM teacher_lens_captures WHERE teacher_user_id = ANY($1::int[])`, [teachers]);
      await db.pool.query(`DELETE FROM teacher_lens_whispers WHERE teacher_user_id = ANY($1::int[])`, [teachers]);
      await db.pool.query(`DELETE FROM graded_papers WHERE teacher_user_id = ANY($1::int[])`, [teachers]);
      await db.pool.query(`DELETE FROM academic_terms WHERE id = $1`, [termId]);
      await db.pool.query(`DELETE FROM classes WHERE id = $1`, [classId]);
      await db.pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [[...teachers, student.id]]);
    } finally {
      server?.closeAllConnections();
      server?.close();
      await db?.pool.end().catch(() => undefined);
      rmSync(framesDir, { recursive: true, force: true });
    }
  });

  test("simultaneous attempts at one capture create one request", async () => {
    const id = captureId();
    const before = await whispers(asha.id);
    const replies = await Promise.all(Array.from({ length: 8 }, () => post(base, asha.token, { "x-lens-capture-id": id })));
    const statuses = replies.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 202).length, 1, `exactly one attempt ingests: ${statuses}`);
    assert.ok(statuses.every((s) => s === 202 || s === 409 || s === 200), `the rest are told to wait or given the result: ${statuses}`);
    const created = await requestsFor(id);
    assert.equal(created.length, 1);
    for (const reply of replies.filter((r) => r.status !== 409)) assert.equal(reply.body.request?.id, created[0].id);

    const later = await post(base, asha.token, { "x-lens-capture-id": id });
    assert.equal(later.status, 200);
    assert.equal(later.body.duplicate, true);
    assert.equal(later.body.request?.id, created[0].id);
    assert.equal(later.body.image_key, replies.find((r) => r.status === 202)!.body.image_key);
    assert.equal((await requestsFor(id)).length, 1);
    assert.equal((await whispers(asha.id)) - before, 1, "one lookup, one whisper, however many attempts");
  });

  test("an ingestion that runs long is never started a second time", async () => {
    const id = captureId();
    const resume = await stallIngestion();
    let first: Promise<Reply>;
    try {
      first = post(base, asha.token, { "x-lens-capture-id": id });
      await until("the first attempt to be ingesting", () => ingesting(asha.id, id));
      // Retries keep arriving for as long as the first attempt is stuck. There
      // is no age at which one of them is allowed to take over: what holds
      // them off is the first attempt's own database session being alive.
      for (let i = 0; i < 6; i++) {
        const retry = await post(base, asha.token, { "x-lens-capture-id": id });
        assert.equal(retry.status, 409, "a retry during ingestion is told to come back");
        assert.equal(retry.body.error, "capture_in_progress");
        assert.equal(retry.retryAfter, "5");
        await sleep(500);
      }
      assert.equal((await requestsFor(id)).length, 0);
      assert.ok(await ingesting(asha.id, id), "and the first attempt is still the only one working");
    } finally {
      await resume();
    }
    const done = await first!;
    assert.equal(done.status, 202);
    const retry = await post(base, asha.token, { "x-lens-capture-id": id });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.request?.id, done.body.request?.id);
    assert.equal((await requestsFor(id)).length, 1);
  });

  test("a reply lost after success is answered with the same result on retry", async () => {
    const id = captureId();
    const before = await whispers(baraka.id);
    // The phone sends the frame and the connection dies before it reads a reply.
    const url = new URL(`${base}/api/v1/teacher-lens/frame`);
    const request = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: { authorization: `Bearer ${baraka.token}`, "content-type": "image/jpeg", "content-length": jpeg.length, "x-lens-mode": "lookup", "x-lens-capture-id": id },
    });
    request.on("error", () => undefined);
    request.end(jpeg);
    await until("the server to have ingested it", async () => (await requestsFor(id)).length === 1);
    request.destroy();

    const [created] = await requestsFor(id);
    const retry = await post(base, baraka.token, { "x-lens-capture-id": id });
    assert.equal(retry.status, 200, "the retry is recognised");
    assert.equal(retry.body.duplicate, true);
    assert.equal(retry.body.request?.id, created.id);
    assert.equal((await requestsFor(id)).length, 1, "and nothing is ingested again");
    assert.equal((await whispers(baraka.id)) - before, 1);
  });

  test("a server that dies mid-ingestion leaves nothing behind, and the retry ingests once", async () => {
    const id = captureId();
    const victim = await startServerProcess();
    victim.child.removeAllListeners("exit");
    // Its first request creates tables; get that out of the way.
    assert.equal((await post(victim.url, asha.token, { "x-lens-capture-id": captureId() })).status, 202);

    const resume = await stallIngestion();
    try {
      const doomed = post(victim.url, asha.token, { "x-lens-capture-id": id }).catch(() => null);
      await until("the doomed attempt to be ingesting", () => ingesting(asha.id, id));
      const exited = new Promise((resolve) => victim.child.once("exit", resolve));
      victim.child.kill("SIGKILL");
      await exited;
      assert.equal(await doomed, null, "the phone gets no reply at all");
    } finally {
      await resume();
    }
    // Postgres notices the dead connection, rolls the transaction back and
    // releases the lock. Nothing was committed, so nothing needs repairing.
    await until("the dead attempt's lock to be released", async () => !(await ingesting(asha.id, id)));
    assert.equal((await requestsFor(id)).length, 0, "the half-finished ingestion left no request");
    const claims = await db.pool.query(`SELECT 1 FROM teacher_lens_captures WHERE teacher_user_id = $1 AND capture_id = $2`, [asha.id, id]);
    assert.equal(claims.rows.length, 0, "and no record that would make a retry look like a duplicate");

    const retry = await post(base, asha.token, { "x-lens-capture-id": id });
    assert.equal(retry.status, 202, "the retry is ingested straight away, not held off by a stale claim");
    assert.equal((await requestsFor(id)).length, 1);
    assert.ok(existsSync(join(framesDir, retry.body.image_key!)), "its image is on disk");
    const files = readdirSync(framesDir).flatMap((day) => readdirSync(join(framesDir, day))).filter((name) => name.startsWith(id));
    assert.equal(files.length, 1, "the dead attempt's image was overwritten, not orphaned");
    assert.equal((await post(base, asha.token, { "x-lens-capture-id": id })).status, 200);
    assert.equal((await requestsFor(id)).length, 1);
  });

  test("a capture id answers only for the teacher who uploaded it", async () => {
    const id = captureId();
    const hers = await post(base, asha.token, { "x-lens-capture-id": id });
    const his = await post(base, baraka.token, { "x-lens-capture-id": id });
    assert.equal(hers.status, 202);
    assert.equal(his.status, 202, "another teacher's identical id is a different capture");
    assert.notEqual(hers.body.request?.id, his.body.request?.id);
    assert.deepEqual((await requestsFor(id)).map((r) => r.requested_by).sort(), [asha.id, baraka.id].sort());
  });

  test("a replayed exam frame keeps its exam and its capture time", async () => {
    const id = captureId();
    const quarterHour = 15 * 60_000;
    const before = await whispers(asha.id);
    // Captured during an outage, uploaded fifteen minutes later under a new session.
    const reply = await post(base, asha.token, {
      "x-lens-capture-id": id,
      "x-lens-mode": "mark",
      "x-lens-exam-id": String(examId),
      "x-lens-capture-age-ms": String(quarterHour),
      // What the lens sends when it replays a stored frame before its new
      // session has started.
      "x-lens-session-id": "",
    });
    assert.equal(reply.status, 202);
    const [request] = await requestsFor(id);
    assert.equal(request.context["lens_session_id"], null, "no session is recorded as none, not as session 0");
    assert.equal(request.context["exam_id"], examId);
    assert.equal(request.context["subject"], "Biology");
    assert.equal(Number(request.context["total_marks"]), 40);
    assert.equal(request.context["lens_mode"], "mark");
    const captured = Date.parse(String(request.context["captured_at"]));
    assert.ok(Math.abs(Date.now() - quarterHour - captured) < 10_000, "captured_at is when the photo was taken, not when it arrived");
    assert.equal((await whispers(asha.id)) - before, 0, "marking frames do not whisper on upload");

    // The worker reads the page; the paper is filed under the time it was marked.
    const { completeVisionRequest } = await import("../lib/vision-queue");
    const { recordCameraMarkedPaper } = await import("../lib/exam-vision");
    const completed = await completeVisionRequest(request.id, {
      ok: true,
      response: {
        student_code: student.code,
        student_confidence: 0.99,
        profile_attachment_confidence: 0.99,
        paper_fingerprint: `fp-${id}`,
        page_number: 1,
        paper_complete: false,
        items: [{ question_number: 1, is_correct: true, marks_awarded: 2, marks_possible: 2 }],
      },
    });
    const recorded = await recordCameraMarkedPaper({ response: completed!.response!, context: completed!.context!, teacherUserId: asha.id });
    assert.equal(recorded.status, "recorded");
    const paper = await db.pool.query(`SELECT graded_at, metadata, paper_image_key FROM graded_papers WHERE id = $1`, [recorded.paperId]);
    assert.ok(Math.abs(new Date(paper.rows[0].graded_at).getTime() - captured) < 1000, "graded_at is the capture time");
    assert.equal(paper.rows[0].metadata.exam_id, examId);
    assert.equal(paper.rows[0].paper_image_key, reply.body.image_key);
  });

  test("a stale lookup is refused: no request, no whisper", async () => {
    const id = captureId();
    const before = await whispers(asha.id);
    const stale = await post(base, asha.token, { "x-lens-capture-id": id, "x-lens-capture-age-ms": String(5 * 60_000) });
    assert.equal(stale.status, 410);
    assert.equal(stale.body.error, "lookup_expired");
    assert.equal((await requestsFor(id)).length, 0);
    assert.equal((await whispers(asha.id)) - before, 0);
    assert.equal(readdirSync(framesDir).flatMap((day) => readdirSync(join(framesDir, day))).filter((name) => name.startsWith(id)).length, 0);
  });

  test("a lookup that went through, retried once stale, whispers only the once", async () => {
    const id = captureId();
    const before = await whispers(asha.id);
    assert.equal((await post(base, asha.token, { "x-lens-capture-id": id, "x-lens-capture-age-ms": "800" })).status, 202);
    assert.equal((await whispers(asha.id)) - before, 1);
    const late = await post(base, asha.token, { "x-lens-capture-id": id, "x-lens-capture-age-ms": String(10 * 60_000) });
    assert.equal(late.status, 410);
    assert.equal((await requestsFor(id)).length, 1);
    assert.equal((await whispers(asha.id)) - before, 1);
  });

  test("an old marking frame is still accepted", async () => {
    const id = captureId();
    const reply = await post(base, asha.token, { "x-lens-capture-id": id, "x-lens-mode": "mark", "x-lens-capture-age-ms": String(6 * 3600_000) });
    assert.equal(reply.status, 202, "exam evidence does not expire");
  });

  test("a lens opened straight into marking gets a session", async () => {
    for (const mode of ["mark", "marking", "lookup"]) {
      const response = await fetch(`${base}/api/v1/teacher-lens/session`, {
        method: "POST",
        headers: { authorization: `Bearer ${asha.token}`, "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      assert.equal(response.status, 201, `mode ${mode}`);
    }
    await db.pool.query(`DELETE FROM teacher_lens_sessions WHERE teacher_user_id = $1`, [asha.id]);
  });

  test("malformed idempotency headers are rejected, and a client without them still works", async () => {
    assert.equal((await post(base, asha.token, { "x-lens-capture-id": "short" })).status, 400);
    assert.equal((await post(base, asha.token, { "x-lens-capture-id": captureId(), "x-lens-capture-age-ms": "-5" })).status, 400);
    const legacy = await post(base, asha.token, {});
    assert.equal(legacy.status, 202);
    assert.equal(typeof legacy.body.request?.id, "number");
  });
});
