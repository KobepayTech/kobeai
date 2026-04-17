import { Router } from "express";
import { AddFundsBody } from "@workspace/api-zod";
import { db, subscriptionCacheTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import { listDocumentsForStudent } from "../lib/student-documents";

const router = Router();

router.use("/v1/parent", requireAuth(["parent"]));

// Helper for parent-initiated payments: forward to central using THIS school's
// license key. Reads env lazily (same reason as central-sync.ts).
async function centralFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = process.env["CENTRAL_BASE_URL"] ?? "";
  const key = process.env["TENANT_LICENSE_KEY"] ?? "";
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-tenant-license-key": key,
      ...(init.headers ?? {}),
    },
  });
}

// Demo bridge: parent demo child id -> real student_code in the DB.
//
// SECURITY NOTE: the parent demo currently uses a single hardcoded CHILDREN
// list shared across all parent tokens (the auth payload has user_id 0 with
// no parent->student FK in the schema yet). Every endpoint in this file
// trusts the path-parameter child id against this static list. That's
// intentional for the demo but is NOT production-safe — when the parents
// schema lands, replace this map with a `parent_id -> student_id[]` query
// and reject `:childId` values that aren't owned by `req.auth.sub`.
const CHILD_TO_STUDENT_CODE: Record<string, string> = {
  "1": "TEST001",
  "2": "TEST002",
};

const CHILDREN = [
  {
    id: "1",
    name: "John Mwangi",
    grade: "Form 1",
    balance: 52000,
    today_points: 85,
    total_points: 3450,
    attendance_streak: 12,
    daily_limit: 5000,
    transactions: [
      { id: "1", amount: 20, type: "attendance", description: "Daily attendance check-in", created_at: new Date(Date.now() - 3600000).toISOString() },
      { id: "2", amount: 10, type: "ai_question", description: "Asked about photosynthesis", created_at: new Date(Date.now() - 7200000).toISOString() },
      { id: "3", amount: 25, type: "quiz", description: "Completed Science Quiz", created_at: new Date(Date.now() - 10800000).toISOString() },
    ],
  },
  {
    id: "2",
    name: "Mary Mwangi",
    grade: "Standard 4",
    balance: 18500,
    today_points: 45,
    total_points: 1820,
    attendance_streak: 7,
    daily_limit: 3000,
    transactions: [
      { id: "4", amount: 20, type: "attendance", description: "Daily attendance check-in", created_at: new Date(Date.now() - 3600000).toISOString() },
      { id: "5", amount: 10, type: "ai_question", description: "Asked about Tanzania history", created_at: new Date(Date.now() - 7200000).toISOString() },
    ],
  },
];

const ACTIVITY: Record<string, { id: string; type: string; description: string; points: number; timestamp: string; subject: string }[]> = {
  "1": [
    { id: "1", type: "attendance", description: "Checked in for school", points: 20, timestamp: new Date(Date.now() - 3600000).toISOString(), subject: "School" },
    { id: "2", type: "ai_question", description: "Asked about photosynthesis", points: 10, timestamp: new Date(Date.now() - 7200000).toISOString(), subject: "Biology" },
    { id: "3", type: "quiz", description: "Completed Science Quiz - Score 80%", points: 25, timestamp: new Date(Date.now() - 10800000).toISOString(), subject: "Science" },
    { id: "4", type: "ai_question", description: "Asked about Pythagorean theorem", points: 10, timestamp: new Date(Date.now() - 14400000).toISOString(), subject: "Mathematics" },
    { id: "5", type: "attendance", description: "Checked in for school", points: 20, timestamp: new Date(Date.now() - 86400000).toISOString(), subject: "School" },
  ],
  "2": [
    { id: "1", type: "attendance", description: "Checked in for school", points: 20, timestamp: new Date(Date.now() - 3600000).toISOString(), subject: "School" },
    { id: "2", type: "ai_question", description: "Asked about Tanzania history", points: 10, timestamp: new Date(Date.now() - 7200000).toISOString(), subject: "History" },
    { id: "3", type: "quiz", description: "Completed Kiswahili Vocabulary", points: 30, timestamp: new Date(Date.now() - 86400000 + 3600000).toISOString(), subject: "Kiswahili" },
  ],
};

router.get("/v1/parent/dashboard", (_req, res) => {
  res.json({
    parent_name: "Grace Mwangi",
    children: CHILDREN.map(({ id, name, grade, balance, today_points, total_points, attendance_streak }) => ({
      id, name, grade, balance, today_points, total_points, attendance_streak,
    })),
  });
});

router.get("/v1/parent/child/:childId/activity", (req, res) => {
  const { childId } = req.params;
  const child = CHILDREN.find((c) => c.id === childId);
  if (!child) {
    res.status(404).json({ error: "Child not found" });
    return;
  }
  res.json({
    child_name: child.name,
    activities: ACTIVITY[childId] ?? [],
  });
});

/**
 * GET /v1/parent/child/:childId/documents
 * Documents assigned to the classes this child belongs to.
 * Same join the student watch sees in the print picker, so parents always
 * know exactly what is available for tap-to-print.
 */
router.get("/v1/parent/child/:childId/documents", async (req, res) => {
  const { childId } = req.params;
  const child = CHILDREN.find((c) => c.id === childId);
  if (!child) {
    res.status(404).json({ error: "Child not found" });
    return;
  }
  const studentCode = CHILD_TO_STUDENT_CODE[childId];
  const documents = studentCode ? await listDocumentsForStudent(studentCode) : [];
  res.json({
    child_name: child.name,
    documents: documents.map((d) => ({
      id: d.id,
      name: d.name,
      subject: d.subject,
      pages: d.pages,
      size_kb: Math.max(1, Math.round(d.size_bytes / 1024)),
      assigned_at: d.created_at,
    })),
  });
});

router.get("/v1/parent/wallet", (_req, res) => {
  const totalBalance = CHILDREN.reduce((sum, c) => sum + c.balance, 0);
  res.json({
    total_balance: totalBalance,
    children: CHILDREN.map(({ id, name, grade, balance, daily_limit, transactions }) => ({
      id, name, grade, balance, daily_limit, transactions,
    })),
  });
});

/**
 * GET /v1/parent/subscriptions
 * Lists this parent's children with their current subscription status pulled
 * from the local subscription_cache (which was populated by the central sync
 * agent). Always reads from the local cache so the parent app keeps working
 * during a central outage.
 */
router.get("/v1/parent/subscriptions", async (_req, res) => {
  const out = await Promise.all(
    CHILDREN.map(async (c) => {
      const code = CHILD_TO_STUDENT_CODE[c.id];
      if (!code) return null;
      const [sub] = await db
        .select()
        .from(subscriptionCacheTable)
        .where(eq(subscriptionCacheTable.student_code, code));
      return {
        child_id: c.id,
        child_name: c.name,
        grade: c.grade,
        student_code: code,
        plan: sub?.plan ?? "basic",
        status: sub?.status ?? "uncached",
        monthly_price_tsh: sub?.monthly_price_tsh ?? 5000,
        expires_at: sub?.expires_at?.toISOString() ?? null,
        parent_phone: sub?.parent_phone ?? null,
      };
    }),
  );
  res.json({ subscriptions: out.filter(Boolean) });
});

/**
 * POST /v1/parent/subscriptions/pay
 * { child_id, phone? } — initiates an M-Pesa STK push for this child's
 * monthly subscription. The actual STK is simulated in the central server
 * (see routes/central.ts: /central/v1/payments/initiate). Returns the
 * payment_id which the client can poll until status flips to success/failed.
 */
router.post("/v1/parent/subscriptions/pay", async (req, res) => {
  const { child_id, phone } = req.body ?? {};
  const child = CHILDREN.find((c) => c.id === child_id);
  const code = child_id ? CHILD_TO_STUDENT_CODE[child_id] : undefined;
  if (!child || !code) {
    res.status(404).json({ error: "Child not found" });
    return;
  }
  const [sub] = await db
    .select()
    .from(subscriptionCacheTable)
    .where(eq(subscriptionCacheTable.student_code, code));
  if (!sub) {
    res.status(409).json({ error: "Subscription not synced yet — please retry in a moment." });
    return;
  }
  const useAmount = sub.monthly_price_tsh > 0 ? sub.monthly_price_tsh : 5000;
  const usePhone = (phone ?? sub.parent_phone ?? "").toString().trim();
  if (!usePhone) {
    res.status(400).json({ error: "Phone number required" });
    return;
  }
  const upstream = await centralFetch("/api/central/v1/payments/initiate", {
    method: "POST",
    body: JSON.stringify({ student_code: code, phone: usePhone, amount_tsh: useAmount }),
  });
  const body = await upstream.json();
  res.status(upstream.status).json(body);
});

router.get("/v1/parent/subscriptions/payment/:id", async (req, res) => {
  // Read from the central source of truth via license-key proxy. In the demo
  // central + school share one DB, but we go through the central API anyway
  // so that (a) this code keeps working when central moves to its own host
  // and (b) we get the central tenant_id scoping for free.
  //
  // Then enforce that the payment belongs to a student this parent owns —
  // prevents enumerating other parents' payment IDs (IDOR).
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid payment id" });
    return;
  }
  const upstream = await centralFetch(`/api/central/v1/payments/${id}`);
  if (!upstream.ok) {
    res.status(upstream.status).json(await upstream.json().catch(() => ({ error: "Upstream error" })));
    return;
  }
  const body = await upstream.json();
  const ownedCodes = new Set(Object.values(CHILD_TO_STUDENT_CODE));
  if (!body.payment || !ownedCodes.has(body.payment.student_code)) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }
  res.json({ payment: body.payment });
});

router.post("/v1/parent/wallet/add-funds", (req, res) => {
  const parsed = AddFundsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { child_id, amount } = parsed.data;
  const child = CHILDREN.find((c) => c.id === child_id);
  const newBalance = (child?.balance ?? 0) + amount;
  res.json({
    success: true,
    new_balance: newBalance,
    message: `Successfully added TSh ${amount.toLocaleString()} to ${child?.name ?? "child"}'s wallet`,
    receipt_id: `RCP-${Date.now()}`,
  });
});

export default router;
