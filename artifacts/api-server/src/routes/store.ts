// Mini-App Store API — student-facing browse, install, purchase, review.
// Watch app + parent app both consume these endpoints.
//
// Pricing rules:
//   - price_kp  = 0 AND price_tsh = 0  -> free, install via /install
//   - otherwise                         -> paid, must hit /purchase first.
// We accept payment in EITHER currency; whichever the student has on hand.
//
// Revenue split happens at purchase time. See lib/mini-app-pricing.ts.
//
// Watch app calls:
//   GET  /v1/store/feed                 -> featured + categories
//   GET  /v1/store/apps?category=...    -> browse
//   GET  /v1/store/apps/:id             -> detail (with manifest if installed)
//   GET  /v1/store/installed            -> what THIS student has
//   POST /v1/store/apps/:id/install     -> free install
//   POST /v1/store/apps/:id/purchase    -> paid install (currency: "kp"|"tsh")
//   POST /v1/store/apps/:id/uninstall
//   POST /v1/store/apps/:id/review      -> 1-5 + comment
//   POST /v1/store/apps/:id/complete    -> award KP for finishing (free apps)

import { Router } from "express";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  developersTable,
  miniAppsTable,
  miniAppVersionsTable,
  miniAppInstallsTable,
  miniAppPurchasesTable,
  miniAppReviewsTable,
  studentKpTable,
  kpLedgerTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { splitRevenue } from "../lib/mini-app-pricing";

const router = Router();

router.use("/v1/store", requireAuth(["student", "teacher", "admin", "parent", "super_admin"]));

const APPROVED = eq(miniAppsTable.status, "approved");

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------
router.get("/v1/store/feed", async (_req, res) => {
  const apps = await db
    .select()
    .from(miniAppsTable)
    .where(APPROVED)
    .orderBy(desc(miniAppsTable.total_installs))
    .limit(60);
  const featured = apps.slice(0, 6);
  const grouped: Record<string, typeof apps> = {};
  for (const a of apps) {
    (grouped[a.category] ??= []).push(a);
  }
  return res.json({
    featured: featured.map(publicShape),
    categories: Object.entries(grouped).map(([cat, list]) => ({
      category: cat,
      apps: list.slice(0, 12).map(publicShape),
    })),
  });
});

router.get("/v1/store/apps", async (req, res) => {
  const cat = req.query.category ? String(req.query.category) : null;
  const where = cat ? and(APPROVED, eq(miniAppsTable.category, cat)) : APPROVED;
  const apps = await db
    .select()
    .from(miniAppsTable)
    .where(where)
    .orderBy(desc(miniAppsTable.total_installs))
    .limit(100);
  return res.json({ apps: apps.map(publicShape) });
});

router.get("/v1/store/apps/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [app] = await db
    .select()
    .from(miniAppsTable)
    .where(and(eq(miniAppsTable.id, id), APPROVED));
  if (!app) return res.status(404).json({ error: "app not found" });
  const [version] = app.current_version_id
    ? await db
        .select()
        .from(miniAppVersionsTable)
        .where(eq(miniAppVersionsTable.id, app.current_version_id))
    : [];
  const [dev] = await db
    .select()
    .from(developersTable)
    .where(eq(developersTable.id, app.developer_id));
  const reviews = await db
    .select()
    .from(miniAppReviewsTable)
    .where(eq(miniAppReviewsTable.app_id, id))
    .orderBy(desc(miniAppReviewsTable.created_at))
    .limit(20);
  const userId = req.auth!.user_id;
  const [install] = userId
    ? await db
        .select()
        .from(miniAppInstallsTable)
        .where(
          and(
            eq(miniAppInstallsTable.app_id, id),
            eq(miniAppInstallsTable.student_user_id, userId),
          ),
        )
    : [];
  return res.json({
    app: publicShape(app),
    developer: dev
      ? { id: dev.id, name: dev.display_name, website: dev.website ?? null }
      : null,
    manifest: install ? version?.manifest ?? null : null, // only if installed
    installed: !!install,
    reviews,
  });
});

router.get("/v1/store/installed", async (req, res) => {
  const userId = req.auth!.user_id;
  const installs = await db
    .select()
    .from(miniAppInstallsTable)
    .where(
      and(
        eq(miniAppInstallsTable.student_user_id, userId),
        sql`${miniAppInstallsTable.uninstalled_at} IS NULL`,
      ),
    )
    .orderBy(desc(miniAppInstallsTable.installed_at));
  if (!installs.length) return res.json({ installs: [] });
  const appIds = installs.map((i) => i.app_id);
  const apps = await db.select().from(miniAppsTable).where(inArray(miniAppsTable.id, appIds));
  const versions = await db
    .select()
    .from(miniAppVersionsTable)
    .where(inArray(miniAppVersionsTable.id, installs.map((i) => i.version_id)));
  return res.json({
    installs: installs.map((i) => {
      const app = apps.find((a) => a.id === i.app_id);
      const v = versions.find((v) => v.id === i.version_id);
      return {
        install_id: i.id,
        installed_at: i.installed_at,
        paid: i.paid,
        app: app ? publicShape(app) : null,
        manifest: v?.manifest ?? null,
      };
    }),
  });
});

// ---------------------------------------------------------------------------
// Install / Purchase
// ---------------------------------------------------------------------------
router.post("/v1/store/apps/:id/install", async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.auth!.user_id;
  const [app] = await db
    .select()
    .from(miniAppsTable)
    .where(and(eq(miniAppsTable.id, id), APPROVED));
  if (!app) return res.status(404).json({ error: "app not found" });
  if (app.price_kp > 0 || app.price_tsh > 0) {
    return res.status(402).json({ error: "this app is paid — use /purchase" });
  }
  if (!app.current_version_id) return res.status(409).json({ error: "no published version" });
  await ensureInstall(userId, app.id, app.current_version_id, false);
  return res.json({ ok: true });
});

router.post("/v1/store/apps/:id/purchase", async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.auth!.user_id;
  const currency = req.body?.currency === "tsh" ? "tsh" : "kp";
  const [app] = await db
    .select()
    .from(miniAppsTable)
    .where(and(eq(miniAppsTable.id, id), APPROVED));
  if (!app) return res.status(404).json({ error: "app not found" });
  if (!app.current_version_id) return res.status(409).json({ error: "no published version" });
  const price = currency === "kp" ? app.price_kp : app.price_tsh;
  if (price <= 0) return res.status(400).json({ error: `not priced in ${currency}` });

  if (currency === "kp") {
    // Atomic balance check + decrement
    const [bal] = await db.select().from(studentKpTable).where(eq(studentKpTable.user_id, userId));
    const have = bal?.balance ?? 0;
    if (have < price) return res.status(402).json({ error: "insufficient KP" });
    const newBal = have - price;
    await db
      .update(studentKpTable)
      .set({ balance: newBal, updated_at: new Date() })
      .where(eq(studentKpTable.user_id, userId));
    await db.insert(kpLedgerTable).values({
      user_id: userId,
      delta: -price,
      reason: `mini_app_purchase:${app.id}`,
      balance_after: newBal,
    });
  } else {
    // Real-money paths route through the wallet/M-Pesa flow that already
    // exists in /v1/parent/pay. For v1 of the store we accept "tsh" purchases
    // only for staff/super-admin testing. Production rollout will wire this
    // through the wallet's tsh balance once the wallet ledger gains a TSh
    // sub-balance (tracked separately).
    if (req.auth!.role !== "super_admin" && req.auth!.role !== "admin") {
      return res.status(501).json({ error: "TSh purchases not yet wired — pay in KP for now" });
    }
  }

  // Record purchase + revenue split
  const split = splitRevenue(price);
  await db.insert(miniAppPurchasesTable).values({
    student_user_id: userId,
    app_id: app.id,
    developer_id: app.developer_id,
    price_kp: currency === "kp" ? price : 0,
    price_tsh: currency === "tsh" ? price : 0,
    dev_share_kp: currency === "kp" ? split.dev_share : 0,
    dev_share_tsh: currency === "tsh" ? split.dev_share : 0,
    platform_share_kp: currency === "kp" ? split.platform_share : 0,
    platform_share_tsh: currency === "tsh" ? split.platform_share : 0,
  });
  // Credit developer
  if (currency === "kp") {
    await db
      .update(developersTable)
      .set({
        total_earnings_kp: sql`${developersTable.total_earnings_kp} + ${split.dev_share}`,
        unpaid_balance_kp: sql`${developersTable.unpaid_balance_kp} + ${split.dev_share}`,
      })
      .where(eq(developersTable.id, app.developer_id));
  } else {
    await db
      .update(developersTable)
      .set({
        total_earnings_tsh: sql`${developersTable.total_earnings_tsh} + ${split.dev_share}`,
        unpaid_balance_tsh: sql`${developersTable.unpaid_balance_tsh} + ${split.dev_share}`,
      })
      .where(eq(developersTable.id, app.developer_id));
  }

  await ensureInstall(userId, app.id, app.current_version_id, true);
  return res.json({
    ok: true,
    paid: { currency, amount: price, dev_share: split.dev_share, platform_share: split.platform_share },
  });
});

router.post("/v1/store/apps/:id/uninstall", async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.auth!.user_id;
  await db
    .update(miniAppInstallsTable)
    .set({ uninstalled_at: new Date() })
    .where(
      and(
        eq(miniAppInstallsTable.app_id, id),
        eq(miniAppInstallsTable.student_user_id, userId),
      ),
    );
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Reviews + completion
// ---------------------------------------------------------------------------
router.post("/v1/store/apps/:id/review", async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.auth!.user_id;
  const rating = Math.max(1, Math.min(5, Number(req.body?.rating ?? 0) | 0));
  if (!rating) return res.status(400).json({ error: "rating 1-5 required" });
  const comment = req.body?.comment ? String(req.body.comment).slice(0, 500) : null;
  // Upsert
  const existing = await db
    .select()
    .from(miniAppReviewsTable)
    .where(
      and(
        eq(miniAppReviewsTable.app_id, id),
        eq(miniAppReviewsTable.student_user_id, userId),
      ),
    );
  if (existing.length) {
    const old = existing[0]!.rating;
    await db
      .update(miniAppReviewsTable)
      .set({ rating, comment })
      .where(eq(miniAppReviewsTable.id, existing[0]!.id));
    await db
      .update(miniAppsTable)
      .set({ rating_sum: sql`${miniAppsTable.rating_sum} + ${rating - old}` })
      .where(eq(miniAppsTable.id, id));
  } else {
    await db
      .insert(miniAppReviewsTable)
      .values({ app_id: id, student_user_id: userId, rating, comment });
    await db
      .update(miniAppsTable)
      .set({
        rating_sum: sql`${miniAppsTable.rating_sum} + ${rating}`,
        rating_count: sql`${miniAppsTable.rating_count} + 1`,
      })
      .where(eq(miniAppsTable.id, id));
  }
  return res.json({ ok: true });
});

router.post("/v1/store/apps/:id/complete", async (req, res) => {
  // Award KP if the manifest declares a kp_reward AND user is a student.
  const id = Number(req.params.id);
  const userId = req.auth!.user_id;
  const role = req.auth!.role;
  const [app] = await db
    .select()
    .from(miniAppsTable)
    .where(and(eq(miniAppsTable.id, id), APPROVED));
  if (!app || !app.current_version_id) return res.status(404).json({ error: "app not found" });
  const [version] = await db
    .select()
    .from(miniAppVersionsTable)
    .where(eq(miniAppVersionsTable.id, app.current_version_id));
  const reward = Math.max(
    0,
    Math.min(50, Number((version?.manifest as any)?.kp_reward_per_completion ?? 0) | 0),
  );
  await db
    .update(miniAppsTable)
    .set({ total_completions: sql`${miniAppsTable.total_completions} + 1` })
    .where(eq(miniAppsTable.id, id));
  if (role === "student" && reward > 0) {
    const [bal] = await db
      .select()
      .from(studentKpTable)
      .where(eq(studentKpTable.user_id, userId));
    const newBal = (bal?.balance ?? 0) + reward;
    if (bal) {
      await db
        .update(studentKpTable)
        .set({ balance: newBal, updated_at: new Date() })
        .where(eq(studentKpTable.user_id, userId));
    } else {
      await db.insert(studentKpTable).values({ user_id: userId, balance: reward });
    }
    await db.insert(kpLedgerTable).values({
      user_id: userId,
      delta: reward,
      reason: `mini_app_completion:${app.id}`,
      balance_after: newBal,
    });
    return res.json({ ok: true, awarded_kp: reward });
  }
  return res.json({ ok: true, awarded_kp: 0 });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function publicShape(a: typeof miniAppsTable.$inferSelect) {
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    description: a.description,
    icon: a.icon,
    category: a.category,
    type: a.type,
    price_kp: a.price_kp,
    price_tsh: a.price_tsh,
    total_installs: a.total_installs,
    rating: a.rating_count > 0 ? a.rating_sum / a.rating_count : null,
    rating_count: a.rating_count,
  };
}

async function ensureInstall(userId: number, appId: number, versionId: number, paid: boolean) {
  const existing = await db
    .select()
    .from(miniAppInstallsTable)
    .where(
      and(
        eq(miniAppInstallsTable.app_id, appId),
        eq(miniAppInstallsTable.student_user_id, userId),
      ),
    );
  if (existing.length) {
    await db
      .update(miniAppInstallsTable)
      .set({ version_id: versionId, paid: existing[0]!.paid || paid, uninstalled_at: null })
      .where(eq(miniAppInstallsTable.id, existing[0]!.id));
  } else {
    await db
      .insert(miniAppInstallsTable)
      .values({ student_user_id: userId, app_id: appId, version_id: versionId, paid });
    await db
      .update(miniAppsTable)
      .set({ total_installs: sql`${miniAppsTable.total_installs} + 1` })
      .where(eq(miniAppsTable.id, appId));
    await db
      .update(developersTable)
      .set({ total_installs: sql`${developersTable.total_installs} + 1` })
      .where(
        eq(
          developersTable.id,
          (await db.select().from(miniAppsTable).where(eq(miniAppsTable.id, appId)))[0]!
            .developer_id,
        ),
      );
  }
}

export default router;
