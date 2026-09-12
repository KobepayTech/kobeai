import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { db, subscriptionCacheTable, usersTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { getCachedSubscription, getSyncStatus, pushRosterOnce } from "../lib/central-sync";
import { logger } from "../lib/logger";

// ===========================================================================
// Subscription state, school-side.
//
// Subscriptions are KobeAI's TSh-per-student-per-month, held on central and
// cached here so the school keeps working when central is unreachable. They
// are NOT the school's own fees (see routes/fees.ts) — different money, owed
// by different people to different people, and the two are never netted.
//
// These endpoints exist because of the order enforcement has to happen in:
// provision, then SHOW, then enforce. A 402 that arrives without warning
// produces an angry parent at the office; a countdown visible for two weeks
// produces a payment. Nothing here gates anything — it only makes the state
// legible to the people who have to act on it.
// ===========================================================================

const router = Router();
const staff = requireAuth(["teacher", "admin", "super_admin"]);
const admin = requireAuth(["admin", "super_admin"]);

const DAY = 86_400_000;

/**
 * GET /v1/subscriptions/state — the whole picture for the school office.
 *
 * Deliberately includes the unprovisioned count: a student in `users` with no
 * cached subscription is a student who would be blocked the moment
 * ENFORCE_SUBSCRIPTIONS is switched on, and the school should see that number
 * long before anyone flips it.
 */
router.get("/v1/subscriptions/state", staff, async (_req, res) => {
  const sync = getSyncStatus();

  const [students] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(eq(usersTable.role, "student"));

  const byStatus = await db
    .select({ status: subscriptionCacheTable.status, n: sql<number>`count(*)::int` })
    .from(subscriptionCacheTable)
    .groupBy(subscriptionCacheTable.status);

  // Students the school has that central has never heard of.
  const [unprovisioned] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(
      sql`${usersTable.role} = 'student'
          AND ${usersTable.student_code} IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM subscription_cache c
             WHERE c.student_code = ${usersTable.student_code}
          )`,
    );

  const soon = await db
    .select({
      student_code: subscriptionCacheTable.student_code,
      student_name: subscriptionCacheTable.student_name,
      status: subscriptionCacheTable.status,
      expires_at: subscriptionCacheTable.expires_at,
    })
    .from(subscriptionCacheTable)
    .where(
      sql`${subscriptionCacheTable.expires_at} IS NOT NULL
          AND ${subscriptionCacheTable.expires_at} <= now() + interval '14 days'`,
    )
    .orderBy(subscriptionCacheTable.expires_at)
    .limit(200);

  res.json({
    sync,
    counts: {
      students: students?.n ?? 0,
      cached: byStatus.reduce((sum, r) => sum + r.n, 0),
      unprovisioned: unprovisioned?.n ?? 0,
      by_status: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    },
    // What switching enforcement on would do today, without switching it on.
    would_block: (unprovisioned?.n ?? 0) + (byStatus.find((r) => r.status === "expired")?.n ?? 0),
    expiring_soon: soon.map((s) => ({
      ...s,
      days_left: s.expires_at
        ? Math.max(0, Math.ceil((s.expires_at.getTime() - Date.now()) / DAY))
        : null,
    })),
  });
});

/**
 * POST /v1/subscriptions/push — provision now rather than on the next tick.
 * The roster push runs on the sync timer and after every roster commit; this
 * is the button for when an administrator has just fixed something and does
 * not want to wait a minute to see it.
 */
router.post("/v1/subscriptions/push", admin, async (_req, res) => {
  const result = await pushRosterOnce();
  if (!result) {
    res.status(503).json({
      error:
        "Could not reach the KobeAI control plane. The school keeps working; " +
        "this will retry on its own.",
    });
    return;
  }
  logger.info({ created: result.created, over_cap: result.over_cap.length }, "manual roster push");
  res.json(result);
});

/**
 * GET /v1/student/subscription — what the student's own screen shows.
 * Read-only and never gated: a student whose subscription has lapsed still
 * gets told so, which is the whole point of showing it.
 */
router.get("/v1/student/subscription", requireAuth(["student"]), async (req, res) => {
  const code = req.auth?.student_id;
  if (!code) return void res.status(401).json({ error: "no student" });
  const sub = await getCachedSubscription(code);
  if (!sub) {
    return void res.json({ status: "uncached", expires_at: null, days_left: null, message: null });
  }
  const daysLeft = sub.expires_at
    ? Math.ceil((sub.expires_at.getTime() - Date.now()) / DAY)
    : null;
  let message: string | null = null;
  if (sub.status === "expired") {
    message = "Your KobeAI membership has ended. Ask at the office to renew it.";
  } else if (sub.status === "grace") {
    message = "Your membership has lapsed. It still works for a few more days.";
  } else if (daysLeft != null && daysLeft <= 7) {
    message = `Your membership ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`;
  }
  res.json({
    status: sub.status,
    plan: sub.plan,
    expires_at: sub.expires_at?.toISOString() ?? null,
    days_left: daysLeft,
    message,
  });
});

export default router;
