import { pool } from "@workspace/db";

// Idempotency for lens frame uploads.
//
// The lens keeps every captured frame on the phone until the server has
// accepted it, and retries after an outage or an app restart. A retry cannot
// tell "the request never arrived" from "the reply never came back", so the
// same photograph can legitimately be posted twice. Without a key, the second
// post is a second vision request: the paper is read twice and, in marking
// mode, its questions are counted twice towards the exam result.
//
// The phone therefore names each capture once, when the photo is taken, and
// sends that name with every attempt. The key is scoped to the teacher account
// that uploaded it, so one teacher's capture id can never answer for another's.
//
// Exactly-once rests on two things Postgres already guarantees, and on no
// clock:
//
//  * A transaction-level advisory lock on the capture, held for as long as an
//    attempt is ingesting it. A concurrent retry cannot take the lock, so it
//    is told to come back later however long the first attempt runs. An
//    earlier version used a claim row that expired after two minutes; an
//    ingest slower than that was simply ingested again by the next retry.
//  * The vision request and the row recording "this capture produced that
//    request" are written in that same transaction. Either both exist or
//    neither does. If the server dies mid-ingest its connection drops, the
//    transaction rolls back and the lock goes with it — nothing to expire,
//    nothing to clean up, and the next retry starts from a clean slate. If it
//    dies after committing, the retry finds the recorded result.

const CAPTURE_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** null when absent; "invalid" when present but not a usable key. */
export function parseCaptureId(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" && CAPTURE_ID.test(value) ? value : "invalid";
}

/** A queued frame is never held longer than this; an older claim is a bug or a forgery. */
const MAX_CAPTURE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long ago the photo was taken, in milliseconds, as measured by the phone.
 *
 * An age rather than a timestamp, on purpose: both ends of the subtraction are
 * read from the phone's own clock, so a phone whose clock is wrong by an hour
 * still reports the right age, and the server turns it into a time on its own
 * clock. null when absent (a client that predates the queue); "invalid" when
 * present but unusable.
 */
export function parseCaptureAgeMs(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{1,12}$/.test(value)) return "invalid";
  const age = Number(value);
  return age <= MAX_CAPTURE_AGE_MS ? age : "invalid";
}

/**
 * A lookup asks "who is this, now". One that reaches the server minutes later
 * would whisper a student's name at whoever the teacher is then talking to, so
 * it is refused instead of ingested.
 */
export const LOOKUP_MAX_AGE_MS = 2 * 60_000;

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

let tableReady: Promise<void> | null = null;
export function ensureLensCaptureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = pool
      .query(
        `CREATE TABLE IF NOT EXISTS teacher_lens_captures (
           teacher_user_id INTEGER NOT NULL,
           capture_id TEXT NOT NULL,
           request_id BIGINT,
           image_key TEXT,
           claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           completed_at TIMESTAMPTZ,
           PRIMARY KEY (teacher_user_id, capture_id)
         )`,
      )
      .then(() => undefined)
      .catch((err) => {
        tableReady = null;
        throw err;
      });
  }
  return tableReady;
}

/**
 * Take the capture's lock for the rest of the caller's transaction. False when
 * another attempt holds it, which means that attempt is alive and ingesting.
 * Must be called inside a transaction: the lock is released by its end.
 */
export async function lockLensCapture(tx: Queryable, teacherUserId: number, captureId: string): Promise<boolean> {
  const { rows } = await tx.query(`SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked`, [
    `lens-capture:${teacherUserId}:${captureId}`,
  ]);
  return rows[0]?.["locked"] === true;
}

/** The result an earlier attempt recorded for this capture, if one committed. */
export async function findLensCapture(
  db: Queryable,
  teacherUserId: number,
  captureId: string,
): Promise<{ requestId: number; imageKey: string | null } | null> {
  const { rows } = await db.query(
    `SELECT request_id, image_key FROM teacher_lens_captures
     WHERE teacher_user_id = $1 AND capture_id = $2 AND request_id IS NOT NULL`,
    [teacherUserId, captureId],
  );
  const row = rows[0];
  return row ? { requestId: Number(row["request_id"]), imageKey: (row["image_key"] as string | null) ?? null } : null;
}

/** Record the result. Called in the same transaction that created the vision request. */
export async function recordLensCapture(
  tx: Queryable,
  teacherUserId: number,
  captureId: string,
  result: { requestId: number; imageKey: string | null },
): Promise<void> {
  await tx.query(
    `INSERT INTO teacher_lens_captures (teacher_user_id, capture_id, request_id, image_key, completed_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [teacherUserId, captureId, result.requestId, result.imageKey],
  );
}
