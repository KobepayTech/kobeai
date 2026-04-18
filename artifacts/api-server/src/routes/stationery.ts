// Stationery ordering — parent, teacher, watch, and student-shared endpoints.
//
// Workflow recap (status_machine):
//   draft -> pending_parent_approval -> approved (-> packed)
//                                    \-> rejected
//
// Pricing always uses snapshot rules at *order time*: total_tsh is computed
// from the line items at insert and never recomputed on read. That way a
// late-night catalog price change can't retroactively bill a parent.

import { Router } from "express";
import { and, desc, eq, inArray, sql, asc } from "drizzle-orm";
import {
  db,
  stationeryItemsTable,
  stationerySchoolPricesTable,
  stationeryDrivesTable,
  stationeryOrdersTable,
  stationeryOrderItemsTable,
  parentChildrenTable,
  classMembershipsTable,
  classesTable,
  tenantsTable,
  usersTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { sendApprovalPushToParents } from "./parent-push";
import { logger } from "../lib/logger";

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function getOpenDrive() {
  const [drive] = await db
    .select()
    .from(stationeryDrivesTable)
    .where(eq(stationeryDrivesTable.status, "open"))
    .orderBy(desc(stationeryDrivesTable.opens_at))
    .limit(1);
  return drive ?? null;
}

async function catalogForTenant(tenantId: number) {
  const items = await db
    .select()
    .from(stationeryItemsTable)
    .where(eq(stationeryItemsTable.active, true))
    .orderBy(asc(stationeryItemsTable.category), asc(stationeryItemsTable.name));
  const overrides = await db
    .select()
    .from(stationerySchoolPricesTable)
    .where(eq(stationerySchoolPricesTable.tenant_id, tenantId));
  const overrideMap = new Map(overrides.map((o) => [o.item_id, o.price_tsh]));
  return items.map((it) => ({
    id: it.id,
    name: it.name,
    category: it.category,
    unit: it.unit,
    price_tsh: overrideMap.get(it.id) ?? it.default_price_tsh,
  }));
}

async function defaultTenantId(): Promise<number> {
  const [t] = await db.select().from(tenantsTable).orderBy(tenantsTable.id).limit(1);
  return t?.id ?? 1;
}

async function loadOrderWithLines(orderId: number) {
  const [order] = await db
    .select()
    .from(stationeryOrdersTable)
    .where(eq(stationeryOrdersTable.id, orderId));
  if (!order) return null;
  const lines = await db
    .select()
    .from(stationeryOrderItemsTable)
    .where(eq(stationeryOrderItemsTable.order_id, orderId));
  return { order, lines };
}

type LineInput = { item_id: number; qty: number };
function sanitizeLines(input: unknown): LineInput[] {
  if (!Array.isArray(input)) return [];
  const out: LineInput[] = [];
  for (const raw of input) {
    const item_id = Number(raw?.item_id);
    const qty = Number(raw?.qty);
    if (
      Number.isFinite(item_id) &&
      Number.isFinite(qty) &&
      qty > 0 &&
      qty <= 1000 &&
      item_id > 0
    ) {
      out.push({ item_id, qty: Math.floor(qty) });
    }
  }
  // Dedup by item_id, summing quantities — protects against a watch glitching
  // and submitting the same item twice.
  const merged = new Map<number, number>();
  for (const l of out) merged.set(l.item_id, (merged.get(l.item_id) ?? 0) + l.qty);
  return Array.from(merged.entries()).map(([item_id, qty]) => ({ item_id, qty }));
}

// Insert/upsert order + lines in one transaction.
async function persistOrder(opts: {
  drive_id: number;
  tenant_id: number;
  student_user_id: number;
  student_code: string;
  student_name: string;
  class_id: number | null;
  class_name: string | null;
  parent_user_id: number | null;
  placed_by: "teacher" | "student_watch" | "parent";
  status: "draft" | "pending_parent_approval" | "approved";
  notes?: string | null;
  lines: LineInput[];
}): Promise<{ order_id: number; total_tsh: number } | { error: string }> {
  if (opts.lines.length === 0) return { error: "Order has no items" };
  const ids = opts.lines.map((l) => l.item_id);
  const items = await db
    .select()
    .from(stationeryItemsTable)
    .where(inArray(stationeryItemsTable.id, ids));
  const overrides = await db
    .select()
    .from(stationerySchoolPricesTable)
    .where(
      and(
        eq(stationerySchoolPricesTable.tenant_id, opts.tenant_id),
        inArray(stationerySchoolPricesTable.item_id, ids),
      ),
    );
  const overrideMap = new Map(overrides.map((o) => [o.item_id, o.price_tsh]));
  const itemMap = new Map(items.map((i) => [i.id, i]));
  let total = 0;
  const linesPriced = opts.lines.map((l) => {
    const item = itemMap.get(l.item_id);
    if (!item || !item.active) throw new Error(`Item ${l.item_id} not available`);
    const price = overrideMap.get(item.id) ?? item.default_price_tsh;
    const lineTotal = price * l.qty;
    total += lineTotal;
    return {
      item_id: item.id,
      item_name: item.name,
      qty: l.qty,
      unit_price_tsh: price,
      line_total_tsh: lineTotal,
    };
  });

  return await db.transaction(async (tx) => {
    const submittedAt =
      opts.status === "pending_parent_approval" ? new Date() : null;
    const [existing] = await tx
      .select()
      .from(stationeryOrdersTable)
      .where(
        and(
          eq(stationeryOrdersTable.drive_id, opts.drive_id),
          eq(stationeryOrdersTable.student_user_id, opts.student_user_id),
        ),
      );
    let orderId: number;
    if (existing) {
      // Cannot edit once approved.
      if (existing.status === "approved" || existing.status === "packed") {
        return { error: "Order already approved" };
      }
      await tx
        .update(stationeryOrdersTable)
        .set({
          status: opts.status,
          placed_by: opts.placed_by,
          parent_user_id: opts.parent_user_id ?? existing.parent_user_id,
          class_id: opts.class_id ?? existing.class_id,
          class_name: opts.class_name ?? existing.class_name,
          notes: opts.notes ?? existing.notes,
          total_tsh: total,
          submitted_at: submittedAt ?? existing.submitted_at,
          updated_at: new Date(),
        })
        .where(eq(stationeryOrdersTable.id, existing.id));
      await tx
        .delete(stationeryOrderItemsTable)
        .where(eq(stationeryOrderItemsTable.order_id, existing.id));
      orderId = existing.id;
    } else {
      const [inserted] = await tx
        .insert(stationeryOrdersTable)
        .values({
          drive_id: opts.drive_id,
          tenant_id: opts.tenant_id,
          student_user_id: opts.student_user_id,
          student_code: opts.student_code,
          student_name: opts.student_name,
          class_id: opts.class_id,
          class_name: opts.class_name,
          parent_user_id: opts.parent_user_id,
          placed_by: opts.placed_by,
          status: opts.status,
          notes: opts.notes,
          total_tsh: total,
          submitted_at: submittedAt,
        })
        .returning({ id: stationeryOrdersTable.id });
      orderId = inserted!.id;
    }
    await tx
      .insert(stationeryOrderItemsTable)
      .values(linesPriced.map((l) => ({ ...l, order_id: orderId })));
    return { order_id: orderId, total_tsh: total };
  });
}

// ---------------------------------------------------------------------------
// Parent endpoints
// ---------------------------------------------------------------------------
router.get(
  "/v1/parent/stationery/drive",
  requireAuth(["parent"]),
  async (_req, res) => {
    const drive = await getOpenDrive();
    if (!drive) return res.json({ drive: null, items: [] });
    const tenantId = await defaultTenantId();
    const items = await catalogForTenant(tenantId);
    res.json({ drive, items });
  },
);

router.get(
  "/v1/parent/stationery/orders",
  requireAuth(["parent"]),
  async (req, res) => {
    const parentId = Number(req.auth?.user_id);
    const drive = await getOpenDrive();
    if (!drive) return res.json({ orders: [] });
    // Find this parent's children
    const links = await db
      .select({ student_user_id: parentChildrenTable.student_user_id })
      .from(parentChildrenTable)
      .where(eq(parentChildrenTable.parent_user_id, parentId));
    if (links.length === 0) return res.json({ orders: [] });
    const orders = await db
      .select()
      .from(stationeryOrdersTable)
      .where(
        and(
          eq(stationeryOrdersTable.drive_id, drive.id),
          inArray(
            stationeryOrdersTable.student_user_id,
            links.map((l) => l.student_user_id),
          ),
        ),
      );
    const orderIds = orders.map((o) => o.id);
    const lines =
      orderIds.length > 0
        ? await db
            .select()
            .from(stationeryOrderItemsTable)
            .where(inArray(stationeryOrderItemsTable.order_id, orderIds))
        : [];
    res.json({
      orders: orders.map((o) => ({
        ...o,
        items: lines.filter((l) => l.order_id === o.id),
      })),
    });
  },
);

router.post(
  "/v1/parent/stationery/order",
  requireAuth(["parent"]),
  async (req, res) => {
    const parentId = Number(req.auth?.user_id);
    const drive = await getOpenDrive();
    if (!drive) return res.status(409).json({ error: "No open stationery drive" });
    const studentId = Number(req.body?.student_user_id);
    if (!Number.isFinite(studentId))
      return res.status(400).json({ error: "student_user_id required" });
    // Verify ownership
    const [link] = await db
      .select()
      .from(parentChildrenTable)
      .where(
        and(
          eq(parentChildrenTable.parent_user_id, parentId),
          eq(parentChildrenTable.student_user_id, studentId),
        ),
      );
    if (!link) return res.status(403).json({ error: "Not your child" });
    const [student] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, studentId));
    if (!student) return res.status(404).json({ error: "Student missing" });
    const lines = sanitizeLines(req.body?.lines);
    const tenantId = link.tenant_id ?? (await defaultTenantId());
    try {
      const result = await persistOrder({
        drive_id: drive.id,
        tenant_id: tenantId,
        student_user_id: studentId,
        student_code: student.student_code ?? "",
        student_name: student.name,
        class_id: null,
        class_name: null,
        parent_user_id: parentId,
        placed_by: "parent",
        status: "approved", // parent submitting directly = self-approved
        lines,
      });
      if ("error" in result) return res.status(400).json({ error: result.error });
      // approved orders: stamp approved_at
      await db
        .update(stationeryOrdersTable)
        .set({ approved_at: new Date() })
        .where(eq(stationeryOrdersTable.id, result.order_id));
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  },
);

// Approve / reject an existing pending order (from teacher or watch flow).
router.post(
  "/v1/parent/stationery/order/:id/approve",
  requireAuth(["parent"]),
  async (req, res) => {
    const orderId = Number(req.params["id"]);
    const parentId = Number(req.auth?.user_id);
    const loaded = await loadOrderWithLines(orderId);
    if (!loaded) return res.status(404).json({ error: "Order not found" });
    // Verify parent owns the student.
    const [link] = await db
      .select()
      .from(parentChildrenTable)
      .where(
        and(
          eq(parentChildrenTable.parent_user_id, parentId),
          eq(parentChildrenTable.student_user_id, loaded.order.student_user_id),
        ),
      );
    if (!link) return res.status(403).json({ error: "Not your child" });
    if (loaded.order.status !== "pending_parent_approval")
      return res.status(409).json({ error: "Order not awaiting approval" });
    await db
      .update(stationeryOrdersTable)
      .set({
        status: "approved",
        approved_at: new Date(),
        parent_user_id: parentId,
        updated_at: new Date(),
      })
      .where(eq(stationeryOrdersTable.id, orderId));
    res.json({ ok: true });
  },
);

router.post(
  "/v1/parent/stationery/order/:id/reject",
  requireAuth(["parent"]),
  async (req, res) => {
    const orderId = Number(req.params["id"]);
    const parentId = Number(req.auth?.user_id);
    const loaded = await loadOrderWithLines(orderId);
    if (!loaded) return res.status(404).json({ error: "Order not found" });
    const [link] = await db
      .select()
      .from(parentChildrenTable)
      .where(
        and(
          eq(parentChildrenTable.parent_user_id, parentId),
          eq(parentChildrenTable.student_user_id, loaded.order.student_user_id),
        ),
      );
    if (!link) return res.status(403).json({ error: "Not your child" });
    // Mirror the approve guard: only `pending_parent_approval` orders may be
    // rejected. Without this, a parent could nullify an already-approved or
    // packed order, which would silently disappear from central compilation
    // (which sums on status='approved') and corrupt procurement state.
    if (loaded.order.status !== "pending_parent_approval")
      return res.status(409).json({ error: "Order is no longer pending" });
    await db
      .update(stationeryOrdersTable)
      .set({ status: "rejected", updated_at: new Date(), parent_user_id: parentId })
      .where(eq(stationeryOrdersTable.id, orderId));
    res.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// Teacher endpoints
// ---------------------------------------------------------------------------
router.get(
  "/v1/teacher/stationery/drive",
  requireAuth(["teacher", "admin", "super_admin"]),
  async (_req, res) => {
    const drive = await getOpenDrive();
    if (!drive) return res.json({ drive: null, items: [], orders: [] });
    const tenantId = await defaultTenantId();
    const items = await catalogForTenant(tenantId);
    const orders = await db
      .select()
      .from(stationeryOrdersTable)
      .where(
        and(
          eq(stationeryOrdersTable.drive_id, drive.id),
          eq(stationeryOrdersTable.tenant_id, tenantId),
        ),
      )
      .orderBy(desc(stationeryOrdersTable.created_at));
    res.json({ drive, items, orders });
  },
);

router.post(
  "/v1/teacher/stationery/order",
  requireAuth(["teacher", "admin", "super_admin"]),
  async (req, res) => {
    const drive = await getOpenDrive();
    if (!drive) return res.status(409).json({ error: "No open drive" });
    const studentId = Number(req.body?.student_user_id);
    if (!Number.isFinite(studentId))
      return res.status(400).json({ error: "student_user_id required" });
    const [student] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, studentId));
    if (!student || student.role !== "student")
      return res.status(404).json({ error: "Student not found" });
    const tenantId = await defaultTenantId();
    // Find their class
    const [membership] = await db
      .select({
        class_id: classesTable.id,
        class_name: classesTable.name,
      })
      .from(classMembershipsTable)
      .innerJoin(classesTable, eq(classesTable.id, classMembershipsTable.class_id))
      .where(eq(classMembershipsTable.student_id, studentId))
      .limit(1);
    const lines = sanitizeLines(req.body?.lines);
    try {
      const result = await persistOrder({
        drive_id: drive.id,
        tenant_id: tenantId,
        student_user_id: studentId,
        student_code: student.student_code ?? "",
        student_name: student.name,
        class_id: membership?.class_id ?? null,
        class_name: membership?.class_name ?? null,
        parent_user_id: null,
        placed_by: "teacher",
        status: "pending_parent_approval",
        notes: typeof req.body?.notes === "string" ? req.body.notes : null,
        lines,
      });
      if ("error" in result) return res.status(400).json({ error: result.error });
      // Fire-and-forget: notify linked parents that an order needs approval.
      sendApprovalPushToParents(studentId, {
        title: "Stationery order needs your approval",
        body: `${student.name}'s teacher placed an order for TSh ${result.total_tsh.toLocaleString()}.`,
        url: "/stationery",
      }).catch((err) => logger.warn({ err }, "stationery push (teacher) failed"));
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  },
);

// List all students at this tenant for the drive screen
router.get(
  "/v1/teacher/stationery/students",
  requireAuth(["teacher", "admin", "super_admin"]),
  async (_req, res) => {
    const rows = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        student_code: usersTable.student_code,
        grade: usersTable.grade,
        class_id: classesTable.id,
        class_name: classesTable.name,
      })
      .from(usersTable)
      .leftJoin(classMembershipsTable, eq(classMembershipsTable.student_id, usersTable.id))
      .leftJoin(classesTable, eq(classesTable.id, classMembershipsTable.class_id))
      .where(eq(usersTable.role, "student"))
      .orderBy(asc(usersTable.name));
    res.json({ students: rows });
  },
);

// ---------------------------------------------------------------------------
// Watch endpoints
// ---------------------------------------------------------------------------
router.get(
  "/v1/watch/stationery/drive",
  requireAuth(["student"]),
  async (_req, res) => {
    const drive = await getOpenDrive();
    if (!drive) return res.json({ drive: null, items: [] });
    const tenantId = await defaultTenantId();
    const items = await catalogForTenant(tenantId);
    res.json({ drive, items });
  },
);

router.post(
  "/v1/watch/stationery/order",
  requireAuth(["student"]),
  async (req, res) => {
    const studentId = Number(req.auth?.user_id);
    const studentCode = req.auth?.student_id ?? "";
    if (!studentId) return res.status(401).json({ error: "no student" });
    const drive = await getOpenDrive();
    if (!drive) return res.status(409).json({ error: "No open drive" });
    const [student] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, studentId));
    if (!student) return res.status(404).json({ error: "Student missing" });
    const tenantId = await defaultTenantId();
    const [membership] = await db
      .select({
        class_id: classesTable.id,
        class_name: classesTable.name,
      })
      .from(classMembershipsTable)
      .innerJoin(classesTable, eq(classesTable.id, classMembershipsTable.class_id))
      .where(eq(classMembershipsTable.student_id, studentId))
      .limit(1);
    const lines = sanitizeLines(req.body?.lines);
    try {
      const result = await persistOrder({
        drive_id: drive.id,
        tenant_id: tenantId,
        student_user_id: studentId,
        student_code: studentCode || student.student_code || "",
        student_name: student.name,
        class_id: membership?.class_id ?? null,
        class_name: membership?.class_name ?? null,
        parent_user_id: null,
        placed_by: "student_watch",
        status: "pending_parent_approval",
        lines,
      });
      if ("error" in result) return res.status(400).json({ error: result.error });
      sendApprovalPushToParents(studentId, {
        title: "Stationery order needs your approval",
        body: `${student.name} placed an order for TSh ${result.total_tsh.toLocaleString()} from their watch.`,
        url: "/stationery",
      }).catch((err) => logger.warn({ err }, "stationery push (watch) failed"));
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  },
);

export default router;
