import type { Request, Response, NextFunction } from "express";

/**
 * Lightweight, dependency-free fixed-window rate limiter. Single-process only —
 * fine for a school server (one node) but won't share state across replicas. If
 * we ever shard the school API, swap the Map for a Redis INCR-with-expiry.
 */
export type RateLimitOptions = {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per key per window. */
  max: number;
  /** Derive the bucket key from a request. Defaults to client IP. */
  keyGenerator?: (req: Request) => string;
  /** Optional human-friendly tag included in 429 bodies + headers. */
  name?: string;
};

type Bucket = { count: number; resetAt: number };

export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max } = opts;
  const keyGen = opts.keyGenerator ?? defaultKey;
  const buckets = new Map<string, Bucket>();

  // Cheap janitor: clear stale entries on every Nth request so the Map can't
  // grow unbounded under sustained traffic from many distinct IPs.
  let writes = 0;

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const key = `${opts.name ?? "rl"}:${keyGen(req)}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    writes += 1;
    if (writes % 1024 === 0) sweep(buckets, now);

    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "rate_limited", retry_after_s: retryAfter });
      return;
    }
    next();
  };
}

function defaultKey(req: Request): string {
  // Express trusts X-Forwarded-For only when `app.set("trust proxy", ...)` is
  // configured. Our school server typically sits behind nginx; if you trust
  // that proxy, set it in app.ts. Until then, req.ip falls back to the socket
  // address which is the safe default.
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function sweep(buckets: Map<string, Bucket>, now: number): void {
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}
