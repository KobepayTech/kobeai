/**
 * Storage interface for print system state (pairings, jobs, replay nonces).
 *
 * In production we back this with Redis so that multiple backend replicas in
 * the school-server compose stack share state and survive restarts. In local
 * dev with no `REDIS_URL` set, we fall back to plain in-memory `Map`s — the
 * shape of every method is identical so route handlers don't change.
 *
 * TTLs are wall-clock milliseconds (Redis EX is in seconds, we convert).
 */

import type Redis from "ioredis";

export type Pairing = {
  id: string;
  student_id: string; // student_code (e.g. "TEST001")
  watch_session_id: string;
  printer_id: string;
  tap_box_id: string;
  created_at: number;
  expires_at: number;
  job_id: string | null;
};

export type PrintJob = {
  id: string;
  pairing_id: string;
  student_id: string;
  printer_id: string;
  document_id: string;
  document_name: string;
  status: "queued" | "downloading" | "printing" | "done" | "failed";
  status_message: string;
  created_at: number;
  expires_at: number;
};

export interface PrintStore {
  putPairing(p: Pairing, ttlMs: number): Promise<void>;
  getPairing(id: string): Promise<Pairing | null>;
  updatePairingJob(id: string, jobId: string): Promise<void>;
  /** Returns the most recent unexpired pairing for a watch session. */
  findPairingByWatchSession(watchSessionId: string): Promise<Pairing | null>;

  putJob(j: PrintJob, ttlMs: number): Promise<void>;
  getJob(id: string): Promise<PrintJob | null>;
  updateJobStatus(id: string, status: PrintJob["status"], message: string): Promise<PrintJob | null>;
  /** Returns any queued job for the printer (FIFO-ish; not strict). */
  findQueuedForPrinter(printerId: string): Promise<PrintJob | null>;

  /** Returns true if nonce was fresh (and now stored), false on replay. */
  checkAndStoreNonce(key: string, ttlMs: number): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (dev fallback)
// ---------------------------------------------------------------------------

class MemoryStore implements PrintStore {
  private pairings = new Map<string, Pairing>();
  private jobs = new Map<string, PrintJob>();
  private nonces = new Map<string, number>();

  constructor() {
    setInterval(() => this.gc(), 10_000).unref();
  }

  private gc() {
    const now = Date.now();
    for (const [id, p] of this.pairings) if (p.expires_at < now) this.pairings.delete(id);
    for (const [id, j] of this.jobs) if (j.expires_at < now) this.jobs.delete(id);
    for (const [k, exp] of this.nonces) if (exp < now) this.nonces.delete(k);
  }

  async putPairing(p: Pairing): Promise<void> { this.pairings.set(p.id, p); }
  async getPairing(id: string): Promise<Pairing | null> {
    const p = this.pairings.get(id);
    if (!p || p.expires_at < Date.now()) return null;
    return p;
  }
  async updatePairingJob(id: string, jobId: string): Promise<void> {
    const p = this.pairings.get(id);
    if (p) p.job_id = jobId;
  }
  async findPairingByWatchSession(watchSessionId: string): Promise<Pairing | null> {
    const now = Date.now();
    let latest: Pairing | null = null;
    for (const p of this.pairings.values()) {
      if (p.expires_at < now) continue;
      if (p.watch_session_id !== watchSessionId) continue;
      if (!latest || p.created_at > latest.created_at) latest = p;
    }
    return latest;
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

  async checkAndStoreNonce(key: string, ttlMs: number): Promise<boolean> {
    if (this.nonces.has(key)) return false;
    this.nonces.set(key, Date.now() + ttlMs);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

class RedisStore implements PrintStore {
  constructor(private redis: Redis) {}

  private pairKey(id: string) { return `print:pair:${id}`; }
  private jobKey(id: string) { return `print:job:${id}`; }
  private sessionKey(s: string) { return `print:session:${s}`; }
  private printerQueueKey(p: string) { return `print:queue:${p}`; }
  private nonceKey(k: string) { return `print:nonce:${k}`; }

  async putPairing(p: Pairing, ttlMs: number): Promise<void> {
    const ttl = Math.max(1, Math.floor(ttlMs / 1000));
    await this.redis.set(this.pairKey(p.id), JSON.stringify(p), "EX", ttl);
    // Track the latest pairing per watch session so the watch can poll.
    await this.redis.set(this.sessionKey(p.watch_session_id), p.id, "EX", ttl);
  }
  async getPairing(id: string): Promise<Pairing | null> {
    const raw = await this.redis.get(this.pairKey(id));
    return raw ? (JSON.parse(raw) as Pairing) : null;
  }
  async updatePairingJob(id: string, jobId: string): Promise<void> {
    const raw = await this.redis.get(this.pairKey(id));
    if (!raw) return;
    const p = JSON.parse(raw) as Pairing;
    p.job_id = jobId;
    const ttl = Math.max(1, Math.floor((p.expires_at - Date.now()) / 1000));
    if (ttl > 0) await this.redis.set(this.pairKey(id), JSON.stringify(p), "EX", ttl);
  }
  async findPairingByWatchSession(watchSessionId: string): Promise<Pairing | null> {
    const id = await this.redis.get(this.sessionKey(watchSessionId));
    return id ? this.getPairing(id) : null;
  }

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
    // front but never remove an actually-queued job — the tap-box may poll
    // /next multiple times before transitioning status to "downloading".
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

  async checkAndStoreNonce(key: string, ttlMs: number): Promise<boolean> {
    const ttl = Math.max(1, Math.floor(ttlMs / 1000));
    // SET NX: only set if missing. Returns "OK" on success, null on existing.
    const ok = await this.redis.set(this.nonceKey(key), "1", "EX", ttl, "NX");
    return ok === "OK";
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
