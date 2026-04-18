// Public ad serving + event tracking. No auth required (rate-limited).
//
//   GET  /v1/ads/serve?placement=<id>&user_id=<n?>   -> winning ad + token
//   POST /v1/ads/event { token, type: "impression"|"click" } -> records + bills
//
// Selection algorithm:
//   1. Filter active campaigns matching the placement, with budget remaining,
//      within their date window.
//   2. Score each by eCPM:
//        cpm  -> bid_amount_tsh
//        cpc  -> bid_amount_tsh * historical_ctr * 1000   (ctr default 0.02)
//        flat -> very high score (treated as guaranteed booking)
//   3. Drop campaigns over their per-user daily frequency cap.
//   4. Pick a random campaign from the top 3 by score (avoids starvation).
//   5. Return the matching creative + a signed HMAC token. The token carries
//      campaign_id + creative_id + placement + nonce + expiry. Click events
//      verify the token before billing so the front-end can't fabricate events.

import { Router } from "express";
import crypto from "crypto";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  adCampaignsTable,
  adCreativesTable,
  adPlacementsTable,
  adImpressionsTable,
  adClicksTable,
  adLedgerTable,
  advertisersTable,
  adFrequencyCapsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";

const router = Router();

const HMAC_SECRET =
  process.env["AD_TOKEN_SECRET"] ??
  process.env["SESSION_SECRET"] ??
  "dev-ad-token-secret";

const FREQ_CAP_PER_USER_PER_DAY = 5;
const TOP_K = 3;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function signImpressionToken(payload: {
  imp: number;
  cmp: number;
  cre: number;
  pl: string;
  exp: number;
}): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", HMAC_SECRET)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

function verifyImpressionToken(token: string): {
  imp: number;
  cmp: number;
  cre: number;
  pl: string;
  exp: number;
} | null {
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto
    .createHmac("sha256", HMAC_SECRET)
    .update(body!)
    .digest("base64url");
  if (
    sig!.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig!), Buffer.from(expected))
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString());
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

router.get("/v1/ads/serve", async (req, res) => {
  const placementId = String(req.query["placement"] ?? "");
  const userId = req.query["user_id"]
    ? Number(req.query["user_id"])
    : null;
  if (!placementId) {
    return res.status(400).json({ error: "placement query param required" });
  }

  const [placement] = await db
    .select()
    .from(adPlacementsTable)
    .where(eq(adPlacementsTable.id, placementId));
  if (!placement || !placement.active) {
    return res.status(404).json({ error: "unknown placement", ad: null });
  }
  const allowedFormats = (placement.allowed_formats as string[]) ?? [];

  // Pull live campaigns whose budget isn't exhausted and which target this
  // placement. We do the placement filter in SQL with a JSON contains.
  const now = new Date();
  const todayStr = todayISO();
  const candidates = await db
    .select({
      campaign: adCampaignsTable,
      advertiser: advertisersTable,
    })
    .from(adCampaignsTable)
    .innerJoin(
      advertisersTable,
      eq(advertisersTable.id, adCampaignsTable.advertiser_id),
    )
    .where(
      and(
        eq(adCampaignsTable.status, "active"),
        eq(advertisersTable.status, "active"),
        gt(advertisersTable.balance_tsh, 0),
        sql`${adCampaignsTable.placements} @> ${JSON.stringify([placementId])}::jsonb`,
        lte(adCampaignsTable.starts_at, now),
        or(
          isNull(adCampaignsTable.ends_at),
          gt(adCampaignsTable.ends_at, now),
        ),
      ),
    );

  if (candidates.length === 0) {
    return res.json({ ad: null, reason: "no_eligible_campaigns" });
  }

  // Frequency cap (only if we know the user). One round-trip for all caps.
  let freqMap = new Map<number, number>();
  if (userId) {
    const caps = await db
      .select()
      .from(adFrequencyCapsTable)
      .where(
        and(
          eq(adFrequencyCapsTable.user_id, userId),
          eq(adFrequencyCapsTable.bucket_date, todayStr),
        ),
      );
    freqMap = new Map(caps.map((c) => [c.campaign_id, c.count]));
  }

  // Score eligible campaigns.
  type Scored = {
    campaign: typeof adCampaignsTable.$inferSelect;
    score: number;
  };
  const scored: Scored[] = [];
  for (const { campaign } of candidates) {
    if ((freqMap.get(campaign.id) ?? 0) >= FREQ_CAP_PER_USER_PER_DAY) continue;
    if (
      campaign.daily_budget_tsh > 0 &&
      campaign.spent_today_date === todayStr &&
      campaign.spent_today_tsh >= campaign.daily_budget_tsh
    ) {
      continue;
    }
    if (
      campaign.total_budget_tsh > 0 &&
      campaign.spent_total_tsh >= campaign.total_budget_tsh
    ) {
      continue;
    }
    let score: number;
    switch (campaign.pricing_model) {
      case "cpm":
        score = campaign.bid_amount_tsh;
        break;
      case "cpc": {
        // eCPM = bid * ctr * 1000. Default CTR 0.02 until we have history.
        const ctr = 0.02;
        score = campaign.bid_amount_tsh * ctr * 1000;
        break;
      }
      case "flat":
        // Treat as a guaranteed booking — always wins over auction.
        score = 1_000_000_000;
        break;
      default:
        continue;
    }
    if (score < placement.floor_bid_tsh) continue;
    scored.push({ campaign, score });
  }

  if (scored.length === 0) {
    return res.json({ ad: null, reason: "no_winners_after_filter" });
  }

  scored.sort((a, b) => b.score - a.score);
  const pool = scored.slice(0, TOP_K);
  const winner = pool[Math.floor(Math.random() * pool.length)]!.campaign;

  // Pick a creative for this campaign whose format is allowed by the slot.
  const creatives = await db
    .select()
    .from(adCreativesTable)
    .where(eq(adCreativesTable.campaign_id, winner.id));
  const creative = creatives.find((c) => allowedFormats.includes(c.format));
  if (!creative) {
    return res.json({ ad: null, reason: "no_format_match" });
  }

  // Pre-create the impression row so the click event has a target. We mark
  // it `confirmed=false` until the front-end posts the impression event.
  // CPM and flat are charged on confirmation; CPC charges on click only.
  const [imp] = await db
    .insert(adImpressionsTable)
    .values({
      campaign_id: winner.id,
      creative_id: creative.id,
      placement_id: placementId,
      user_id: userId,
    })
    .returning({ id: adImpressionsTable.id });

  // Bump frequency counter (non-blocking; ignore if no user).
  if (userId) {
    await db
      .insert(adFrequencyCapsTable)
      .values({
        user_id: userId,
        campaign_id: winner.id,
        bucket_date: todayStr,
        count: 1,
      })
      .onConflictDoUpdate({
        target: [
          adFrequencyCapsTable.user_id,
          adFrequencyCapsTable.campaign_id,
          adFrequencyCapsTable.bucket_date,
        ],
        set: { count: sql`${adFrequencyCapsTable.count} + 1` },
      });
  }

  const token = signImpressionToken({
    imp: imp!.id,
    cmp: winner.id,
    cre: creative.id,
    pl: placementId,
    exp: Date.now() + 30 * 60 * 1000, // 30 min window for clicks
  });

  // NOTE: response shape is consumed verbatim by the parent web banner
  // (`ad-banner.tsx`) and the watch `AdPayload` Kotlin model. Keep the
  // nested `creative` + top-level `impression_token` exactly as is.
  return res.json({
    ad: {
      impression_token: token,
      placement_id: placementId,
      campaign_id: winner.id,
      pricing_model: winner.pricing_model,
      creative: {
        id: creative.id,
        format: creative.format,
        title: creative.title,
        body: creative.body,
        image_url: creative.image_url,
        cta_url: creative.cta_url,
        cta_label: creative.cta_label,
        width: creative.width,
        height: creative.height,
      },
    },
  });
});

router.post("/v1/ads/event", async (req, res) => {
  const { token, type } = req.body ?? {};
  if (!token || !type) return res.status(400).json({ error: "token+type required" });
  if (type !== "impression" && type !== "click") {
    return res.status(400).json({ error: "type must be impression or click" });
  }
  const payload = verifyImpressionToken(String(token));
  if (!payload) return res.status(400).json({ error: "invalid or expired token" });

  // Re-load campaign + advertiser inside a transaction so billing is atomic.
  await db.transaction(async (tx) => {
    const [campaign] = await tx
      .select()
      .from(adCampaignsTable)
      .where(eq(adCampaignsTable.id, payload.cmp));
    if (!campaign) return;

    let chargeTsh = 0;
    if (type === "impression") {
      // Mark the impression confirmed (idempotent — only charge once).
      const [imp] = await tx
        .select()
        .from(adImpressionsTable)
        .where(eq(adImpressionsTable.id, payload.imp));
      if (!imp || imp.confirmed) return;

      // CPM: charge bid/1000. Flat: charge 0 here (period charging happens
      // on a daily cron — out of scope; mark confirmed regardless). CPC:
      // no impression charge.
      if (campaign.pricing_model === "cpm") {
        chargeTsh = Math.max(1, Math.round(campaign.bid_amount_tsh / 1000));
      }
      await tx
        .update(adImpressionsTable)
        .set({ confirmed: true, charged_tsh: chargeTsh })
        .where(eq(adImpressionsTable.id, payload.imp));
    } else {
      // click — only CPC bills here; CPM/flat clicks are free.
      if (campaign.pricing_model === "cpc") {
        chargeTsh = campaign.bid_amount_tsh;
      }
      const [click] = await tx
        .insert(adClicksTable)
        .values({
          impression_id: payload.imp,
          campaign_id: payload.cmp,
          charged_tsh: chargeTsh,
        })
        .returning({ id: adClicksTable.id });
      logger.info({ click_id: click!.id, campaign_id: payload.cmp }, "ad click");
    }

    if (chargeTsh > 0) {
      const [advertiser] = await tx
        .select()
        .from(advertisersTable)
        .where(eq(advertisersTable.id, campaign.advertiser_id));
      if (!advertiser) return;
      const newBal = Math.max(0, advertiser.balance_tsh - chargeTsh);
      await tx
        .update(advertisersTable)
        .set({ balance_tsh: newBal })
        .where(eq(advertisersTable.id, advertiser.id));
      const todayStr = todayISO();
      const newSpentToday =
        campaign.spent_today_date === todayStr
          ? campaign.spent_today_tsh + chargeTsh
          : chargeTsh;
      const newSpentTotal = campaign.spent_total_tsh + chargeTsh;
      const newStatus =
        (campaign.total_budget_tsh > 0 &&
          newSpentTotal >= campaign.total_budget_tsh) ||
        newBal === 0
          ? "exhausted"
          : campaign.status;
      await tx
        .update(adCampaignsTable)
        .set({
          spent_today_tsh: newSpentToday,
          spent_today_date: todayStr,
          spent_total_tsh: newSpentTotal,
          status: newStatus,
          updated_at: new Date(),
        })
        .where(eq(adCampaignsTable.id, campaign.id));
      await tx.insert(adLedgerTable).values({
        advertiser_id: advertiser.id,
        delta_tsh: -chargeTsh,
        balance_after: newBal,
        reason:
          type === "impression" ? "cpm_impression" : "cpc_click",
        ref_id: type === "impression" ? payload.imp : null,
      });
    }
  });

  return res.json({ ok: true });
});

export default router;
