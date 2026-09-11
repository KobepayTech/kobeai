/**
 * Storage interface for live print-job state.
 *
 * In production we back this with Redis so that multiple backend replicas in
 * the school-server compose stack share state and survive restarts. In local
 * dev with no `REDIS_URL` set, we fall back to plain in-memory `Map`s — the
 * shape of every method is identical so route handlers don't change.
 *
 * TTLs are wall-clock milliseconds (Redis EX is in seconds, we convert).
 */

import type Redis from "ioredis";

export type PrintJob = {
  id: string;
  printer_id: string;
  document_id: string;
  document_name: string;
  copies: number;
  /** Set when the handout was printed for one student. */
  student_code: string | null;
  /** users.id of the staff member who queued the job. */
  requested_by: number;
  status: "queued" | "downloading" | "printing" | "done" | "failed";
  status_message: string;
  created_at: number;
  expires_at: number;
};

export interface PrintStore {
  putJob(j: PrintJob, ttlMs: number): Promise<void>;
  getJob(id: string): Promise<PrintJob | null>;
  updateJobStatus(id: string, status: PrintJob["status"], message: string): Promise<PrintJob | null>;
  /** Returns any queued job for the printer (FIFO-ish; not strict). */
  findQueuedForPrinter(printerId: string): Promise<PrintJob | null>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (dev fallback)
// ---------------------------------------------------------------------------

class MemoryStore implements PrintStore {
  private jobs = new Map<string, PrintJob>();

  constructor() {
    setInterval(() => this.gc(), 10_000).unref();
  }

  private gc() {
    const now = Date.now();
    for (const [id, j] of this.jobs) if (j.expires_at < now) this.jobs.delete(id);
  }

  async putJob(j: PrintJob): Promise<void> { this.jobs.set(j.id, j); }
  async getJob(id: string): Promise<PrintJob | null> {
    const j = this.jobs.get(id);
    if (!j || j.expires_at < Date.now()) return null;
    return j;
  }
  async updateJobStatus(id: string, status: PrintJob["status"], message: string): Promise<PrintJob | null> {
    const j = this.jobs.get(id);
    if (!j) return null;
    j.status = status;
    j.status_message = message;
    return j;
  }
  async findQueuedForPrinter(printerId: string): Promise<PrintJob | null> {
    for (const j of this.jobs.values()) {
      if (j.expires_at < Date.now()) continue;
      if (j.printer_id === printerId && j.status === "queued") return j;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

class RedisStore implements PrintStore {
  constructor(private redis: Redis) {}

  private jobKey(id: string) { return `print:job:${id}`; }
  private printerQueueKey(p: string) { return `print:queue:${p}`; }

  async putJob(j: PrintJob, ttlMs: number): Promise<void> {
    const ttl = Math.max(1, Math.floor(ttlMs / 1000));
    await this.redis.set(this.jobKey(j.id), JSON.stringify(j), "EX", ttl);
    if (j.status === "queued") {
      await this.redis.rpush(this.printerQueueKey(j.printer_id), j.id);
      await this.redis.expire(this.printerQueueKey(j.printer_id), ttl);
    }
  }
  async getJob(id: string): Promise<PrintJob | null> {
    const raw = await this.redis.get(this.jobKey(id));
    return raw ? (JSON.parse(raw) as PrintJob) : null;
  }
  async updateJobStatus(id: string, status: PrintJob["status"], message: string): Promise<PrintJob | null> {
    const raw = await this.redis.get(this.jobKey(id));
    if (!raw) return null;
    const j = JSON.parse(raw) as PrintJob;
    j.status = status;
    j.status_message = message;
    const ttl = Math.max(1, Math.floor((j.expires_at - Date.now()) / 1000));
    if (ttl > 0) await this.redis.set(this.jobKey(id), JSON.stringify(j), "EX", ttl);
    return j;
  }
  async findQueuedForPrinter(printerId: string): Promise<PrintJob | null> {
    // Peek the head of the queue. Drop expired/non-queued entries off the
    // front but never remove an actually-queued job — the print agent may
    // poll /next multiple times before transitioning status to "downloading".
    const key = this.printerQueueKey(printerId);
    while (true) {
      const id = await this.redis.lindex(key, 0);
      if (!id) return null;
      const j = await this.getJob(id);
      if (!j) {
        await this.redis.lpop(key); // expired or missing, drop and retry
        continue;
      }
      if (j.status === "queued") return j;
      await this.redis.lpop(key); // already in flight, advance
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let _store: PrintStore | null = null;

export function getPrintStore(): PrintStore {
  if (_store) return _store;
  const url = process.env["REDIS_URL"];
  if (!url) {
    _store = new MemoryStore();
    return _store;
  }
  // Lazy-require so dev without ioredis installed still works.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const IORedis = require("ioredis").default ?? require("ioredis");
  const client = new IORedis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
  client.on("error", (err: unknown) => {
    // Don't crash the server on transient Redis blips.
    // eslint-disable-next-line no-console
    console.error("[print-store] redis error", err);
  });
  _store = new RedisStore(client);
  return _store;
}
