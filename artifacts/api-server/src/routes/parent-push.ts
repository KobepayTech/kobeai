import { Router } from "express";
import webpush from "web-push";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db, pushSubscriptionsTable, parentChildrenTable, usersTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";

const router = Router();

// ---------------------------------------------------------------------------
// VAPID setup. Two flavors:
// 1. Production: VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY come from env. The
//    private key never leaves the server.
// 2. Demo: if either is missing, we generate a fresh keypair on boot and
//    keep it in-memory. The PWA fetches the public key via /v1/parent/push/
//    public-key, so re-mounting browser subscriptions just works on restart.
//    A warning is logged so operators know to set real keys before going to
//    production (rotating keys invalidates every existing subscription).
// ---------------------------------------------------------------------------
const VAPID_SUBJECT = process.env["VAPID_SUBJECT"] ?? "mailto:ops@kobeai.tz";
let vapidPublic = process.env["VAPID_PUBLIC_KEY"] ?? "";
let vapidPrivate = process.env["VAPID_PRIVATE_KEY"] ?? "";
if (!vapidPublic || !vapidPrivate) {
  const generated = webpush.generateVAPIDKeys();
  vapidPublic = generated.publicKey;
  vapidPrivate = generated.privateKey;
  logger.warn(
    "VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — generated ephemeral keys. " +
      "Existing browser push subscriptions will not survive an API restart.",
  );
}
webpush.setVapidDetails(VAPID_SUBJECT, vapidPublic, vapidPrivate);

/**
 * GET /v1/parent/push/public-key
 * Public endpoint (no auth) — the PWA needs the VAPID public key BEFORE the
 * user is logged in so the "Enable notifications" button can work from the
 * service worker registration step.
 */
router.get("/v1/parent/push/public-key", (_req, res) => {
  res.json({ public_key: vapidPublic });
});

/**
 * POST /v1/parent/push/subscribe
 * Persists a push subscription against the parent's phone (their JWT email
 * field). Idempotent on `endpoint` so re-subscribing from the same browser
 * doesn't create dupes.
 */
router.post("/v1/parent/push/subscribe", requireAuth(["parent"]), async (req, res) => {
  const phone = req.auth?.email ?? "";
  if (!phone) {
    res.status(400).json({ error: "no parent identifier in token" });
    return;
  }
  const sub = req.body?.subscription ?? req.body;
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") {
    res.status(400).json({ error: "subscription must include endpoint and keys.{p256dh,auth}" });
    return;
  }
  await db
    .insert(pushSubscriptionsTable)
    .values({ parent_phone: phone, endpoint, p256dh, auth })
    .onConflictDoUpdate({
      target: pushSubscriptionsTable.endpoint,
      set: { parent_phone: phone, p256dh, auth },
    });
  res.json({ ok: true });
});

/**
 * POST /v1/parent/push/unsubscribe
 * Deletes the subscription tied to `endpoint`. Called when the parent toggles
 * notifications off in the PWA, or when the service worker reports a 410.
 */
router.post("/v1/parent/push/unsubscribe", requireAuth(["parent"]), async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== "string") {
    res.status(400).json({ error: "endpoint required" });
    return;
  }
  await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.endpoint, endpoint));
  res.json({ ok: true });
});

/**
 * POST /v1/parent/push/send-digest
 * Demo trigger so a parent can preview what their daily digest looks like
 * without waiting 24h for the cron. Sends ONE notification per registered
 * subscription on their phone. In production this is also called by the
 * scheduler in `index.ts` (see startDailyDigest below) — wrapping the same
 * logic here keeps the digest payload definition in one place.
 */
router.post("/v1/parent/push/send-digest", requireAuth(["parent"]), async (req, res) => {
  const phone = req.auth?.email ?? "";
  if (!phone) {
    res.status(400).json({ error: "no parent identifier in token" });
    return;
  }
  const result = await sendDigestForParent(phone);
  res.json(result);
});

/**
 * Builds and sends today's digest for one parent. Pulled out so both the
 * manual trigger above and the scheduled job below share the same payload
 * shape. Returns `{ sent, failed, removed }` so callers can log progress.
 *
 * `removed` counts subscriptions that the push service rejected (404/410) —
 * those are deleted so we don't keep paying to push to dead endpoints.
 */
export async function sendDigestForParent(parentPhone: string): Promise<{
  sent: number;
  failed: number;
  removed: number;
}> {
  const subs = await db
    .select()
    .from(pushSubscriptionsTable)
    .where(eq(pushSubscriptionsTable.parent_phone, parentPhone));
  if (subs.length === 0) return { sent: 0, failed: 0, removed: 0 };

  // For now the digest is a static-ish summary. When the parent dashboard
  // grows real per-day stats, swap this for a query that joins quiz_attempts
  // + ai_questions for the parent's children over the last 24h.
  const payload = JSON.stringify({
    title: "KobeAI daily digest",
    body: "Your child completed today's lessons. Tap to see their progress.",
    url: "/profile",
    tag: "kobeai-daily",
  });

  let sent = 0;
  let failed = 0;
  let removed = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        sent++;
        await db
          .update(pushSubscriptionsTable)
          .set({ last_sent_at: sql`NOW()` })
          .where(eq(pushSubscriptionsTable.id, sub.id));
      } catch (err: unknown) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.id, sub.id));
          removed++;
        } else {
          failed++;
          logger.warn({ err, endpoint: sub.endpoint }, "push send failed");
        }
      }
    }),
  );
  return { sent, failed, removed };
}

/**
 * Send a one-off push notification to every parent linked to `studentUserId`.
 * Used by the stationery and (future) wallet flows so the parent app gets a
 * native notification the moment something needs their approval, instead of
 * waiting for the daily digest. Returns counts so the caller can log + alert.
 *
 * Failures are swallowed per-subscription (logged) so a single dead endpoint
 * never blocks the originating teacher/watch request. Dead endpoints (404/410)
 * are auto-pruned, identical to the digest path.
 */
export async function sendApprovalPushToParents(
  studentUserId: number,
  payload: { title: string; body: string; url: string; tag?: string },
): Promise<{ sent: number; failed: number; removed: number; targets: number }> {
  // Resolve parent users for this student via parent_children link.
  const parentRows = await db
    .select({ parent_user_id: parentChildrenTable.parent_user_id })
    .from(parentChildrenTable)
    .where(eq(parentChildrenTable.student_user_id, studentUserId));
  if (parentRows.length === 0) return { sent: 0, failed: 0, removed: 0, targets: 0 };
  const parentUserIds = parentRows.map((r) => r.parent_user_id);
  // Look up the phone (= push subscription key) for each parent user.
  const parents = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(inArray(usersTable.id, parentUserIds));
  const phones = parents.map((p) => p.email).filter((e): e is string => !!e);
  if (phones.length === 0) return { sent: 0, failed: 0, removed: 0, targets: 0 };
  const subs = await db
    .select()
    .from(pushSubscriptionsTable)
    .where(inArray(pushSubscriptionsTable.parent_phone, phones));
  if (subs.length === 0) return { sent: 0, failed: 0, removed: 0, targets: phones.length };
  const body = JSON.stringify({ tag: "kobeai-approval", ...payload });
  let sent = 0;
  let failed = 0;
  let removed = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        );
        sent++;
      } catch (err: unknown) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.id, sub.id));
          removed++;
        } else {
          failed++;
          logger.warn({ err, endpoint: sub.endpoint }, "approval push failed");
        }
      }
    }),
  );
  return { sent, failed, removed, targets: subs.length };
}

/**
 * Daily digest scheduler — fires once per process at 18:00 local time. We use
 * setInterval(60s) + a "have we already sent today" flag rather than node-cron
 * to avoid pulling another dep. Multiple API replicas would each fire once;
 * the last_sent_at column is what real prod would dedupe on, but for the
 * single-process demo this is fine.
 */
let digestStarted = false;
export function startDailyDigest(): void {
  if (digestStarted) return;
  digestStarted = true;
  let lastFiredOn: string | null = null;
  setInterval(() => {
    void (async () => {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      // Send around 18:00 local; broaden to a 5-minute window so we catch
      // even if the interval drifts.
      const hour = now.getHours();
      const minute = now.getMinutes();
      if (hour !== 18 || minute >= 5) return;
      if (lastFiredOn === today) return;
      lastFiredOn = today;
      try {
        const phones = await db
          .selectDistinct({ phone: pushSubscriptionsTable.parent_phone })
          .from(pushSubscriptionsTable);
        for (const { phone } of phones) {
          await sendDigestForParent(phone).catch((err) =>
            logger.warn({ err, phone }, "daily digest send failed for parent"),
          );
        }
        logger.info({ count: phones.length }, "daily digest dispatched");
      } catch (err) {
        logger.error({ err }, "daily digest job crashed");
      }
    })();
  }, 60_000);
}

export default router;
