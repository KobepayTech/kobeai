import { Router, type Request, type Response, type NextFunction } from "express";
import {
  db,
  tenantsTable,
  studentSubscriptionsTable,
  tenantUsageSnapshotsTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import { generateLicenseKey, compareLicenseKeys } from "../lib/license";
import { logger } from "../lib/logger";

const router = Router();

// ---------------------------------------------------------------------------
// SUPER-ADMIN ROUTES (used by the central admin web UI)
// All require an `admin` role JWT. In a real deployment, this is its own
// "central" admin account distinct from any per-school admin.
// ---------------------------------------------------------------------------

// Hard separation from per-school admin: only the dedicated super-admin role
// can touch the central control plane. A school's `admin@school.tz` (role
// "admin") is intentionally NOT enough — central routes must not leak data
// across tenants or expose other schools' license keys.
router.use("/central/v1/admin", requireAuth(["super_admin"]));

/** Mask all but the prefix and last 4 chars of a license key. */
function maskLicenseKey(key: string): string {
  if (key.length <= 16) return "•".repeat(key.length);
  return `${key.slice(0, 12)}${"•".repeat(key.length - 16)}${key.slice(-4)}`;
}

router.get("/central/v1/admin/tenants", async (_req, res) => {
  const tenants = await db.select().from(tenantsTable).orderBy(tenantsTable.id);

  // Counts + latest usage per tenant — N+1 is fine at the scale we're targeting
  // (the user said "more than 10 schools"; even 10,000 tenants is trivial).
  const enriched = await Promise.all(
    tenants.map(async (t) => {
      const subs = await db
        .select()
        .from(studentSubscriptionsTable)
        .where(eq(studentSubscriptionsTable.tenant_id, t.id));
      const active = subs.filter((s) => s.status === "active").length;
      const mrr = subs
        .filter((s) => s.status === "active")
        .reduce((sum, s) => sum + (s.monthly_price_tsh ?? 0), 0);
      const [latestUsage] = await db
        .select()
        .from(tenantUsageSnapshotsTable)
        .where(eq(tenantUsageSnapshotsTable.tenant_id, t.id))
        .orderBy(desc(tenantUsageSnapshotsTable.snapshot_at))
        .limit(1);
      // Mask license keys in the list view to keep them out of dashboards,
      // shoulder-surfing, screen recordings, and copy-pasted screenshots. Full
      // value is only available on the detail endpoint, which is also a
      // separate explicit request a super-admin has to make.
      return {
        ...t,
        license_key: maskLicenseKey(t.license_key),
        students_total: subs.length,
        students_active: active,
        mrr_tsh: mrr,
        latest_usage: latestUsage ?? null,
      };
    }),
  );
  res.json({ tenants: enriched });
});

router.post("/central/v1/admin/tenants", async (req, res) => {
  const { name, slug, region, plan, contact_email, contact_phone, students_cap } = req.body ?? {};
  if (!name || !slug) {
    res.status(400).json({ error: "name and slug are required" });
    return;
  }
  const existing = await db.select().from(tenantsTable).where(eq(tenantsTable.slug, slug));
  if (existing.length > 0) {
    res.status(409).json({ error: "A tenant with that slug already exists" });
    return;
  }
  const license_key = generateLicenseKey();
  const [created] = await db
    .insert(tenantsTable)
    .values({
      name,
      slug,
      region: region ?? "Tanzania",
      plan: plan ?? "standard",
      license_key,
      contact_email: contact_email ?? null,
      contact_phone: contact_phone ?? null,
      students_cap: students_cap ?? 500,
    })
    .returning();
  res.status(201).json({ tenant: created });
});

router.get("/central/v1/admin/tenants/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, id));
  if (!tenant) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const subscriptions = await db
    .select()
    .from(studentSubscriptionsTable)
    .where(eq(studentSubscriptionsTable.tenant_id, id))
    .orderBy(studentSubscriptionsTable.student_code);
  const usage = await db
    .select()
    .from(tenantUsageSnapshotsTable)
    .where(eq(tenantUsageSnapshotsTable.tenant_id, id))
    .orderBy(desc(tenantUsageSnapshotsTable.snapshot_at))
    .limit(20);
  res.json({ tenant, subscriptions, usage });
});

router.post("/central/v1/admin/tenants/:id/subscriptions", async (req, res) => {
  const tenant_id = Number(req.params.id);
  const { student_code, student_name, plan, status, monthly_price_tsh, parent_phone, expires_at } = req.body ?? {};
  if (!student_code || !student_name) {
    res.status(400).json({ error: "student_code and student_name are required" });
    return;
  }
  const existing = await db
    .select()
    .from(studentSubscriptionsTable)
    .where(
      and(
        eq(studentSubscriptionsTable.tenant_id, tenant_id),
        eq(studentSubscriptionsTable.student_code, student_code),
      ),
    );
  const expiresDate = expires_at ? new Date(expires_at) : null;
  if (existing.length > 0) {
    const [updated] = await db
      .update(studentSubscriptionsTable)
      .set({
        student_name,
        plan: plan ?? existing[0].plan,
        status: status ?? existing[0].status,
        monthly_price_tsh: monthly_price_tsh ?? existing[0].monthly_price_tsh,
        parent_phone: parent_phone ?? existing[0].parent_phone,
        expires_at: expiresDate ?? existing[0].expires_at,
        last_payment_at: status === "active" ? new Date() : existing[0].last_payment_at,
        updated_at: new Date(),
      })
      .where(eq(studentSubscriptionsTable.id, existing[0].id))
      .returning();
    res.json({ subscription: updated });
    return;
  }
  const [created] = await db
    .insert(studentSubscriptionsTable)
    .values({
      tenant_id,
      student_code,
      student_name,
      plan: plan ?? "basic",
      status: status ?? "active",
      monthly_price_tsh: monthly_price_tsh ?? 5000,
      parent_phone: parent_phone ?? null,
      expires_at: expiresDate,
      last_payment_at: status === "active" ? new Date() : null,
    })
    .returning();
  res.status(201).json({ subscription: created });
});

router.delete("/central/v1/admin/tenants/:id/subscriptions/:studentCode", async (req, res) => {
  const tenant_id = Number(req.params.id);
  const student_code = req.params.studentCode;
  await db
    .delete(studentSubscriptionsTable)
    .where(
      and(
        eq(studentSubscriptionsTable.tenant_id, tenant_id),
        eq(studentSubscriptionsTable.student_code, student_code),
      ),
    );
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// SCHOOL-FACING SYNC API
// Called by each school's local api-server. Auth is the per-tenant license key
// in `x-tenant-license-key`. NEVER use a JWT here — these calls happen
// machine-to-machine without a user session.
// ---------------------------------------------------------------------------

async function authenticateTenant(req: Request, res: Response, next: NextFunction): Promise<void> {
  const provided = (req.header("x-tenant-license-key") ?? "").trim();
  if (!provided) {
    res.status(401).json({ error: "Missing x-tenant-license-key" });
    return;
  }
  const tenants = await db.select().from(tenantsTable);
  const tenant = tenants.find((t) => compareLicenseKeys(t.license_key, provided));
  if (!tenant || !tenant.active) {
    res.status(403).json({ error: "Invalid or inactive tenant license" });
    return;
  }
  (req as Request & { tenant?: typeof tenant }).tenant = tenant;
  next();
}

router.post("/central/v1/sync", authenticateTenant, async (req, res) => {
  const tenant = (req as Request & { tenant?: { id: number } }).tenant!;
  const ip = (req.headers["x-forwarded-for"] as string) ?? req.socket.remoteAddress ?? null;
  await db
    .update(tenantsTable)
    .set({ last_sync_at: new Date(), last_sync_ip: ip })
    .where(eq(tenantsTable.id, tenant.id));
  const subs = await db
    .select()
    .from(studentSubscriptionsTable)
    .where(eq(studentSubscriptionsTable.tenant_id, tenant.id));
  res.json({
    tenant_id: tenant.id,
    server_time: new Date().toISOString(),
    subscriptions: subs.map((s) => ({
      student_code: s.student_code,
      status: s.status,
      plan: s.plan,
      expires_at: s.expires_at?.toISOString() ?? null,
    })),
  });
});

router.post("/central/v1/usage", authenticateTenant, async (req, res) => {
  const tenant = (req as Request & { tenant?: { id: number } }).tenant!;
  const { students_total, students_active_24h, ai_questions_24h, print_jobs_24h } = req.body ?? {};
  await db.insert(tenantUsageSnapshotsTable).values({
    tenant_id: tenant.id,
    students_total: Number(students_total ?? 0),
    students_active_24h: Number(students_active_24h ?? 0),
    ai_questions_24h: Number(ai_questions_24h ?? 0),
    print_jobs_24h: Number(print_jobs_24h ?? 0),
  });
  logger.info({ tenant: tenant.id }, "usage snapshot recorded");
  res.status(201).json({ ok: true });
});

export default router;
