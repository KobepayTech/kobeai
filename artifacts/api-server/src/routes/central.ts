import { Router, type Request, type Response, type NextFunction } from "express";
import {
  db,
  tenantsTable,
  studentSubscriptionsTable,
  tenantUsageSnapshotsTable,
  subscriptionPaymentsTable,
  usersTable,
  studentKpTable,
  kpLedgerTable,
  kpPendingGrantsTable,
  questionLocksTable,
} from "@workspace/db";
import { eq, and, desc, gte, sql, isNull, inArray } from "drizzle-orm";
import { marketQuestionsTable } from "@workspace/db";
import crypto from "node:crypto";
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
      student_name: s.student_name,
      status: s.status,
      plan: s.plan,
      monthly_price_tsh: s.monthly_price_tsh,
      parent_phone: s.parent_phone,
      expires_at: s.expires_at?.toISOString() ?? null,
    })),
  });
});

// ---------------------------------------------------------------------------
// PAYMENT / STK PUSH ROUTES — parent app initiates via local school server,
// which proxies to here. License-key authed (school <-> central). After demo
// confirmation, we extend the student's subscription and notify the bursar
// via the subscription_payments rows they read from /admin endpoints below.
// ---------------------------------------------------------------------------

/** Demo-only: simulate the M-Pesa STK callback by auto-completing in N ms. */
const DEMO_STK_DELAY_MS = Number(process.env["DEMO_STK_DELAY_MS"] ?? 4000);

async function completePayment(paymentId: number): Promise<void> {
  const [payment] = await db
    .select()
    .from(subscriptionPaymentsTable)
    .where(eq(subscriptionPaymentsTable.id, paymentId));
  if (!payment || payment.status !== "pending") return;

  // Demo: ~92% success rate so the failure path is also visible occasionally.
  const failed = Math.random() < 0.08;
  if (failed) {
    // Idempotent: only flip if still pending (concurrent timer + manual
    // callback could otherwise race and we'd "fail" an already-succeeded row).
    await db
      .update(subscriptionPaymentsTable)
      .set({
        status: "failed",
        failure_reason: "Request cancelled by user",
        completed_at: new Date(),
      })
      .where(and(eq(subscriptionPaymentsTable.id, paymentId), eq(subscriptionPaymentsTable.status, "pending")));
    logger.info({ paymentId }, "subscription payment FAILED (demo)");
    return;
  }

  const receipt = `M${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await db.transaction(async (tx) => {
    // Conditional update + RETURNING claims the row exactly once. If a
    // concurrent caller already settled this payment, the update returns
    // zero rows and we skip the subscription renewal so we don't double-extend.
    const claimed = await tx
      .update(subscriptionPaymentsTable)
      .set({
        status: "success",
        mpesa_receipt: receipt,
        completed_at: new Date(),
      })
      .where(and(eq(subscriptionPaymentsTable.id, paymentId), eq(subscriptionPaymentsTable.status, "pending")))
      .returning();
    if (claimed.length === 0) {
      logger.info({ paymentId }, "subscription payment already settled, skipping");
      return;
    }

    // Renew the subscription on the source-of-truth table. Verify it touched
    // exactly one row — if the subscription was deleted between initiate and
    // complete, we surface that via logs instead of silently swallowing it.
    const renewed = await tx
      .update(studentSubscriptionsTable)
      .set({
        status: "active",
        plan: payment.plan,
        last_payment_at: new Date(),
        expires_at: newExpiry,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(studentSubscriptionsTable.tenant_id, payment.tenant_id),
          eq(studentSubscriptionsTable.student_code, payment.student_code),
        ),
      )
      .returning({ id: studentSubscriptionsTable.id });
    if (renewed.length === 0) {
      logger.warn(
        { paymentId, tenant_id: payment.tenant_id, student_code: payment.student_code },
        "payment succeeded but subscription row missing — bursar should refund or recreate",
      );
    }

    // Membership KP grant: every successful subscription payment also tops
    // up the student's KP balance so the question-market is funded and the
    // child has something to spend on locks. Conservation invariant
    // (sum(kp_ledger.delta) == student_kp.balance) is preserved by doing
    // both writes in this same transaction.
    const grant = Number(process.env["MEMBERSHIP_KP_GRANT"] ?? 100);
    if (grant > 0) {
      const [student] = await tx
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.student_code, payment.student_code))
        .limit(1);
      if (student) {
        const [bal] = await tx
          .select({ balance: studentKpTable.balance })
          .from(studentKpTable)
          .where(eq(studentKpTable.user_id, student.id))
          .for("update")
          .limit(1);
        const newBalance = (bal?.balance ?? 0) + grant;
        await tx
          .insert(studentKpTable)
          .values({ user_id: student.id, balance: newBalance })
          .onConflictDoUpdate({
            target: studentKpTable.user_id,
            set: { balance: newBalance, updated_at: new Date() },
          });
        await tx.insert(kpLedgerTable).values({
          user_id: student.id,
          delta: grant,
          reason: "membership_grant",
          balance_after: newBalance,
        });
        logger.info(
          { paymentId, student_id: student.id, grant, newBalance },
          "membership KP grant credited",
        );
      } else {
        // No `users` row yet for this student_code (the per-school student
        // hasn't been provisioned in this DB). Park the grant in
        // `kp_pending_grants` so it isn't lost — it will be drained the
        // first time that student calls a KP-aware endpoint.
        await tx.insert(kpPendingGrantsTable).values({
          student_code: payment.student_code,
          delta: grant,
          reason: "membership_grant",
        });
        logger.info(
          { paymentId, student_code: payment.student_code, grant },
          "no users row yet — KP grant parked in kp_pending_grants",
        );
      }
    }
  });
  logger.info({ paymentId, receipt }, "subscription payment SUCCESS");
}

router.post("/central/v1/payments/initiate", authenticateTenant, async (req, res) => {
  const tenant = (req as Request & { tenant?: { id: number } }).tenant!;
  const { student_code, phone, amount_tsh } = req.body ?? {};
  if (!student_code || !phone || !amount_tsh) {
    res.status(400).json({ error: "student_code, phone, amount_tsh required" });
    return;
  }
  // Verify the student belongs to this tenant — never let one school's license
  // key initiate a payment against another school's student.
  const [sub] = await db
    .select()
    .from(studentSubscriptionsTable)
    .where(
      and(
        eq(studentSubscriptionsTable.tenant_id, tenant.id),
        eq(studentSubscriptionsTable.student_code, student_code),
      ),
    );
  if (!sub) {
    res.status(404).json({ error: "Subscription not found for student" });
    return;
  }
  const checkoutId = `ws_CO_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const [created] = await db
    .insert(subscriptionPaymentsTable)
    .values({
      tenant_id: tenant.id,
      student_code,
      student_name: sub.student_name,
      plan: sub.plan,
      amount_tsh: Number(amount_tsh),
      phone: String(phone),
      status: "pending",
      checkout_request_id: checkoutId,
    })
    .returning();

  // DEMO: schedule auto-completion. In production this is replaced by the
  // /mpesa/callback webhook from Safaricom Daraja / Selcom / Azampay.
  setTimeout(() => {
    void completePayment(created.id).catch((err) =>
      logger.warn({ err, paymentId: created.id }, "payment completion failed"),
    );
  }, DEMO_STK_DELAY_MS);

  res.status(201).json({
    payment_id: created.id,
    checkout_request_id: created.checkout_request_id,
    status: created.status,
    amount_tsh: created.amount_tsh,
    phone: created.phone,
    message: `STK push sent to ${phone}. Enter your M-Pesa PIN to confirm.`,
  });
});

router.get("/central/v1/payments/:id", authenticateTenant, async (req, res) => {
  const tenant = (req as Request & { tenant?: { id: number } }).tenant!;
  const id = Number(req.params.id);
  const [payment] = await db
    .select()
    .from(subscriptionPaymentsTable)
    .where(
      and(
        eq(subscriptionPaymentsTable.id, id),
        eq(subscriptionPaymentsTable.tenant_id, tenant.id),
      ),
    );
  if (!payment) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }
  // Surface the KP bonus the parent app shows on the success screen. Only
  // populated when the payment actually settled — failed/pending payments
  // never trigger the grant transaction in completePayment.
  const kp_granted =
    payment.status === "success"
      ? Number(process.env["MEMBERSHIP_KP_GRANT"] ?? 100)
      : 0;
  res.json({ payment: { ...payment, kp_granted } });
});

router.get("/central/v1/payments", authenticateTenant, async (req, res) => {
  const tenant = (req as Request & { tenant?: { id: number } }).tenant!;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const payments = await db
    .select()
    .from(subscriptionPaymentsTable)
    .where(eq(subscriptionPaymentsTable.tenant_id, tenant.id))
    .orderBy(desc(subscriptionPaymentsTable.initiated_at))
    .limit(limit);
  const successful = payments.filter((p) => p.status === "success");
  const collected_tsh = successful.reduce((sum, p) => sum + p.amount_tsh, 0);
  res.json({
    payments,
    summary: {
      total_count: payments.length,
      success_count: successful.length,
      pending_count: payments.filter((p) => p.status === "pending").length,
      failed_count: payments.filter((p) => p.status === "failed").length,
      collected_tsh,
    },
  });
});

// Super-admin view of all payments for a tenant (mounted under the /admin prefix).
router.get("/central/v1/admin/tenants/:id/payments", async (req, res) => {
  const tenant_id = Number(req.params.id);
  const payments = await db
    .select()
    .from(subscriptionPaymentsTable)
    .where(eq(subscriptionPaymentsTable.tenant_id, tenant_id))
    .orderBy(desc(subscriptionPaymentsTable.initiated_at))
    .limit(100);
  res.json({ payments });
});

// ---------------------------------------------------------------------------
// SUPER-ADMIN: Question Market admin (CRUD on questions)
// The market is operator-curated: super admin authors questions, students
// across all schools lock + answer. These routes sit under /central/v1/admin
// which already requires a super_admin JWT (see router.use at top).
// ---------------------------------------------------------------------------
router.get("/central/v1/admin/market/questions", async (req, res) => {
  const status = (req.query.status as string | undefined)?.trim();
  const limit = Math.min(Number(req.query.limit ?? 200), 500);
  const where = status ? eq(marketQuestionsTable.status, status) : undefined;
  const rows = await db
    .select()
    .from(marketQuestionsTable)
    .where(where as never)
    .orderBy(desc(marketQuestionsTable.created_at))
    .limit(limit);
  // Active locks per question (for the "active locks" column in the admin UI).
  const lockCounts = await db
    .select({
      question_id: questionLocksTable.question_id,
      n: sql<number>`count(*)::int`,
    })
    .from(questionLocksTable)
    .where(
      and(
        isNull(questionLocksTable.released_at),
        gte(questionLocksTable.expires_at, new Date()),
      ),
    )
    .groupBy(questionLocksTable.question_id);
  const lockMap = new Map(lockCounts.map((l) => [l.question_id, l.n]));
  res.json({
    questions: rows.map((q) => ({ ...q, active_locks: lockMap.get(q.id) ?? 0 })),
  });
});

// Allowed lifecycle states an admin can set on a question. We deliberately
// exclude "won" (set automatically when a student answers correctly) and
// "locked" (transient state owned by the lock flow).
const ADMIN_SETTABLE_STATUSES = new Set(["open", "expired"]);
const KP_REWARD_MIN = 1;
const KP_REWARD_MAX = 100_000;

router.post("/central/v1/admin/market/questions", async (req, res) => {
  const { subject, prompt, choices, correct_index, kp_reward, expires_at } =
    req.body ?? {};
  if (typeof subject !== "string" || !subject.trim()) {
    res.status(400).json({ error: "subject required" });
    return;
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    res.status(400).json({ error: "prompt required" });
    return;
  }
  if (
    !Array.isArray(choices) ||
    choices.length < 2 ||
    choices.length > 6 ||
    !choices.every((c) => typeof c === "string" && c.trim())
  ) {
    res.status(400).json({ error: "choices must be 2-6 non-empty strings" });
    return;
  }
  const ci = Number(correct_index);
  if (!Number.isInteger(ci) || ci < 0 || ci >= choices.length) {
    res
      .status(400)
      .json({ error: `correct_index must be integer in [0, ${choices.length})` });
    return;
  }
  const rewardRaw = kp_reward ?? 500;
  const reward = Number(rewardRaw);
  if (!Number.isFinite(reward) || !Number.isInteger(reward) || reward < KP_REWARD_MIN || reward > KP_REWARD_MAX) {
    res.status(400).json({
      error: `kp_reward must be integer in [${KP_REWARD_MIN}, ${KP_REWARD_MAX}]`,
    });
    return;
  }
  let expiresAtDate: Date | null = null;
  if (expires_at != null && expires_at !== "") {
    const d = new Date(expires_at);
    if (Number.isNaN(d.getTime())) {
      res.status(400).json({ error: "expires_at must be a valid ISO datetime" });
      return;
    }
    expiresAtDate = d;
  }
  const [created] = await db
    .insert(marketQuestionsTable)
    .values({
      subject: subject.trim(),
      prompt: prompt.trim(),
      choices,
      correct_index: ci,
      kp_reward: reward,
      status: "open",
      expires_at: expiresAtDate,
    })
    .returning();
  res.status(201).json({ question: created });
});

router.patch("/central/v1/admin/market/questions/:id", async (req, res) => {
  const id = Number(req.params.id);
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.prompt === "string" && req.body.prompt.trim()) {
    patch.prompt = req.body.prompt.trim();
  }
  if (typeof req.body?.subject === "string" && req.body.subject.trim()) {
    patch.subject = req.body.subject.trim();
  }
  if (req.body?.kp_reward !== undefined) {
    const n = Number(req.body.kp_reward);
    if (!Number.isInteger(n) || n < KP_REWARD_MIN || n > KP_REWARD_MAX) {
      res.status(400).json({
        error: `kp_reward must be integer in [${KP_REWARD_MIN}, ${KP_REWARD_MAX}]`,
      });
      return;
    }
    patch.kp_reward = n;
  }
  if (req.body?.status !== undefined) {
    if (typeof req.body.status !== "string" || !ADMIN_SETTABLE_STATUSES.has(req.body.status)) {
      res.status(400).json({
        error: `status must be one of: ${[...ADMIN_SETTABLE_STATUSES].join(", ")}`,
      });
      return;
    }
    patch.status = req.body.status;
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "no fields to update" });
    return;
  }
  const [updated] = await db
    .update(marketQuestionsTable)
    .set(patch)
    .where(eq(marketQuestionsTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "question not found" });
    return;
  }
  res.json({ question: updated });
});

// ---------------------------------------------------------------------------
// SUPER-ADMIN: Global KP economy view (ledger + headline stats)
// ---------------------------------------------------------------------------
router.get("/central/v1/admin/kp/stats", async (_req, res) => {
  const since = new Date(Date.now() - 86_400_000);
  const [agg24h] = await db
    .select({
      n: sql<number>`count(*)::int`,
      net: sql<number>`coalesce(sum(${kpLedgerTable.delta}), 0)::int`,
    })
    .from(kpLedgerTable)
    .where(gte(kpLedgerTable.created_at, since));
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(kpPendingGrantsTable)
    .where(isNull(kpPendingGrantsTable.claimed_at));
  const [ledgerSum] = await db
    .select({ s: sql<number>`coalesce(sum(${kpLedgerTable.delta}), 0)::int` })
    .from(kpLedgerTable);
  const [balanceSum] = await db
    .select({ s: sql<number>`coalesce(sum(${studentKpTable.balance}), 0)::int` })
    .from(studentKpTable);
  res.json({
    entries_24h: agg24h?.n ?? 0,
    net_kp_24h: agg24h?.net ?? 0,
    pending_grants: pending?.n ?? 0,
    conservation: {
      ledger_sum: ledgerSum?.s ?? 0,
      balance_sum: balanceSum?.s ?? 0,
      balanced: (ledgerSum?.s ?? 0) === (balanceSum?.s ?? 0),
    },
  });
});

router.get("/central/v1/admin/kp/ledger", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const tenantFilter = req.query.tenant_id
    ? Number(req.query.tenant_id)
    : null;
  if (tenantFilter !== null && !Number.isFinite(tenantFilter)) {
    res.status(400).json({ error: "tenant_id must be an integer" });
    return;
  }
  // Resolve school per-row in SQL using a LATERAL subquery so the tenant
  // filter is applied in the database (correct paging) and we deterministically
  // pick the most recent subscription when a student exists in multiple
  // tenants — the `(tenant_id, student_code)` uniqueness in
  // student_subscriptions means there's typically one row, but ordering by
  // created_at desc keeps us correct under any reseed.
  const whereClause =
    tenantFilter !== null
      ? sql`WHERE sub.tenant_id = ${tenantFilter}`
      : sql``;
  const result = await db.execute(sql`
    SELECT
      l.id,
      l.created_at,
      l.delta,
      l.reason,
      l.balance_after,
      l.user_id,
      u.student_code,
      u.name AS student_name,
      sub.tenant_id,
      t.name AS school_name
    FROM kp_ledger l
    LEFT JOIN users u ON u.id = l.user_id
    LEFT JOIN LATERAL (
      SELECT s.tenant_id, s.created_at
      FROM student_subscriptions s
      WHERE s.student_code = u.student_code
      ORDER BY s.created_at DESC
      LIMIT 1
    ) sub ON TRUE
    LEFT JOIN tenants t ON t.id = sub.tenant_id
    ${whereClause}
    ORDER BY l.created_at DESC
    LIMIT ${limit}
  `);
  const entries = (result.rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    created_at: r.created_at,
    delta: Number(r.delta),
    reason: r.reason,
    balance_after: Number(r.balance_after),
    user_id: Number(r.user_id),
    student_code: r.student_code ?? null,
    student_name: r.student_name ?? null,
    tenant_id: r.tenant_id == null ? null : Number(r.tenant_id),
    school_name: r.school_name ?? null,
  }));
  res.json({ entries });
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
