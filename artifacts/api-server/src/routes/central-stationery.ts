// Super-admin (central) stationery endpoints.
//
//   GET    /central/v1/admin/stationery/items                — list catalog
//   POST   /central/v1/admin/stationery/items                — create item
//   PATCH  /central/v1/admin/stationery/items/:id            — edit item
//   DELETE /central/v1/admin/stationery/items/:id            — soft-delete (active=false)
//   GET    /central/v1/admin/stationery/drives               — list drives
//   POST   /central/v1/admin/stationery/drives               — open new drive
//   PATCH  /central/v1/admin/stationery/drives/:id           — close / reopen
//   GET    /central/v1/admin/stationery/compilation/:driveId — aggregated view
//   GET    /central/v1/admin/stationery/invoice/:driveId     — PDF invoice

import { Router } from "express";
import { and, desc, eq, asc, sql } from "drizzle-orm";
import PDFDocument from "pdfkit";
import {
  db,
  stationeryItemsTable,
  stationeryDrivesTable,
  stationeryOrdersTable,
  stationeryOrderItemsTable,
  tenantsTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";

const router = Router();

router.use("/central/v1/admin/stationery", requireAuth(["super_admin"]));

// ---------------------------------------------------------------------------
// Catalog CRUD
// ---------------------------------------------------------------------------
router.get("/central/v1/admin/stationery/items", async (_req, res) => {
  const rows = await db
    .select()
    .from(stationeryItemsTable)
    .orderBy(asc(stationeryItemsTable.category), asc(stationeryItemsTable.name));
  res.json({ items: rows });
});

router.post("/central/v1/admin/stationery/items", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const category = String(req.body?.category ?? "Other").trim() || "Other";
  const default_price_tsh = Math.max(
    0,
    Math.min(10_000_000, Math.floor(Number(req.body?.default_price_tsh ?? 0))),
  );
  const unit = String(req.body?.unit ?? "each").trim() || "each";
  if (name.length < 2) return res.status(400).json({ error: "Name too short" });
  try {
    const [row] = await db
      .insert(stationeryItemsTable)
      .values({ name, category, default_price_tsh, unit })
      .returning();
    res.status(201).json({ item: row });
  } catch (e) {
    res.status(409).json({ error: "Item already exists" });
  }
});

router.patch("/central/v1/admin/stationery/items/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.name === "string" && req.body.name.trim().length >= 2)
    patch.name = req.body.name.trim();
  if (typeof req.body?.category === "string")
    patch.category = req.body.category.trim() || "Other";
  if (req.body?.default_price_tsh !== undefined) {
    const v = Math.floor(Number(req.body.default_price_tsh));
    if (!Number.isFinite(v) || v < 0 || v > 10_000_000)
      return res.status(400).json({ error: "Invalid price" });
    patch.default_price_tsh = v;
  }
  if (typeof req.body?.unit === "string") patch.unit = req.body.unit.trim();
  if (typeof req.body?.active === "boolean") patch.active = req.body.active;
  if (Object.keys(patch).length === 0)
    return res.status(400).json({ error: "no changes" });
  const [row] = await db
    .update(stationeryItemsTable)
    .set(patch)
    .where(eq(stationeryItemsTable.id, id))
    .returning();
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json({ item: row });
});

router.delete("/central/v1/admin/stationery/items/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  // Soft-delete: keep the row so historical orders still resolve names.
  await db
    .update(stationeryItemsTable)
    .set({ active: false })
    .where(eq(stationeryItemsTable.id, id));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Drives
// ---------------------------------------------------------------------------
router.get("/central/v1/admin/stationery/drives", async (_req, res) => {
  const rows = await db
    .select()
    .from(stationeryDrivesTable)
    .orderBy(desc(stationeryDrivesTable.opens_at));
  res.json({ drives: rows });
});

router.post("/central/v1/admin/stationery/drives", async (req, res) => {
  const title = String(req.body?.title ?? "").trim();
  const description = String(req.body?.description ?? "").trim() || null;
  const closesAtRaw = String(req.body?.closes_at ?? "");
  const closes_at = new Date(closesAtRaw);
  if (title.length < 2) return res.status(400).json({ error: "Title too short" });
  if (!isFinite(closes_at.getTime()) || closes_at.getTime() < Date.now())
    return res.status(400).json({ error: "closes_at must be a future date" });
  // Close any currently-open drive first (one-open-at-a-time invariant).
  await db
    .update(stationeryDrivesTable)
    .set({ status: "closed" })
    .where(eq(stationeryDrivesTable.status, "open"));
  const [row] = await db
    .insert(stationeryDrivesTable)
    .values({ title, description, closes_at, status: "open" })
    .returning();
  res.status(201).json({ drive: row });
});

router.patch("/central/v1/admin/stationery/drives/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  const status = req.body?.status;
  if (!["open", "closed", "invoiced"].includes(status))
    return res.status(400).json({ error: "Invalid status" });
  // Atomic reopen: validate the target exists *first*, then close-others +
  // open-target in one transaction. Earlier version closed all open drives
  // before checking that the target ID was valid — a typo'd ID could leave
  // the school with zero open drives.
  const result = await db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(stationeryDrivesTable)
      .where(eq(stationeryDrivesTable.id, id));
    if (!target) return null;
    if (status === "open") {
      await tx
        .update(stationeryDrivesTable)
        .set({ status: "closed" })
        .where(eq(stationeryDrivesTable.status, "open"));
    }
    const [row] = await tx
      .update(stationeryDrivesTable)
      .set({ status })
      .where(eq(stationeryDrivesTable.id, id))
      .returning();
    return row ?? null;
  });
  if (!result) return res.status(404).json({ error: "Not found" });
  res.json({ drive: result });
});

// ---------------------------------------------------------------------------
// Compilation: per-item totals across all schools, plus per-school sub-orders
// ---------------------------------------------------------------------------
async function buildCompilation(driveId: number) {
  // 1. Per (item, tenant) total quantity from approved orders.
  const rows = await db
    .select({
      item_id: stationeryOrderItemsTable.item_id,
      item_name: stationeryOrderItemsTable.item_name,
      tenant_id: stationeryOrdersTable.tenant_id,
      qty_total: sql<number>`SUM(${stationeryOrderItemsTable.qty})::int`,
      revenue_tsh: sql<number>`SUM(${stationeryOrderItemsTable.line_total_tsh})::int`,
      unit_price_tsh: sql<number>`MAX(${stationeryOrderItemsTable.unit_price_tsh})::int`,
    })
    .from(stationeryOrderItemsTable)
    .innerJoin(
      stationeryOrdersTable,
      eq(stationeryOrdersTable.id, stationeryOrderItemsTable.order_id),
    )
    .where(
      and(
        eq(stationeryOrdersTable.drive_id, driveId),
        eq(stationeryOrdersTable.status, "approved"),
      ),
    )
    .groupBy(
      stationeryOrderItemsTable.item_id,
      stationeryOrderItemsTable.item_name,
      stationeryOrdersTable.tenant_id,
    );
  const tenants = await db.select().from(tenantsTable);
  const tenantById = new Map(tenants.map((t) => [t.id, t]));
  // Group by item.
  const byItem = new Map<
    number,
    {
      item_id: number;
      item_name: string;
      total_qty: number;
      total_revenue_tsh: number;
      schools: {
        tenant_id: number;
        tenant_name: string;
        slug: string;
        qty: number;
        revenue_tsh: number;
        unit_price_tsh: number;
      }[];
    }
  >();
  for (const r of rows) {
    const t = tenantById.get(r.tenant_id);
    const entry =
      byItem.get(r.item_id) ?? {
        item_id: r.item_id,
        item_name: r.item_name,
        total_qty: 0,
        total_revenue_tsh: 0,
        schools: [],
      };
    entry.total_qty += r.qty_total;
    entry.total_revenue_tsh += r.revenue_tsh;
    entry.schools.push({
      tenant_id: r.tenant_id,
      tenant_name: t?.name ?? `Tenant ${r.tenant_id}`,
      slug: t?.slug ?? "",
      qty: r.qty_total,
      revenue_tsh: r.revenue_tsh,
      unit_price_tsh: r.unit_price_tsh,
    });
    byItem.set(r.item_id, entry);
  }
  const items = Array.from(byItem.values()).sort(
    (a, b) => b.total_qty - a.total_qty,
  );
  // School-level totals
  const schoolTotals = new Map<
    number,
    { tenant_id: number; name: string; slug: string; qty: number; revenue_tsh: number; orders: number }
  >();
  for (const r of rows) {
    const t = tenantById.get(r.tenant_id);
    const e =
      schoolTotals.get(r.tenant_id) ?? {
        tenant_id: r.tenant_id,
        name: t?.name ?? `Tenant ${r.tenant_id}`,
        slug: t?.slug ?? "",
        qty: 0,
        revenue_tsh: 0,
        orders: 0,
      };
    e.qty += r.qty_total;
    e.revenue_tsh += r.revenue_tsh;
    schoolTotals.set(r.tenant_id, e);
  }
  // Order count per school
  const orderCounts = await db
    .select({
      tenant_id: stationeryOrdersTable.tenant_id,
      cnt: sql<number>`COUNT(*)::int`,
    })
    .from(stationeryOrdersTable)
    .where(
      and(
        eq(stationeryOrdersTable.drive_id, driveId),
        eq(stationeryOrdersTable.status, "approved"),
      ),
    )
    .groupBy(stationeryOrdersTable.tenant_id);
  for (const o of orderCounts) {
    const e = schoolTotals.get(o.tenant_id);
    if (e) e.orders = o.cnt;
  }
  return {
    items,
    schools: Array.from(schoolTotals.values()).sort((a, b) => b.qty - a.qty),
    grand_qty: items.reduce((s, i) => s + i.total_qty, 0),
    grand_revenue_tsh: items.reduce((s, i) => s + i.total_revenue_tsh, 0),
  };
}

router.get(
  "/central/v1/admin/stationery/compilation/:driveId",
  async (req, res) => {
    const id = Number(req.params["driveId"]);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
    const [drive] = await db
      .select()
      .from(stationeryDrivesTable)
      .where(eq(stationeryDrivesTable.id, id));
    if (!drive) return res.status(404).json({ error: "Drive not found" });
    const compilation = await buildCompilation(id);
    res.json({ drive, ...compilation });
  },
);

// ---------------------------------------------------------------------------
// Invoice PDF
// Cover: grand totals per item across all schools.
// Subsequent pages: one packing list per school.
// ---------------------------------------------------------------------------
router.get(
  "/central/v1/admin/stationery/invoice/:driveId",
  async (req, res) => {
    const id = Number(req.params["driveId"]);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
    const [drive] = await db
      .select()
      .from(stationeryDrivesTable)
      .where(eq(stationeryDrivesTable.id, id));
    if (!drive) return res.status(404).json({ error: "Drive not found" });
    const compilation = await buildCompilation(id);
    res.setHeader("content-type", "application/pdf");
    res.setHeader(
      "content-disposition",
      `attachment; filename="kobeai-stationery-invoice-${id}.pdf"`,
    );

    const doc = new PDFDocument({ size: "A4", margin: 48 });
    doc.pipe(res);

    // ---- Cover ----
    doc
      .fillColor("#00A86B")
      .fontSize(24)
      .text("KobeAI Stationery Invoice", { align: "left" });
    doc
      .fillColor("#1A1A2E")
      .fontSize(14)
      .text(drive.title, { align: "left" });
    doc
      .fontSize(10)
      .fillColor("#666")
      .text(
        `Drive #${drive.id} · Closed ${new Date(drive.closes_at).toLocaleDateString()} · Generated ${new Date().toLocaleString()}`,
      );
    doc.moveDown();

    doc
      .fillColor("#1A1A2E")
      .fontSize(13)
      .text(
        `Grand totals — ${compilation.grand_qty.toLocaleString()} units across ${compilation.schools.length} schools  ·  TSh ${compilation.grand_revenue_tsh.toLocaleString()}`,
      );
    doc.moveDown();

    // Header row
    const renderItemRow = (
      cols: { name: string; qty: string; price: string; total: string },
      bold = false,
    ) => {
      const y = doc.y;
      if (bold) doc.font("Helvetica-Bold");
      else doc.font("Helvetica");
      doc.fontSize(10);
      doc.text(cols.name, 48, y, { width: 240 });
      doc.text(cols.qty, 290, y, { width: 70, align: "right" });
      doc.text(cols.price, 365, y, { width: 90, align: "right" });
      doc.text(cols.total, 460, y, { width: 90, align: "right" });
      doc.font("Helvetica");
      doc.moveDown(0.4);
    };

    renderItemRow(
      { name: "Item", qty: "Qty", price: "Avg Price", total: "Total TSh" },
      true,
    );
    doc
      .moveTo(48, doc.y)
      .lineTo(548, doc.y)
      .strokeColor("#ccc")
      .stroke();
    doc.moveDown(0.3);

    for (const it of compilation.items) {
      const avg = it.total_qty
        ? Math.round(it.total_revenue_tsh / it.total_qty)
        : 0;
      renderItemRow({
        name: it.item_name,
        qty: it.total_qty.toLocaleString(),
        price: avg.toLocaleString(),
        total: it.total_revenue_tsh.toLocaleString(),
      });
      if (doc.y > 750) doc.addPage();
    }

    // ---- Per-school packing lists ----
    for (const s of compilation.schools) {
      doc.addPage();
      doc
        .fillColor("#00A86B")
        .fontSize(18)
        .text(`Packing List: ${s.name}`);
      doc
        .fontSize(10)
        .fillColor("#666")
        .text(
          `${s.qty.toLocaleString()} units · ${s.orders} orders · TSh ${s.revenue_tsh.toLocaleString()}`,
        );
      doc.moveDown();
      renderItemRow(
        { name: "Item", qty: "Qty", price: "Unit TSh", total: "Subtotal" },
        true,
      );
      doc
        .moveTo(48, doc.y)
        .lineTo(548, doc.y)
        .strokeColor("#ccc")
        .stroke();
      doc.moveDown(0.3);
      for (const it of compilation.items) {
        const sub = it.schools.find((x) => x.tenant_id === s.tenant_id);
        if (!sub) continue;
        renderItemRow({
          name: it.item_name,
          qty: sub.qty.toLocaleString(),
          price: sub.unit_price_tsh.toLocaleString(),
          total: sub.revenue_tsh.toLocaleString(),
        });
        if (doc.y > 750) doc.addPage();
      }
    }

    doc.end();
  },
);

export default router;
