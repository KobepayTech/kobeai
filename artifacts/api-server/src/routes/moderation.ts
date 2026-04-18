// Moderation API — super-admin reviews mini-app submissions and verifies
// developer subscription payments.
//
// Mounted under /v1/admin/moderation (super_admin only).

import { Router } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  developersTable,
  developerPaymentsTable,
  miniAppsTable,
  miniAppVersionsTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { SUBSCRIPTION_PLANS } from "../lib/mini-app-pricing";

const router = Router();

router.use("/v1/admin/moderation", requireAuth(["super_admin", "admin"]));

// ---- App submissions queue ------------------------------------------------
router.get("/v1/admin/moderation/queue", async (_req, res) => {
  const apps = await db
    .select()
    .from(miniAppsTable)
    .where(eq(miniAppsTable.status, "submitted"))
    .orderBy(desc(miniAppsTable.updated_at))
    .limit(100);
  const devIds = [...new Set(apps.map((a) => a.developer_id))];
  const devs = devIds.length
    ? await db.select().from(developersTable).where(inArray(developersTable.id, devIds))
    : [];
  return res.json({
    apps: apps.map((a) => ({
      ...a,
      developer: devs.find((d) => d.id === a.developer_id)
        ? {
            id: a.developer_id,
            name: devs.find((d) => d.id === a.developer_id)!.display_name,
            email: devs.find((d) => d.id === a.developer_id)!.email,
          }
        : null,
    })),
  });
});

router.get("/v1/admin/moderation/apps/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [app] = await db.select().from(miniAppsTable).where(eq(miniAppsTable.id, id));
  if (!app) return res.status(404).json({ error: "app not found" });
  const [version] = app.current_version_id
    ? await db
        .select()
        .from(miniAppVersionsTable)
        .where(eq(miniAppVersionsTable.id, app.current_version_id))
    : [];
  const [dev] = await db.select().from(developersTable).where(eq(developersTable.id, app.developer_id));
  return res.json({ app, version, developer: dev ?? null });
});

router.post("/v1/admin/moderation/apps/:id/approve", async (req, res) => {
  const id = Number(req.params.id);
  const reviewer = req.auth!.user_id;
  const [app] = await db.select().from(miniAppsTable).where(eq(miniAppsTable.id, id));
  if (!app) return res.status(404).json({ error: "app not found" });
  await db
    .update(miniAppsTable)
    .set({ status: "approved", rejection_reason: null, updated_at: new Date() })
    .where(eq(miniAppsTable.id, id));
  if (app.current_version_id) {
    await db
      .update(miniAppVersionsTable)
      .set({ status: "approved", reviewed_by: reviewer, reviewed_at: new Date() })
      .where(eq(miniAppVersionsTable.id, app.current_version_id));
  }
  // Bump dev's published count (only on first approval per app)
  if (app.status !== "approved") {
    await db
      .update(developersTable)
      .set({ total_published_apps: sql`${developersTable.total_published_apps} + 1` })
      .where(eq(developersTable.id, app.developer_id));
  }
  return res.json({ ok: true });
});

router.post("/v1/admin/moderation/apps/:id/reject", async (req, res) => {
  const id = Number(req.params.id);
  const reviewer = req.auth!.user_id;
  const reason = String(req.body?.reason ?? "Did not meet content guidelines.");
  const [app] = await db.select().from(miniAppsTable).where(eq(miniAppsTable.id, id));
  if (!app) return res.status(404).json({ error: "app not found" });
  await db
    .update(miniAppsTable)
    .set({ status: "rejected", rejection_reason: reason, updated_at: new Date() })
    .where(eq(miniAppsTable.id, id));
  if (app.current_version_id) {
    await db
      .update(miniAppVersionsTable)
      .set({ status: "rejected", reviewed_by: reviewer, reviewed_at: new Date(), review_notes: reason })
      .where(eq(miniAppVersionsTable.id, app.current_version_id));
  }
  return res.json({ ok: true });
});

// ---- Developer payment verification queue --------------------------------
router.get("/v1/admin/moderation/payments", async (_req, res) => {
  const rows = await db
    .select()
    .from(developerPaymentsTable)
    .where(eq(developerPaymentsTable.status, "pending"))
    .orderBy(desc(developerPaymentsTable.created_at))
    .limit(100);
  const devIds = [...new Set(rows.map((r) => r.developer_id))];
  const devs = devIds.length
    ? await db.select().from(developersTable).where(inArray(developersTable.id, devIds))
    : [];
  return res.json({
    payments: rows.map((p) => ({
      ...p,
      developer: devs.find((d) => d.id === p.developer_id)
        ? {
            id: p.developer_id,
            name: devs.find((d) => d.id === p.developer_id)!.display_name,
            email: devs.find((d) => d.id === p.developer_id)!.email,
          }
        : null,
    })),
  });
});

router.post("/v1/admin/moderation/payments/:id/verify", async (req, res) => {
  const id = Number(req.params.id);
  const reviewer = req.auth!.user_id;
  const [pmt] = await db
    .select()
    .from(developerPaymentsTable)
    .where(eq(developerPaymentsTable.id, id));
  if (!pmt) return res.status(404).json({ error: "payment not found" });
  if (pmt.status !== "pending") return res.json({ ok: true, status: pmt.status });
  await db
    .update(developerPaymentsTable)
    .set({ status: "verified", verified_by: reviewer, verified_at: new Date() })
    .where(eq(developerPaymentsTable.id, id));
  if (pmt.kind === "subscription" && pmt.plan) {
    const planDef = SUBSCRIPTION_PLANS[pmt.plan as keyof typeof SUBSCRIPTION_PLANS];
    if (planDef) {
      const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      await db
        .update(developersTable)
        .set({ plan: planDef.code, plan_status: "active", plan_expires_at: expires })
        .where(eq(developersTable.id, pmt.developer_id));
    }
  }
  return res.json({ ok: true });
});

router.post("/v1/admin/moderation/payments/:id/reject", async (req, res) => {
  const id = Number(req.params.id);
  const reviewer = req.auth!.user_id;
  const notes = req.body?.notes ? String(req.body.notes) : null;
  const [pmt] = await db
    .select()
    .from(developerPaymentsTable)
    .where(eq(developerPaymentsTable.id, id));
  if (!pmt) return res.status(404).json({ error: "payment not found" });
  await db
    .update(developerPaymentsTable)
    .set({ status: "rejected", verified_by: reviewer, verified_at: new Date(), notes })
    .where(eq(developerPaymentsTable.id, id));
  await db
    .update(developersTable)
    .set({ plan_status: "inactive" })
    .where(eq(developersTable.id, pmt.developer_id));
  return res.json({ ok: true });
});

export default router;
