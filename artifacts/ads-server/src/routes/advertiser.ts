// Advertiser Portal API — signup, login, campaigns, creatives, stats, topup.
//
// Authentication: advertisers live in their own `advertisers` table. JWT
// carries role="advertiser" + advertiser_id; gated by requireAdvertiser().
//
// All money is in TSh (whole units). Topup is mock M-Pesa for now — POST
// the amount, balance updates immediately, ledger row written.

import { Router } from "express";
import bcrypt from "bcryptjs";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  advertisersTable,
  adCampaignsTable,
  adCreativesTable,
  adImpressionsTable,
  adClicksTable,
  adLedgerTable,
  adPlacementsTable,
} from "@workspace/db";
import { signToken, requireAuth } from "../lib/auth";

const router = Router();

const requireAdvertiser = () => requireAuth(["advertiser"]);

// ---------------------------------------------------------------------------
// Public: signup + login
// ---------------------------------------------------------------------------
router.post("/v1/advertiser/signup", async (req, res) => {
  const { company_name, contact_email, password } = req.body ?? {};
  if (!company_name || !contact_email || !password) {
    return res
      .status(400)
      .json({ error: "company_name, contact_email, password required" });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }
  const email = String(contact_email).toLowerCase();
  const existing = await db
    .select()
    .from(advertisersTable)
    .where(eq(advertisersTable.contact_email, email))
    .limit(1);
  if (existing.length) return res.status(409).json({ error: "email already registered" });

  const password_hash = await bcrypt.hash(String(password), 10);
  const [adv] = await db
    .insert(advertisersTable)
    .values({ company_name, contact_email: email, password_hash })
    .returning();

  const token = signToken({
    role: "advertiser",
    user_id: 0,
    advertiser_id: adv!.id,
    email,
    name: company_name,
  });
  return res.json({ access_token: token, advertiser: { id: adv!.id, company_name, contact_email: email, balance_tsh: 0 } });
});

router.post("/v1/advertiser/login", async (req, res) => {
  const { contact_email, password } = req.body ?? {};
  if (!contact_email || !password) {
    return res.status(400).json({ error: "contact_email + password required" });
  }
  const email = String(contact_email).toLowerCase();
  const [adv] = await db
    .select()
    .from(advertisersTable)
    .where(eq(advertisersTable.contact_email, email));
  if (!adv) return res.status(401).json({ error: "invalid credentials" });
  const ok = await bcrypt.compare(String(password), adv.password_hash);
  if (!ok) return res.status(401).json({ error: "invalid credentials" });
  if (adv.status !== "active") return res.status(403).json({ error: "account suspended" });

  const token = signToken({
    role: "advertiser",
    user_id: 0,
    advertiser_id: adv.id,
    email,
    name: adv.company_name,
  });
  return res.json({
    access_token: token,
    advertiser: {
      id: adv.id,
      company_name: adv.company_name,
      contact_email: adv.contact_email,
      balance_tsh: adv.balance_tsh,
    },
  });
});

// ---------------------------------------------------------------------------
// Authenticated: account
// ---------------------------------------------------------------------------
router.get("/v1/advertiser/me", requireAdvertiser(), async (req, res) => {
  const id = req.auth!.advertiser_id!;
  const [adv] = await db.select().from(advertisersTable).where(eq(advertisersTable.id, id));
  if (!adv) return res.status(404).json({ error: "not found" });
  return res.json({
    id: adv.id,
    company_name: adv.company_name,
    contact_email: adv.contact_email,
    balance_tsh: adv.balance_tsh,
    status: adv.status,
  });
});

router.get("/v1/advertiser/placements", requireAdvertiser(), async (_req, res) => {
  const rows = await db.select().from(adPlacementsTable).where(eq(adPlacementsTable.active, true));
  return res.json({ placements: rows });
});

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------
router.get("/v1/advertiser/campaigns", requireAdvertiser(), async (req, res) => {
  const id = req.auth!.advertiser_id!;
  const rows = await db
    .select()
    .from(adCampaignsTable)
    .where(eq(adCampaignsTable.advertiser_id, id))
    .orderBy(desc(adCampaignsTable.created_at));
  return res.json({ campaigns: rows });
});

router.post("/v1/advertiser/campaigns", requireAdvertiser(), async (req, res) => {
  const advId = req.auth!.advertiser_id!;
  const {
    name,
    pricing_model,
    bid_amount_tsh,
    daily_budget_tsh,
    total_budget_tsh,
    placements,
    targeting,
    starts_at,
    ends_at,
    flat_period_days,
  } = req.body ?? {};
  if (!name || !pricing_model || !bid_amount_tsh || !Array.isArray(placements) || placements.length === 0) {
    return res.status(400).json({ error: "name, pricing_model, bid_amount_tsh, placements[] required" });
  }
  if (!["cpm", "cpc", "flat"].includes(pricing_model)) {
    return res.status(400).json({ error: "pricing_model must be cpm|cpc|flat" });
  }
  const [c] = await db
    .insert(adCampaignsTable)
    .values({
      advertiser_id: advId,
      name,
      pricing_model,
      bid_amount_tsh: Number(bid_amount_tsh),
      daily_budget_tsh: Number(daily_budget_tsh ?? 0),
      total_budget_tsh: Number(total_budget_tsh ?? 0),
      placements: placements as string[],
      targeting: targeting ?? null,
      starts_at: starts_at ? new Date(starts_at) : new Date(),
      ends_at: ends_at ? new Date(ends_at) : null,
      flat_period_days: Number(flat_period_days ?? 7),
      status: "draft",
    })
    .returning();
  return res.json({ campaign: c });
});

router.patch("/v1/advertiser/campaigns/:id", requireAdvertiser(), async (req, res) => {
  const advId = req.auth!.advertiser_id!;
  const id = Number(req.params["id"]);
  const [existing] = await db.select().from(adCampaignsTable).where(eq(adCampaignsTable.id, id));
  if (!existing || existing.advertiser_id !== advId) {
    return res.status(404).json({ error: "not found" });
  }
  const allowed: Record<string, unknown> = {};
  for (const k of [
    "name",
    "bid_amount_tsh",
    "daily_budget_tsh",
    "total_budget_tsh",
    "placements",
    "targeting",
    "ends_at",
    "status",
  ]) {
    if (k in req.body) allowed[k] = req.body[k];
  }
  if (allowed["status"]) {
    const next = String(allowed["status"]);
    if (!["draft", "active", "paused", "ended"].includes(next)) {
      return res.status(400).json({ error: "invalid status transition" });
    }
    // Advertisers may not reactivate campaigns that admin moderation or the
    // billing system has locked. Only admin routes can clear those states.
    const locked = ["rejected", "exhausted", "ended"];
    if (locked.includes(existing.status)) {
      return res
        .status(403)
        .json({ error: `campaign status '${existing.status}' is locked; contact support` });
    }
    // Allowed transitions advertiser-side: draft↔active, active↔paused,
    // paused→active, anything→ended (advertiser may end their own campaign).
    const transitions: Record<string, string[]> = {
      draft: ["draft", "active", "ended"],
      active: ["active", "paused", "ended"],
      paused: ["paused", "active", "ended"],
    };
    const allowedNexts = transitions[existing.status] ?? [];
    if (!allowedNexts.includes(next)) {
      return res.status(400).json({
        error: `cannot transition from '${existing.status}' to '${next}'`,
      });
    }
  }
  if (allowed["ends_at"]) allowed["ends_at"] = new Date(String(allowed["ends_at"]));
  allowed["updated_at"] = new Date();
  const [updated] = await db
    .update(adCampaignsTable)
    .set(allowed)
    .where(eq(adCampaignsTable.id, id))
    .returning();
  return res.json({ campaign: updated });
});

// ---------------------------------------------------------------------------
// Creatives
// ---------------------------------------------------------------------------
router.get("/v1/advertiser/campaigns/:id/creatives", requireAdvertiser(), async (req, res) => {
  const advId = req.auth!.advertiser_id!;
  const id = Number(req.params["id"]);
  const [c] = await db.select().from(adCampaignsTable).where(eq(adCampaignsTable.id, id));
  if (!c || c.advertiser_id !== advId) return res.status(404).json({ error: "not found" });
  const rows = await db.select().from(adCreativesTable).where(eq(adCreativesTable.campaign_id, id));
  return res.json({ creatives: rows });
});

router.post("/v1/advertiser/campaigns/:id/creatives", requireAdvertiser(), async (req, res) => {
  const advId = req.auth!.advertiser_id!;
  const id = Number(req.params["id"]);
  const [c] = await db.select().from(adCampaignsTable).where(eq(adCampaignsTable.id, id));
  if (!c || c.advertiser_id !== advId) return res.status(404).json({ error: "not found" });

  const { format, title, body, image_url, cta_url, cta_label, width, height } = req.body ?? {};
  if (!format || !title || !cta_url) {
    return res.status(400).json({ error: "format, title, cta_url required" });
  }
  const [cr] = await db
    .insert(adCreativesTable)
    .values({
      campaign_id: id,
      format,
      title,
      body: body ?? null,
      image_url: image_url ?? null,
      cta_url,
      cta_label: cta_label ?? "Learn more",
      width: width ?? null,
      height: height ?? null,
    })
    .returning();
  return res.json({ creative: cr });
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
router.get("/v1/advertiser/stats", requireAdvertiser(), async (req, res) => {
  const advId = req.auth!.advertiser_id!;
  const campaignId = req.query["campaign_id"] ? Number(req.query["campaign_id"]) : null;

  // Verify ownership if a specific campaign is requested.
  if (campaignId) {
    const [c] = await db.select().from(adCampaignsTable).where(eq(adCampaignsTable.id, campaignId));
    if (!c || c.advertiser_id !== advId) return res.status(404).json({ error: "not found" });
  }

  const campaignFilter = campaignId
    ? sql`AND ai.campaign_id = ${campaignId}`
    : sql`AND c.advertiser_id = ${advId}`;

  // Single round-trip, two aggregates joined to advertiser scope.
  const result = await db.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN ai.confirmed THEN 1 ELSE 0 END), 0)::int AS impressions,
      COALESCE(SUM(ai.charged_tsh), 0)::int AS impression_spend,
      (SELECT COALESCE(COUNT(*),0)::int FROM ad_clicks ac
        JOIN ad_campaigns c2 ON c2.id = ac.campaign_id
        WHERE 1=1 ${campaignId ? sql`AND ac.campaign_id = ${campaignId}` : sql`AND c2.advertiser_id = ${advId}`}) AS clicks,
      (SELECT COALESCE(SUM(charged_tsh),0)::int FROM ad_clicks ac
        JOIN ad_campaigns c2 ON c2.id = ac.campaign_id
        WHERE 1=1 ${campaignId ? sql`AND ac.campaign_id = ${campaignId}` : sql`AND c2.advertiser_id = ${advId}`}) AS click_spend
    FROM ad_impressions ai
    JOIN ad_campaigns c ON c.id = ai.campaign_id
    WHERE 1=1 ${campaignFilter}
  `);
  const row = (result as unknown as { rows: Array<{ impressions: number; impression_spend: number; clicks: number; click_spend: number }> }).rows[0] ?? {
    impressions: 0,
    impression_spend: 0,
    clicks: 0,
    click_spend: 0,
  };
  const ctr = row.impressions > 0 ? row.clicks / row.impressions : 0;
  return res.json({
    impressions: row.impressions,
    clicks: row.clicks,
    spend_tsh: row.impression_spend + row.click_spend,
    ctr: Number(ctr.toFixed(4)),
  });
});

// ---------------------------------------------------------------------------
// Wallet — mock M-Pesa topup
// ---------------------------------------------------------------------------
router.post("/v1/advertiser/topup", requireAdvertiser(), async (req, res) => {
  const advId = req.auth!.advertiser_id!;
  const amount = Number(req.body?.amount_tsh);
  if (!amount || amount <= 0) return res.status(400).json({ error: "amount_tsh must be > 0" });

  const newBalance = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(advertisersTable)
      .set({ balance_tsh: sql`${advertisersTable.balance_tsh} + ${amount}` })
      .where(eq(advertisersTable.id, advId))
      .returning({ balance_tsh: advertisersTable.balance_tsh });
    await tx.insert(adLedgerTable).values({
      advertiser_id: advId,
      delta_tsh: amount,
      balance_after: row!.balance_tsh,
      reason: "topup",
    });
    return row!.balance_tsh;
  });
  return res.json({ ok: true, balance_tsh: newBalance });
});

router.get("/v1/advertiser/ledger", requireAdvertiser(), async (req, res) => {
  const advId = req.auth!.advertiser_id!;
  const rows = await db
    .select()
    .from(adLedgerTable)
    .where(eq(adLedgerTable.advertiser_id, advId))
    .orderBy(desc(adLedgerTable.created_at))
    .limit(100);
  return res.json({ ledger: rows });
});

export default router;
