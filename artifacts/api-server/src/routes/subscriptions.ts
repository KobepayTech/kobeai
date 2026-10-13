import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, feeTransactionsTable, subscriptionCacheTable, usersTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import {
  activateSubscription,
  getCachedSubscription,
  getSyncStatus,
  pushRosterOnce,
} from "../lib/central-sync";
import { FEATURE_LABELS, PREMIUM_FEATURES, enforcementOn } from "../lib/entitlements";
import { logger } from "../lib/logger";

// ===========================================================================
// Subscription state, school-side.
//
// A K9 subscription is sold PER STUDENT PER YEAR, held on central and cached
// here so the school keeps working when central is unreachable. It is not the
// school's own fees (routes/fees.ts) — different money, owed by different
// people to different people, and the two are never netted. It is also keyed
// to the STUDENT, never a phone or a device, so it survives a parent changing
// SIM and a child changing class.
//
// What it buys is defined in one place, lib/entitlements.ts: the intelligence
// profile, and never a child's attendance, safety or school record.
//
// Nothing in this file gates anything. It provisions, it activates when the
// school has collected the money, and it makes the state legible — because
// the order that works is provision, then show, then enforce.
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
    enforcement_on: enforcementOn(),
    // What a subscription buys, straight from lib/entitlements.ts, so the
    // dashboard never keeps its own copy of the boundary.
    premium_features: PREMIUM_FEATURES.map((f) => ({ code: f, label: FEATURE_LABELS[f] })),
    always_included: [
      "Attendance and presence",
      "Identity and safety",
      "Timetable and exams",
      "Marks and report cards",
    ],
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
 * POST /v1/subscriptions/activate — the school collected the K9 fee.
 * Body: { student_id, months?, fee_transaction_id?, note? }
 *
 * This is how the commercial model is meant to work in a Tanzanian school:
 * the K9 annual fee sits on the same fee slip as everything else, the bursar
 * receipts it with the rest, and central simply hears "paid up until <date>".
 * No parent is asked to run a separate app payment for a service their child
 * reaches through the school's own computers.
 *
 * `fee_transaction_id` is the evidence — a payment already on the school's
 * own ledger, for this student. It is optional only because a school may run
 * its books elsewhere; when it is given it is verified, and either way the
 * activation is traceable.
 */
router.post("/v1/subscriptions/activate", admin, async (req, res) => {
  const studentId = Number(req.body?.student_id);
  const months = Math.min(36, Math.max(1, Number(req.body?.months ?? 12)));
  const feeTxId = req.body?.fee_transaction_id == null ? null : Number(req.body.fee_transaction_id);

  const [student] = await db
    .select({ id: usersTable.id, name: usersTable.name, student_code: usersTable.student_code })
    .from(usersTable)
    .where(and(eq(usersTable.id, studentId), eq(usersTable.role, "student")))
    .limit(1);
  if (!student?.student_code) {
    res.status(404).json({ error: "No such student, or they have no student code yet." });
    return;
  }

  let reference = String(req.body?.note ?? "").trim().slice(0, 120) || null;
  if (feeTxId != null) {
    const [tx] = await db
      .select()
      .from(feeTransactionsTable)
      .where(eq(feeTransactionsTable.id, feeTxId))
      .limit(1);
    if (!tx || tx.student_id !== student.id || tx.kind !== "payment") {
      res.status(400).json({
        error: "That payment is not on this student's account — activate from their own receipt.",
      });
      return;
    }
    reference = `fee_tx:${tx.id}${tx.reference ? ` ${tx.reference}` : ""}`;
  }

  const result = await activateSubscription({
    student_code: student.student_code,
    months,
    reference,
    collected_by: "school",
  });
  if (!result) {
    res.status(503).json({
      error:
        "Could not reach the KobeAI control plane to record the activation. " +
        "The payment is still on the school's ledger — try again shortly.",
    });
    return;
  }
  logger.info({ student: student.student_code, months, reference }, "K9 subscription activated by the school");
  res.json({ student: student.name, student_code: student.student_code, ...result, months });
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
