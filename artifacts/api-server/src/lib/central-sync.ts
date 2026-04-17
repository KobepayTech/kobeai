import { db, subscriptionCacheTable, usersTable } from "@workspace/db";
import { eq, sql, count, inArray } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger";
import { snapshotUsage } from "./usage-counter";

// ---------------------------------------------------------------------------
// Local sync agent — runs INSIDE each school's api-server. Periodically pulls
// the subscription snapshot from the central server and writes it to the
// local `subscription_cache` table. Reads the cache when middleware needs
// to gate a request, so a school keeps working when central is unreachable.
// ---------------------------------------------------------------------------

// Read env lazily — `index.ts` may set CENTRAL_BASE_URL / TENANT_LICENSE_KEY
// after the seed runs, which is later than module-load time.
const cfg = () => ({
  CENTRAL_BASE_URL: process.env["CENTRAL_BASE_URL"] ?? "",
  TENANT_LICENSE_KEY: process.env["TENANT_LICENSE_KEY"] ?? "",
  SYNC_INTERVAL_MS: Number(process.env["CENTRAL_SYNC_INTERVAL_MS"] ?? 60_000),
  ENFORCE_SUBSCRIPTIONS: (process.env["ENFORCE_SUBSCRIPTIONS"] ?? "false") === "true",
});

let lastSyncAt: Date | null = null;
let lastSyncError: string | null = null;
let subscriptionCount = 0;

export function getSyncStatus() {
  const c = cfg();
  return {
    enabled: !!(c.CENTRAL_BASE_URL && c.TENANT_LICENSE_KEY),
    enforce: c.ENFORCE_SUBSCRIPTIONS,
    central_base_url: c.CENTRAL_BASE_URL || null,
    interval_ms: c.SYNC_INTERVAL_MS,
    last_sync_at: lastSyncAt?.toISOString() ?? null,
    last_sync_error: lastSyncError,
    cached_subscriptions: subscriptionCount,
  };
}

/** Pull once. Errors are swallowed and reported via getSyncStatus(). */
export async function syncOnce(): Promise<void> {
  const { CENTRAL_BASE_URL, TENANT_LICENSE_KEY } = cfg();
  if (!CENTRAL_BASE_URL || !TENANT_LICENSE_KEY) return;
  try {
    const res = await fetch(`${CENTRAL_BASE_URL}/api/central/v1/sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tenant-license-key": TENANT_LICENSE_KEY,
      },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      lastSyncError = `central sync HTTP ${res.status}`;
      logger.warn({ status: res.status }, "central sync failed");
      return;
    }
    const body = (await res.json()) as {
      subscriptions: Array<{
        student_code: string;
        student_name?: string | null;
        status: string;
        plan: string;
        monthly_price_tsh?: number | null;
        parent_phone?: string | null;
        expires_at: string | null;
      }>;
    };
    // Atomic replace: upsert every incoming row, then delete rows that
    // weren't in the snapshot. Wrapped in a transaction so a concurrent
    // `requireActiveSubscription` read never observes an empty cache (which
    // would otherwise cause spurious HTTP 402s under ENFORCE_SUBSCRIPTIONS).
    const incomingCodes = body.subscriptions.map((s) => s.student_code);
    await db.transaction(async (tx) => {
      for (const s of body.subscriptions) {
        await tx
          .insert(subscriptionCacheTable)
          .values({
            student_code: s.student_code,
            student_name: s.student_name ?? null,
            status: s.status,
            plan: s.plan,
            monthly_price_tsh: s.monthly_price_tsh ?? 0,
            parent_phone: s.parent_phone ?? null,
            expires_at: s.expires_at ? new Date(s.expires_at) : null,
            synced_at: new Date(),
          })
          .onConflictDoUpdate({
            target: subscriptionCacheTable.student_code,
            set: {
              student_name: s.student_name ?? null,
              status: s.status,
              plan: s.plan,
              monthly_price_tsh: s.monthly_price_tsh ?? 0,
              parent_phone: s.parent_phone ?? null,
              expires_at: s.expires_at ? new Date(s.expires_at) : null,
              synced_at: new Date(),
            },
          });
      }
      if (incomingCodes.length === 0) {
        await tx.delete(subscriptionCacheTable);
      } else {
        await tx.execute(
          sql`delete from ${subscriptionCacheTable} where ${subscriptionCacheTable.student_code} not in (${sql.join(
            incomingCodes.map((c) => sql`${c}`),
            sql`, `,
          )})`,
        );
      }
    });
    subscriptionCount = body.subscriptions.length;
    lastSyncAt = new Date();
    lastSyncError = null;
    logger.info({ count: subscriptionCount }, "central sync ok");
  } catch (err) {
    lastSyncError = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "central sync threw");
  }
}

/**
 * Push a usage snapshot UP to central. Counts:
 *  - students_total = users with role=student in this school's local DB
 *  - students_active_24h = subscription_cache rows in active/trial/grace
 *  - ai_questions_24h, print_jobs_24h = in-process rolling counters
 *
 * Failures are swallowed (best-effort telemetry; never block the school).
 */
export async function pushUsageOnce(): Promise<void> {
  const { CENTRAL_BASE_URL, TENANT_LICENSE_KEY } = cfg();
  if (!CENTRAL_BASE_URL || !TENANT_LICENSE_KEY) return;
  try {
    const [{ n: totalStudents } = { n: 0 }] = await db
      .select({ n: count() })
      .from(usersTable)
      .where(eq(usersTable.role, "student"));
    const [{ n: activeStudents } = { n: 0 }] = await db
      .select({ n: count() })
      .from(subscriptionCacheTable)
      .where(inArray(subscriptionCacheTable.status, ["active", "trial", "grace"]));
    const { ai_questions_24h, print_jobs_24h } = snapshotUsage();
    const res = await fetch(`${CENTRAL_BASE_URL}/api/central/v1/usage`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant-license-key": TENANT_LICENSE_KEY },
      body: JSON.stringify({
        students_total: totalStudents,
        students_active_24h: activeStudents,
        ai_questions_24h,
        print_jobs_24h,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "usage push failed");
      return;
    }
    logger.info({ totalStudents, activeStudents, ai_questions_24h, print_jobs_24h }, "usage pushed");
  } catch (err) {
    logger.warn({ err }, "usage push threw");
  }
}

const USAGE_PUSH_INTERVAL_MS = Number(process.env["CENTRAL_USAGE_PUSH_INTERVAL_MS"] ?? 60_000);

let timer: NodeJS.Timeout | null = null;
let usageTimer: NodeJS.Timeout | null = null;
export function startCentralSync(): void {
  const { CENTRAL_BASE_URL, TENANT_LICENSE_KEY, SYNC_INTERVAL_MS } = cfg();
  if (!CENTRAL_BASE_URL || !TENANT_LICENSE_KEY) {
    logger.info("central sync disabled (CENTRAL_BASE_URL or TENANT_LICENSE_KEY unset)");
    return;
  }
  if (timer) return;
  // Fire-and-forget the first pull immediately so the cache populates on boot.
  void syncOnce();
  timer = setInterval(() => void syncOnce(), SYNC_INTERVAL_MS);
  // Push initial snapshot after a short delay (let subscription cache populate
  // first so students_active_24h isn't zero on the first push).
  setTimeout(() => void pushUsageOnce(), 5_000);
  usageTimer = setInterval(() => void pushUsageOnce(), USAGE_PUSH_INTERVAL_MS);
  logger.info({ interval_ms: SYNC_INTERVAL_MS, usage_push_ms: USAGE_PUSH_INTERVAL_MS }, "central sync started");
}

/**
 * Returns the cached subscription for a student, or null if uncached.
 * Treats `active`, `trial`, and `grace` as allowed; `expired` is blocked.
 */
export async function getCachedSubscription(student_code: string) {
  const [row] = await db
    .select()
    .from(subscriptionCacheTable)
    .where(eq(subscriptionCacheTable.student_code, student_code));
  return row ?? null;
}

const ALLOWED_STATUSES = new Set(["active", "trial", "grace"]);

/**
 * Express middleware that gates premium endpoints by per-student subscription.
 * - Requires `req.auth.student_id` (i.e. used after `requireAuth(["student"])`).
 * - When ENFORCE_SUBSCRIPTIONS=false (default in dev) it lets the call through
 *   but adds an `x-subscription-status` header so clients can still see state.
 */
export function requireActiveSubscription() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const code = req.auth?.student_id;
    if (!code) {
      // Not a student call (or auth middleware missed). Defer to caller.
      next();
      return;
    }
    const sub = await getCachedSubscription(code);
    const status = sub?.status ?? "uncached";
    res.setHeader("x-subscription-status", status);
    if (!cfg().ENFORCE_SUBSCRIPTIONS) {
      next();
      return;
    }
    if (!sub) {
      // Fail-open if we've never synced; fail-closed once we know the student.
      // This keeps brand-new schools usable before their first sync completes.
      if (!lastSyncAt) {
        next();
        return;
      }
      res.status(402).json({ error: "No subscription on file for this student", student_code: code });
      return;
    }
    if (!ALLOWED_STATUSES.has(sub.status)) {
      res.status(402).json({
        error: `Subscription ${sub.status}. Please ask the parent to renew.`,
        student_code: code,
        status: sub.status,
      });
      return;
    }
    next();
  };
}
