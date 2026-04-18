// Super-admin moderation surface for the ad exchange.
//
// All routes require the "admin" role. They intentionally use the same
// requireAuth middleware as the rest of the admin surface — there is no
// separate "super_admin" role yet; anyone with admin can moderate.
import { Router } from "express";
import { eq, sql, desc } from "drizzle-orm";
import {
  db,
  advertisersTable,
  adCampaignsTable,
  adImpressionsTable,
  adClicksTable,
  adLedgerTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";

const router = Router();
const adminAuth = requireAuth(["admin"]);

/** GET /v1/admin/ads/advertisers — list all advertisers + balance + spend. */
router.get("/v1/admin/ads/advertisers", adminAuth, async (_req, res) => {
  const rows = await db
    .select({
      id: advertisersTable.id,
      company_name: advertisersTable.company_name,
      contact_email: advertisersTable.contact_email,
      balance_tsh: advertisersTable.balance_tsh,
      status: advertisersTable.status,
      created_at: advertisersTable.created_at,
    })
    .from(advertisersTable)
    .orderBy(desc(advertisersTable.created_at));
  return res.json({ advertisers: rows });
});

/** GET /v1/admin/ads/campaigns — list campaigns across all advertisers. */
router.get("/v1/admin/ads/campaigns", adminAuth, async (_req, res) => {
  const rows = await db
    .select({
      id: adCampaignsTable.id,
      advertiser_id: adCampaignsTable.advertiser_id,
      advertiser_name: advertisersTable.company_name,
      name: adCampaignsTable.name,
      pricing_model: adCampaignsTable.pricing_model,
      bid_amount_tsh: adCampaignsTable.bid_amount_tsh,
      placements: adCampaignsTable.placements,
      status: adCampaignsTable.status,
      spent_total_tsh: adCampaignsTable.spent_total_tsh,
      created_at: adCampaignsTable.created_at,
    })
    .from(adCampaignsTable)
    .leftJoin(advertisersTable, eq(adCampaignsTable.advertiser_id, advertisersTable.id))
    .orderBy(desc(adCampaignsTable.created_at));
  return res.json({ campaigns: rows });
});

/**
 * PATCH /v1/admin/ads/campaigns/:id — set status (active|paused|rejected).
 * Use rejected for moderation takedowns; the advertiser can no longer
 * activate it without admin help.
 */
router.patch("/v1/admin/ads/campaigns/:id", adminAuth, async (req, res) => {
  const id = Number(req.params["id"]);
  const status = String(req.body?.status ?? "");
  if (!["active", "paused", "rejected"].includes(status)) {
    return res.status(400).json({ error: "status must be active|paused|rejected" });
  }
  const [updated] = await db
    .update(adCampaignsTable)
    .set({ status, updated_at: new Date() })
    .where(eq(adCampaignsTable.id, id))
    .returning();
  if (!updated) return res.status(404).json({ error: "not found" });
  logger.info({ campaign_id: id, status, by: (req as any).principal?.id }, "admin campaign moderation");
  return res.json({ campaign: updated });
});

/**
 * GET /v1/admin/ads/revenue — totals for the exchange dashboard. Counts
 * confirmed impressions + clicks + total spend (= exchange revenue).
 */
router.get("/v1/admin/ads/revenue", adminAuth, async (_req, res) => {
  const [imps] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      spend: sql<number>`COALESCE(SUM(${adImpressionsTable.charged_tsh}), 0)::int`,
    })
    .from(adImpressionsTable)
    .where(eq(adImpressionsTable.confirmed, true));
  const [clk] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      spend: sql<number>`COALESCE(SUM(${adClicksTable.charged_tsh}), 0)::int`,
    })
    .from(adClicksTable);
  const [advs] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      balance: sql<number>`COALESCE(SUM(${advertisersTable.balance_tsh}), 0)::int`,
    })
    .from(advertisersTable);
  const totalRevenue = (imps?.spend ?? 0) + (clk?.spend ?? 0);
  return res.json({
    advertisers_total: advs?.total ?? 0,
    advertiser_balance_total_tsh: advs?.balance ?? 0,
    impressions_total: imps?.total ?? 0,
    clicks_total: clk?.total ?? 0,
    impression_revenue_tsh: imps?.spend ?? 0,
    click_revenue_tsh: clk?.spend ?? 0,
    total_revenue_tsh: totalRevenue,
  });
});

/** GET /v1/admin/ads/ledger?advertiser_id= — recent ledger entries. */
router.get("/v1/admin/ads/ledger", adminAuth, async (req, res) => {
  const advertiserId = req.query["advertiser_id"]
    ? Number(req.query["advertiser_id"])
    : null;
  const q = db
    .select()
    .from(adLedgerTable)
    .orderBy(desc(adLedgerTable.created_at))
    .limit(200);
  const rows = advertiserId
    ? await db
        .select()
        .from(adLedgerTable)
        .where(eq(adLedgerTable.advertiser_id, advertiserId))
        .orderBy(desc(adLedgerTable.created_at))
        .limit(200)
    : await q;
  return res.json({ ledger: rows });
});

export default router;
