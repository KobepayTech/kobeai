import { pool } from "@workspace/db";
import { logger } from "./logger";

// The intelligence path from docs/K9_ARCHITECTURE.md. Kept deliberately
// simple: rows, statuses, and a claim helper. A future Youtu-VL / Qwen
// worker consumes this queue and posts its answer back via
// POST /v1/vision/analyze/:id/complete.

let tablesReady: Promise<void> | null = null;

export type VisionAnalysisRequest = {
  id: number;
  camera_id: string | null;
  student_code: string | null;
  question: string;
  reason: string | null;
  context: Record<string, unknown> | null;
  requested_by: number | null;
  priority: number;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  claimed_by_worker: string | null;
  claimed_at: string | null;
  response: Record<string, unknown> | null;
  created_at: string;
  completed_at: string | null;
};

export function ensureVisionQueueTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS vision_analysis_requests (
          id BIGSERIAL PRIMARY KEY,
          camera_id TEXT,
          student_code TEXT,
          question TEXT NOT NULL,
          reason TEXT,
          context JSONB,
          requested_by INTEGER,
          priority INTEGER NOT NULL DEFAULT 5,
          status TEXT NOT NULL DEFAULT 'pending',
          claimed_by_worker TEXT,
          claimed_at TIMESTAMPTZ,
          response JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS vision_queue_status_priority_idx
          ON vision_analysis_requests (status, priority, created_at)
          WHERE status IN ('pending', 'in_progress')
      `);
    })().catch((err) => {
      tablesReady = null;
      throw err;
    });
  }
  return tablesReady;
}

export type EnqueueOptions = {
  cameraId?: string | null;
  studentCode?: string | null;
  question: string;
  reason?: string | null;
  context?: Record<string, unknown> | null;
  requestedBy?: number | null;
  priority?: number;
};

export async function enqueueVisionAnalysis(opts: EnqueueOptions): Promise<VisionAnalysisRequest> {
  await ensureVisionQueueTables();
  const question = String(opts.question ?? "").trim();
  if (!question || question.length > 500) {
    throw new Error("question_required_max_500_chars");
  }
  const priority = Math.max(1, Math.min(10, Number(opts.priority ?? 5)));
  const rows = await pool.query(
    `INSERT INTO vision_analysis_requests (
       camera_id, student_code, question, reason, context, requested_by, priority
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     RETURNING *`,
    [
      opts.cameraId ?? null,
      opts.studentCode ?? null,
      question,
      opts.reason ?? null,
      JSON.stringify(opts.context ?? {}),
      opts.requestedBy ?? null,
      priority,
    ],
  );
  return rowToRequest(rows.rows[0]);
}

/**
 * Claim up to `limit` pending requests for a worker. Uses SELECT ... FOR
 * UPDATE SKIP LOCKED so multiple workers can drain the queue in parallel.
 * Flips status to 'in_progress' and stamps claimed_by_worker + claimed_at.
 */
export async function claimVisionRequests(worker: string, limit: number): Promise<VisionAnalysisRequest[]> {
  await ensureVisionQueueTables();
  const cappedLimit = Math.max(1, Math.min(50, limit));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const picked = await client.query(
      `SELECT id FROM vision_analysis_requests
       WHERE status = 'pending'
       ORDER BY priority ASC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [cappedLimit],
    );
    if (picked.rows.length === 0) {
      await client.query("COMMIT");
      return [];
    }
    const ids = picked.rows.map((r) => Number(r.id));
    const updated = await client.query(
      `UPDATE vision_analysis_requests
       SET status = 'in_progress', claimed_by_worker = $1, claimed_at = NOW()
       WHERE id = ANY($2::bigint[])
       RETURNING *`,
      [worker, ids],
    );
    await client.query("COMMIT");
    return updated.rows.map(rowToRequest);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function completeVisionRequest(
  id: number,
  outcome: { ok: boolean; response?: Record<string, unknown> | null; worker?: string | null },
): Promise<VisionAnalysisRequest | null> {
  await ensureVisionQueueTables();
  const rows = await pool.query(
    `UPDATE vision_analysis_requests
     SET status = $2,
         response = $3::jsonb,
         completed_at = NOW(),
         claimed_by_worker = COALESCE($4, claimed_by_worker)
     WHERE id = $1
     RETURNING *`,
    [id, outcome.ok ? "completed" : "failed", JSON.stringify(outcome.response ?? {}), outcome.worker ?? null],
  );
  if (!rows.rows[0]) return null;
  return rowToRequest(rows.rows[0]);
}

export async function getVisionRequest(id: number): Promise<VisionAnalysisRequest | null> {
  await ensureVisionQueueTables();
  const rows = await pool.query(`SELECT * FROM vision_analysis_requests WHERE id = $1`, [id]);
  return rows.rows[0] ? rowToRequest(rows.rows[0]) : null;
}

export async function listVisionRequests(args: {
  status?: string;
  studentCode?: string | null;
  cameraId?: string | null;
  limit?: number;
}): Promise<VisionAnalysisRequest[]> {
  await ensureVisionQueueTables();
  const filters: string[] = [];
  const values: unknown[] = [];
  if (args.status) {
    values.push(args.status);
    filters.push(`status = $${values.length}`);
  }
  if (args.studentCode) {
    values.push(args.studentCode);
    filters.push(`student_code = $${values.length}`);
  }
  if (args.cameraId) {
    values.push(args.cameraId);
    filters.push(`camera_id = $${values.length}`);
  }
  values.push(Math.max(1, Math.min(500, args.limit ?? 100)));
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = await pool.query(
    `SELECT * FROM vision_analysis_requests
     ${where}
     ORDER BY created_at DESC
     LIMIT $${values.length}`,
    values,
  );
  return rows.rows.map(rowToRequest);
}

function rowToRequest(r: Record<string, unknown>): VisionAnalysisRequest {
  return {
    id: Number(r["id"]),
    camera_id: (r["camera_id"] as string | null) ?? null,
    student_code: (r["student_code"] as string | null) ?? null,
    question: String(r["question"] ?? ""),
    reason: (r["reason"] as string | null) ?? null,
    context: (r["context"] as Record<string, unknown> | null) ?? null,
    requested_by: r["requested_by"] == null ? null : Number(r["requested_by"]),
    priority: Number(r["priority"] ?? 5),
    status: (r["status"] as VisionAnalysisRequest["status"]) ?? "pending",
    claimed_by_worker: (r["claimed_by_worker"] as string | null) ?? null,
    claimed_at: r["claimed_at"] ? new Date(r["claimed_at"] as string).toISOString() : null,
    response: (r["response"] as Record<string, unknown> | null) ?? null,
    created_at: new Date(r["created_at"] as string).toISOString(),
    completed_at: r["completed_at"] ? new Date(r["completed_at"] as string).toISOString() : null,
  };
}

/** Fire-and-forget enqueue for the fast path — never throws. */
export function enqueueVisionAnalysisSafe(opts: EnqueueOptions): void {
  enqueueVisionAnalysis(opts).catch((err) =>
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), question: opts.question },
      "vision-queue enqueue failed",
    ),
  );
}
