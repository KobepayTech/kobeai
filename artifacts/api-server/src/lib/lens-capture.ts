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

/** How long an unfinished claim blocks a retry before it is treated as abandoned. */
export const CAPTURE_CLAIM_STALE_SECONDS = 120;

const CAPTURE_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** null when absent; "invalid" when present but not a usable key. */
export function parseCaptureId(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" && CAPTURE_ID.test(value) ? value : "invalid";
}

export type CaptureClaim =
  /** This attempt owns the capture and must ingest it. */
  | { kind: "claimed" }
  /** An earlier attempt already ingested it; answer with that result. */
  | { kind: "done"; requestId: number; imageKey: string | null }
  /** Another attempt is ingesting it right now; the phone should retry later. */
  | { kind: "in_progress" };

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

let tableReady: Promise<void> | null = null;
function ensureTable(db: Queryable): Promise<void> {
  if (db !== pool) return createTable(db);
  if (!tableReady) {
    tableReady = createTable(db).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

async function createTable(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS teacher_lens_captures (
      teacher_user_id INTEGER NOT NULL,
      capture_id TEXT NOT NULL,
      request_id BIGINT,
      image_key TEXT,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      PRIMARY KEY (teacher_user_id, capture_id)
    )
  `);
}

/**
 * Take ownership of a capture, or learn that someone already has.
 *
 * One statement decides it, so two simultaneous retries cannot both win: the
 * insert succeeds for exactly one of them, and the conflict branch only hands
 * the row over when the earlier attempt never finished and has gone quiet.
 */
export async function claimLensCapture(
  teacherUserId: number,
  captureId: string,
  db: Queryable = pool,
): Promise<CaptureClaim> {
  await ensureTable(db);
  const claimed = await db.query(
    `INSERT INTO teacher_lens_captures (teacher_user_id, capture_id)
     VALUES ($1, $2)
     ON CONFLICT (teacher_user_id, capture_id) DO UPDATE
       SET claimed_at = NOW()
       WHERE teacher_lens_captures.request_id IS NULL
         AND teacher_lens_captures.claimed_at < NOW() - make_interval(secs => $3)
     RETURNING capture_id`,
    [teacherUserId, captureId, CAPTURE_CLAIM_STALE_SECONDS],
  );
  if (claimed.rows.length > 0) return { kind: "claimed" };
  const existing = await db.query(
    `SELECT request_id, image_key FROM teacher_lens_captures
     WHERE teacher_user_id = $1 AND capture_id = $2`,
    [teacherUserId, captureId],
  );
  const row = existing.rows[0];
  if (row && row["request_id"] != null) {
    return {
      kind: "done",
      requestId: Number(row["request_id"]),
      imageKey: (row["image_key"] as string | null) ?? null,
    };
  }
  return { kind: "in_progress" };
}

/** Record the result so every later retry is answered with it. */
export async function finishLensCapture(
  teacherUserId: number,
  captureId: string,
  result: { requestId: number; imageKey: string | null },
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `UPDATE teacher_lens_captures
     SET request_id = $3, image_key = $4, completed_at = NOW()
     WHERE teacher_user_id = $1 AND capture_id = $2`,
    [teacherUserId, captureId, result.requestId, result.imageKey],
  );
}

/** Ingest failed: drop the claim so the phone's next retry can try again at once. */
export async function releaseLensCapture(
  teacherUserId: number,
  captureId: string,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `DELETE FROM teacher_lens_captures
     WHERE teacher_user_id = $1 AND capture_id = $2 AND request_id IS NULL`,
    [teacherUserId, captureId],
  );
}
