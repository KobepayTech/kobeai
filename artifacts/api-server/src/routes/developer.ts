// Developer Portal API — sign-up, login, paid account, app CRUD, earnings.
//
// Authentication: developers are NOT in `users` table. They have their own
// `developers` table and sign in with email + password (bcrypt). The JWT
// carries role="developer" + developer_id, validated by requireDeveloper.
//
// Plan flow:
//   1. Sign up (free)               -> plan="none",     plan_status="inactive"
//   2. Subscribe (pick Indie/Studio) -> creates developer_payments row,
//                                       plan="indie|studio", plan_status="pending_payment"
//   3. Super-admin verifies M-Pesa  -> plan_status="active", plan_expires_at=+1y
//   4. Dev can publish apps                          (gated on plan_status="active")

import { Router } from "express";
import bcrypt from "bcryptjs";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  developersTable,
  developerPaymentsTable,
  miniAppsTable,
  miniAppVersionsTable,
  miniAppPurchasesTable,
} from "@workspace/db";
import { signToken, requireDeveloper } from "../lib/auth";
import { SUBSCRIPTION_PLANS } from "../lib/mini-app-pricing";

const router = Router();

// ---------------------------------------------------------------------------
// Public: sign-up + login
// ---------------------------------------------------------------------------
router.post("/v1/dev/signup", async (req, res) => {
  const { email, password, display_name } = req.body ?? {};
  if (!email || !password || !display_name) {
    return res.status(400).json({ error: "email, password, display_name required" });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }
  const existing = await db
    .select()
    .from(developersTable)
    .where(eq(developersTable.email, String(email).toLowerCase()))
    .limit(1);
  if (existing.length) return res.status(409).json({ error: "email already registered" });

  const password_hash = await bcrypt.hash(String(password), 10);
  const [dev] = await db
    .insert(developersTable)
    .values({
      email: String(email).toLowerCase(),
      display_name: String(display_name),
      password_hash,
    })
    .returning();
  const token = signToken({
    role: "developer",
    user_id: 0,
    developer_id: dev.id,
    email: dev.email,
    name: dev.display_name,
  });
  return res.status(201).json({ token, developer: sanitize(dev) });
});

router.post("/v1/dev/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: "email + password required" });
  const [dev] = await db
    .select()
    .from(developersTable)
    .where(eq(developersTable.email, String(email).toLowerCase()))
    .limit(1);
  if (!dev) return res.status(401).json({ error: "invalid credentials" });
  if (dev.banned) return res.status(403).json({ error: "account suspended" });
  const ok = await bcrypt.compare(String(password), dev.password_hash);
  if (!ok) return res.status(401).json({ error: "invalid credentials" });
  const token = signToken({
    role: "developer",
    user_id: 0,
    developer_id: dev.id,
    email: dev.email,
    name: dev.display_name,
  });
  return res.json({ token, developer: sanitize(dev) });
});

// ---------------------------------------------------------------------------
// Authenticated: profile + plan
// ---------------------------------------------------------------------------
router.use("/v1/dev", requireDeveloper());

router.get("/v1/dev/me", async (req, res) => {
  const dev = await loadDev(req.auth!.developer_id!);
  if (!dev) return res.status(404).json({ error: "developer not found" });
  return res.json({ developer: sanitize(dev), plans: SUBSCRIPTION_PLANS });
});

router.patch("/v1/dev/me", async (req, res) => {
  const { display_name, bio, website, payout_method, payout_account } = req.body ?? {};
  const updates: Record<string, unknown> = {};
  if (display_name !== undefined) updates.display_name = String(display_name);
  if (bio !== undefined) updates.bio = String(bio);
  if (website !== undefined) updates.website = String(website);
  if (payout_method !== undefined) updates.payout_method = String(payout_method);
  if (payout_account !== undefined) updates.payout_account = String(payout_account);
  if (!Object.keys(updates).length) return res.json({ ok: true });
  const [dev] = await db
    .update(developersTable)
    .set(updates)
    .where(eq(developersTable.id, req.auth!.developer_id!))
    .returning();
  return res.json({ developer: sanitize(dev) });
});

router.post("/v1/dev/subscribe", async (req, res) => {
  const { plan, mpesa_reference } = req.body ?? {};
  const planDef = SUBSCRIPTION_PLANS[plan as keyof typeof SUBSCRIPTION_PLANS];
  if (!planDef) return res.status(400).json({ error: "unknown plan" });
  if (!mpesa_reference || String(mpesa_reference).length < 6) {
    return res.status(400).json({ error: "mpesa_reference required (>=6 chars)" });
  }
  const devId = req.auth!.developer_id!;
  await db.insert(developerPaymentsTable).values({
    developer_id: devId,
    kind: "subscription",
    plan: planDef.code,
    amount_tsh: planDef.price_tsh_per_year,
    reference: String(mpesa_reference),
    status: "pending",
  });
  await db
    .update(developersTable)
    .set({ plan: planDef.code, plan_status: "pending_payment" })
    .where(eq(developersTable.id, devId));
  return res.json({ ok: true, message: "Payment recorded — awaiting super-admin verification." });
});

router.get("/v1/dev/payments", async (req, res) => {
  const rows = await db
    .select()
    .from(developerPaymentsTable)
    .where(eq(developerPaymentsTable.developer_id, req.auth!.developer_id!))
    .orderBy(desc(developerPaymentsTable.created_at));
  return res.json({ payments: rows });
});

// ---------------------------------------------------------------------------
// App management
// ---------------------------------------------------------------------------
router.get("/v1/dev/apps", async (req, res) => {
  const apps = await db
    .select()
    .from(miniAppsTable)
    .where(eq(miniAppsTable.developer_id, req.auth!.developer_id!))
    .orderBy(desc(miniAppsTable.updated_at));
  return res.json({ apps });
});

router.post("/v1/dev/apps", async (req, res) => {
  const dev = await loadDev(req.auth!.developer_id!);
  if (!dev) return res.status(404).json({ error: "developer not found" });
  if (dev.plan_status !== "active") {
    return res.status(402).json({
      error: "active subscription required to create apps",
      hint: "POST /v1/dev/subscribe with a plan + mpesa_reference, then wait for verification.",
    });
  }
  const planDef = SUBSCRIPTION_PLANS[dev.plan as keyof typeof SUBSCRIPTION_PLANS];
  if (planDef && dev.total_published_apps >= planDef.max_apps) {
    return res.status(403).json({
      error: `plan limit reached (${planDef.max_apps} apps for ${planDef.name})`,
    });
  }
  const { slug, name, description, icon, category, type, price_kp, price_tsh, manifest } =
    req.body ?? {};
  if (!slug || !name || !type || !manifest) {
    return res.status(400).json({ error: "slug, name, type, manifest required" });
  }
  if (!isValidType(type)) {
    return res.status(400).json({
      error: "type must be one of: flashcards, quiz, reading, counter, timer",
    });
  }
  // Prevent slug clash within developer
  const exists = await db
    .select()
    .from(miniAppsTable)
    .where(
      and(
        eq(miniAppsTable.developer_id, dev.id),
        eq(miniAppsTable.slug, String(slug)),
      ),
    )
    .limit(1);
  if (exists.length) return res.status(409).json({ error: "slug already used by this developer" });

  const [app] = await db
    .insert(miniAppsTable)
    .values({
      developer_id: dev.id,
      slug: String(slug),
      name: String(name),
      description: description ? String(description) : null,
      icon: icon ? String(icon) : null,
      category: String(category ?? "other"),
      type: String(type),
      price_kp: Math.max(0, Number(price_kp ?? 0) | 0),
      price_tsh: Math.max(0, Number(price_tsh ?? 0) | 0),
      status: "draft",
    })
    .returning();
  const [version] = await db
    .insert(miniAppVersionsTable)
    .values({ app_id: app.id, version: 1, manifest, status: "submitted" })
    .returning();
  await db
    .update(miniAppsTable)
    .set({ current_version_id: version.id })
    .where(eq(miniAppsTable.id, app.id));
  return res.status(201).json({ app: { ...app, current_version_id: version.id }, version });
});

router.patch("/v1/dev/apps/:id", async (req, res) => {
  const id = Number(req.params.id);
  const app = await ownedApp(id, req.auth!.developer_id!);
  if (!app) return res.status(404).json({ error: "app not found" });
  if (app.status === "approved" && (req.body?.manifest || req.body?.type)) {
    return res
      .status(409)
      .json({ error: "submit a new version instead of editing an approved app" });
  }
  const updates: Record<string, unknown> = { updated_at: new Date() };
  for (const k of ["name", "description", "icon", "category"] as const) {
    if (req.body?.[k] !== undefined) updates[k] = String(req.body[k]);
  }
  if (req.body?.price_kp !== undefined) updates.price_kp = Math.max(0, Number(req.body.price_kp) | 0);
  if (req.body?.price_tsh !== undefined) updates.price_tsh = Math.max(0, Number(req.body.price_tsh) | 0);
  if (req.body?.manifest !== undefined) {
    // bump version
    const [latest] = await db
      .select()
      .from(miniAppVersionsTable)
      .where(eq(miniAppVersionsTable.app_id, id))
      .orderBy(desc(miniAppVersionsTable.version))
      .limit(1);
    const nextV = (latest?.version ?? 0) + 1;
    const [version] = await db
      .insert(miniAppVersionsTable)
      .values({ app_id: id, version: nextV, manifest: req.body.manifest, status: "submitted" })
      .returning();
    updates.current_version_id = version.id;
    updates.status = "draft"; // back to draft; dev must submit again
  }
  const [updated] = await db
    .update(miniAppsTable)
    .set(updates)
    .where(eq(miniAppsTable.id, id))
    .returning();
  return res.json({ app: updated });
});

router.post("/v1/dev/apps/:id/submit", async (req, res) => {
  const id = Number(req.params.id);
  const app = await ownedApp(id, req.auth!.developer_id!);
  if (!app) return res.status(404).json({ error: "app not found" });
  if (app.status === "approved") return res.json({ ok: true, status: "approved" });
  if (app.status === "submitted") return res.json({ ok: true, status: "submitted" });
  await db
    .update(miniAppsTable)
    .set({ status: "submitted", updated_at: new Date() })
    .where(eq(miniAppsTable.id, id));
  return res.json({ ok: true, status: "submitted" });
});

router.delete("/v1/dev/apps/:id", async (req, res) => {
  const id = Number(req.params.id);
  const app = await ownedApp(id, req.auth!.developer_id!);
  if (!app) return res.status(404).json({ error: "app not found" });
  await db
    .update(miniAppsTable)
    .set({ status: "removed", updated_at: new Date() })
    .where(eq(miniAppsTable.id, id));
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------
router.get("/v1/dev/earnings", async (req, res) => {
  const devId = req.auth!.developer_id!;
  const dev = await loadDev(devId);
  if (!dev) return res.status(404).json({ error: "developer not found" });

  // Per-app totals
  const apps = await db
    .select()
    .from(miniAppsTable)
    .where(eq(miniAppsTable.developer_id, devId));
  const appIds = apps.map((a) => a.id);
  const purchases = appIds.length
    ? await db
        .select()
        .from(miniAppPurchasesTable)
        .where(inArray(miniAppPurchasesTable.app_id, appIds))
        .orderBy(desc(miniAppPurchasesTable.paid_at))
        .limit(200)
    : [];
  const perApp = appIds.map((id) => {
    const rows = purchases.filter((p) => p.app_id === id);
    return {
      app_id: id,
      name: apps.find((a) => a.id === id)?.name,
      installs: apps.find((a) => a.id === id)?.total_installs ?? 0,
      total_kp: rows.reduce((s, r) => s + r.dev_share_kp, 0),
      total_tsh: rows.reduce((s, r) => s + r.dev_share_tsh, 0),
    };
  });
  return res.json({
    summary: {
      total_earnings_tsh: dev.total_earnings_tsh,
      total_earnings_kp: dev.total_earnings_kp,
      unpaid_balance_tsh: dev.unpaid_balance_tsh,
      unpaid_balance_kp: dev.unpaid_balance_kp,
      total_installs: dev.total_installs,
    },
    per_app: perApp,
    recent_purchases: purchases.slice(0, 50),
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sanitize(dev: typeof developersTable.$inferSelect) {
  const { password_hash, ...rest } = dev;
  void password_hash;
  return rest;
}

async function loadDev(id: number) {
  const [dev] = await db.select().from(developersTable).where(eq(developersTable.id, id));
  return dev ?? null;
}

async function ownedApp(id: number, devId: number) {
  const [app] = await db
    .select()
    .from(miniAppsTable)
    .where(and(eq(miniAppsTable.id, id), eq(miniAppsTable.developer_id, devId)));
  return app ?? null;
}

function isValidType(t: unknown): boolean {
  return ["flashcards", "quiz", "reading", "counter", "timer"].includes(String(t));
}

export default router;
