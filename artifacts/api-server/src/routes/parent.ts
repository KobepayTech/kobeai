import { Router, type Request, type Response as ExpressResponse } from "express";
import { AddFundsBody } from "@workspace/api-zod";
import {
  db,
  subscriptionCacheTable,
  printJobsTable,
  studentSettingsTable,
  parentChildrenTable,
  usersTable,
} from "@workspace/db";
import { eq, inArray, desc } from "drizzle-orm";
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

// Demo bridge: legacy parent-app child ids ("1", "2") still need to map to
// real student rows so the demo flow keeps working. Every endpoint below
// resolves the child id through `parent_children` and rejects anything the
// requesting parent doesn't actually own.
const LEGACY_CHILD_ID_TO_STUDENT_CODE: Record<string, string> = {
  "1": "TEST001",
  "2": "TEST002",
};

type OwnedChild = {
  /** users.id of the student row */
  student_user_id: number;
  /** users.student_code (used by every other table that keys on student) */
  student_code: string;
  name: string;
  grade: string | null;
};

async function listOwnedChildren(parentUserId: number): Promise<OwnedChild[]> {
  const rows = await db
    .select({
      student_user_id: usersTable.id,
      student_code: usersTable.student_code,
      name: usersTable.name,
      grade: usersTable.grade,
    })
    .from(parentChildrenTable)
    .innerJoin(usersTable, eq(usersTable.id, parentChildrenTable.student_user_id))
    .where(eq(parentChildrenTable.parent_user_id, parentUserId))
    .orderBy(parentChildrenTable.created_at);
  return rows
    .filter((r) => !!r.student_code)
    .map((r) => ({
      student_user_id: r.student_user_id,
      student_code: r.student_code as string,
      name: r.name,
      grade: r.grade ?? null,
    }));
}

/**
 * Resolve the `:childId` path param to a student row that this parent owns.
 * Accepts either a numeric users.id or a legacy demo id ("1", "2") for
 * backward-compat with the existing parent-app build. Returns null if the
 * parent does not own the requested child.
 */
async function resolveOwnedChild(
  parentUserId: number,
  rawChildId: string,
): Promise<OwnedChild | null> {
  const owned = await listOwnedChildren(parentUserId);
  // Direct match by users.id
  const numeric = Number(rawChildId);
  if (Number.isFinite(numeric)) {
    const hit = owned.find((c) => c.student_user_id === numeric);
    if (hit) return hit;
  }
  // Legacy demo-id translation: "1" -> "TEST001" -> users row, then verify
  // the parent actually owns that student.
  const legacyCode = LEGACY_CHILD_ID_TO_STUDENT_CODE[rawChildId];
  if (legacyCode) {
    const hit = owned.find((c) => c.student_code === legacyCode);
    if (hit) return hit;
  }
  return null;
}

function parentIdOr401(req: Request, res: ExpressResponse): number | null {
  const id = Number(req.auth?.user_id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(401).json({ error: "no parent in token" });
    return null;
  }
  return id;
}

// Demo wallet/activity data, keyed by student_code. Real wallet + activity
// aren't backed by tables yet — we still return these stub numbers, but only
// for children the requesting parent actually owns (verified via parent_children).
type DemoWalletExtras = {
  balance: number;
  today_points: number;
  total_points: number;
  attendance_streak: number;
  daily_limit: number;
  transactions: { id: string; amount: number; type: string; description: string; created_at: string }[];
  activity: { id: string; type: string; description: string; points: number; timestamp: string; subject: string }[];
};
const DEMO_EXTRAS_BY_CODE: Record<string, DemoWalletExtras> = {
  TEST001: {
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
    activity: [
      { id: "1", type: "attendance", description: "Checked in for school", points: 20, timestamp: new Date(Date.now() - 3600000).toISOString(), subject: "School" },
      { id: "2", type: "ai_question", description: "Asked about photosynthesis", points: 10, timestamp: new Date(Date.now() - 7200000).toISOString(), subject: "Biology" },
      { id: "3", type: "quiz", description: "Completed Science Quiz - Score 80%", points: 25, timestamp: new Date(Date.now() - 10800000).toISOString(), subject: "Science" },
      { id: "4", type: "ai_question", description: "Asked about Pythagorean theorem", points: 10, timestamp: new Date(Date.now() - 14400000).toISOString(), subject: "Mathematics" },
      { id: "5", type: "attendance", description: "Checked in for school", points: 20, timestamp: new Date(Date.now() - 86400000).toISOString(), subject: "School" },
    ],
  },
  TEST002: {
    balance: 18500,
    today_points: 45,
    total_points: 1820,
    attendance_streak: 7,
    daily_limit: 3000,
    transactions: [
      { id: "4", amount: 20, type: "attendance", description: "Daily attendance check-in", created_at: new Date(Date.now() - 3600000).toISOString() },
      { id: "5", amount: 10, type: "ai_question", description: "Asked about Tanzania history", created_at: new Date(Date.now() - 7200000).toISOString() },
    ],
    activity: [
      { id: "1", type: "attendance", description: "Checked in for school", points: 20, timestamp: new Date(Date.now() - 3600000).toISOString(), subject: "School" },
      { id: "2", type: "ai_question", description: "Asked about Tanzania history", points: 10, timestamp: new Date(Date.now() - 7200000).toISOString(), subject: "History" },
      { id: "3", type: "quiz", description: "Completed Kiswahili Vocabulary", points: 30, timestamp: new Date(Date.now() - 86400000 + 3600000).toISOString(), subject: "Kiswahili" },
    ],
  },
};
const EMPTY_EXTRAS: DemoWalletExtras = {
  balance: 0,
  today_points: 0,
  total_points: 0,
  attendance_streak: 0,
  daily_limit: 0,
  transactions: [],
  activity: [],
};
const extrasFor = (code: string): DemoWalletExtras =>
  DEMO_EXTRAS_BY_CODE[code] ?? EMPTY_EXTRAS;

router.get("/v1/parent/dashboard", async (req, res) => {
  const parentId = parentIdOr401(req, res);
  if (parentId == null) return;
  const owned = await listOwnedChildren(parentId);
  res.json({
    parent_name: req.auth?.name ?? "Parent",
    children: owned.map((c) => {
      const e = extrasFor(c.student_code);
      return {
        id: String(c.student_user_id),
        name: c.name,
        grade: c.grade ?? "Form 1",
        balance: e.balance,
        today_points: e.today_points,
        total_points: e.total_points,
        attendance_streak: e.attendance_streak,
      };
    }),
  });
});

router.get("/v1/parent/child/:childId/activity", async (req, res) => {
  const parentId = parentIdOr401(req, res);
  if (parentId == null) return;
  const child = await resolveOwnedChild(parentId, String(req.params["childId"]));
  if (!child) {
    res.status(404).json({ error: "Child not found" });
    return;
  }
  res.json({
    child_name: child.name,
    activities: extrasFor(child.student_code).activity,
  });
});

/**
 * GET /v1/parent/child/:childId/documents
 * Documents assigned to the classes this child belongs to.
 * Same join the student watch sees in the print picker, so parents always
 * know exactly what is available for tap-to-print.
 */
router.get("/v1/parent/child/:childId/documents", async (req, res) => {
  const parentId = parentIdOr401(req, res);
  if (parentId == null) return;
  const child = await resolveOwnedChild(parentId, String(req.params["childId"]));
  if (!child) {
    res.status(404).json({ error: "Child not found" });
    return;
  }
  const documents = await listDocumentsForStudent(child.student_code);
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

/**
 * GET /v1/parent/child/:childId/print-history
 * Long-term audit log of every print job a child submitted: document name,
 * page count, printer, status, timestamps. Builds parent trust ("did Aisha
 * actually use her print quota?") and surfaces abuse.
 */
router.get("/v1/parent/child/:childId/print-history", async (req, res) => {
  const parentId = parentIdOr401(req, res);
  if (parentId == null) return;
  const child = await resolveOwnedChild(parentId, String(req.params["childId"]));
  if (!child) {
    res.status(404).json({ error: "Child not found" });
    return;
  }
  const limit = Math.min(100, Math.max(1, Number(req.query["limit"] ?? 50)));
  const rows = await db
    .select()
    .from(printJobsTable)
    .where(eq(printJobsTable.student_code, child.student_code))
    .orderBy(desc(printJobsTable.created_at))
    .limit(limit);
  res.json({
    child_name: child.name,
    jobs: rows.map((r) => ({
      id: r.id,
      job_ref: r.job_ref,
      document_name: r.document_name,
      pages: r.pages,
      printer_id: r.printer_id,
      printer_name: r.printer_name,
      status: r.status,
      status_message: r.status_message,
      created_at: (r.created_at as Date).toISOString(),
      completed_at: r.completed_at ? (r.completed_at as Date).toISOString() : null,
    })),
  });
});

// Watch device settings (audio responses + keyboard input). Parents can flip
// these per child from the app; the watch reads them at login + on demand.
// Defaults are applied here so brand-new students don't 404 — we never insert
// a row until the parent actually changes something.
router.get("/v1/parent/child/:childId/settings", async (req, res) => {
  const parentId = parentIdOr401(req, res);
  if (parentId == null) return;
  const child = await resolveOwnedChild(parentId, String(req.params["childId"]));
  if (!child) return res.status(404).json({ error: "child_not_found" });
  const rows = await db
    .select()
    .from(studentSettingsTable)
    .where(eq(studentSettingsTable.student_code, child.student_code))
    .limit(1);
  const row = rows[0];
  res.json({
    student_code: child.student_code,
    audio_enabled: row?.audio_enabled ?? true,
    keyboard_enabled: row?.keyboard_enabled ?? true,
    ads_enabled: row?.ads_enabled ?? true,
  });
});

router.patch("/v1/parent/child/:childId/settings", async (req, res) => {
  const parentId = parentIdOr401(req, res);
  if (parentId == null) return;
  const child = await resolveOwnedChild(parentId, String(req.params["childId"]));
  if (!child) return res.status(404).json({ error: "child_not_found" });
  const studentCode = child.student_code;
  const body = req.body ?? {};
  const audio = typeof body.audio_enabled === "boolean" ? body.audio_enabled : undefined;
  const keyboard =
    typeof body.keyboard_enabled === "boolean" ? body.keyboard_enabled : undefined;
  const ads = typeof body.ads_enabled === "boolean" ? body.ads_enabled : undefined;
  if (audio === undefined && keyboard === undefined && ads === undefined) {
    return res.status(400).json({ error: "no_changes" });
  }
  // Upsert: insert with the provided values (defaulting the missing one to
  // true since that's also the schema default), or update only the supplied
  // fields on conflict so a partial PATCH doesn't clobber the other toggle.
  await db
    .insert(studentSettingsTable)
    .values({
      student_code: studentCode,
      audio_enabled: audio ?? true,
      keyboard_enabled: keyboard ?? true,
      ads_enabled: ads ?? true,
    })
    .onConflictDoUpdate({
      target: studentSettingsTable.student_code,
      set: {
        ...(audio !== undefined ? { audio_enabled: audio } : {}),
        ...(keyboard !== undefined ? { keyboard_enabled: keyboard } : {}),
        ...(ads !== undefined ? { ads_enabled: ads } : {}),
        updated_at: new Date(),
      },
    });
  const rows = await db
    .select()
    .from(studentSettingsTable)
    .where(eq(studentSettingsTable.student_code, studentCode))
    .limit(1);
  const row = rows[0]!;
  res.json({
    student_code: studentCode,
    audio_enabled: row.audio_enabled,
    keyboard_enabled: row.keyboard_enabled,
    ads_enabled: row.ads_enabled,
  });
});

router.get("/v1/parent/wallet", async (req, res) => {
  const parentId = parentIdOr401(req, res);
  if (parentId == null) return;
  const owned = await listOwnedChildren(parentId);
  const enriched = owned.map((c) => {
    const e = extrasFor(c.student_code);
    return {
      id: String(c.student_user_id),
      name: c.name,
      grade: c.grade ?? "Form 1",
      balance: e.balance,
      daily_limit: e.daily_limit,
      transactions: e.transactions,
    };
  });
  res.json({
    total_balance: enriched.reduce((sum, c) => sum + c.balance, 0),
    children: enriched,
  });
});

/**
 * GET /v1/parent/subscriptions
 * Lists this parent's children with their current subscription status pulled
 * from the local subscription_cache (which was populated by the central sync
 * agent). Always reads from the local cache so the parent app keeps working
 * during a central outage.
 */
router.get("/v1/parent/subscriptions", async (req, res) => {
  const parentId = parentIdOr401(req, res);
  if (parentId == null) return;
  const owned = await listOwnedChildren(parentId);
  const out = await Promise.all(
    owned.map(async (c) => {
      const [sub] = await db
        .select()
        .from(subscriptionCacheTable)
        .where(eq(subscriptionCacheTable.student_code, c.student_code));
      return {
        child_id: String(c.student_user_id),
        child_name: c.name,
        grade: c.grade ?? "Form 1",
        student_code: c.student_code,
        plan: sub?.plan ?? "basic",
        status: sub?.status ?? "uncached",
        monthly_price_tsh: sub?.monthly_price_tsh ?? 5000,
        expires_at: sub?.expires_at?.toISOString() ?? null,
        parent_phone: sub?.parent_phone ?? null,
      };
    }),
  );
  res.json({ subscriptions: out });
});

/**
 * POST /v1/parent/subscriptions/pay
 * { child_id, phone? } — initiates an M-Pesa STK push for this child's
 * monthly subscription. The actual STK is simulated in the central server
 * (see routes/central.ts: /central/v1/payments/initiate). Returns the
 * payment_id which the client can poll until status flips to success/failed.
 */
router.post("/v1/parent/subscriptions/pay", async (req, res) => {
  const parentId = parentIdOr401(req, res);
  if (parentId == null) return;
  const { child_id, phone } = req.body ?? {};
  if (typeof child_id !== "string" && typeof child_id !== "number") {
    res.status(400).json({ error: "child_id required" });
    return;
  }
  const child = await resolveOwnedChild(parentId, String(child_id));
  if (!child) {
    res.status(404).json({ error: "Child not found" });
    return;
  }
  const code = child.student_code;
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

/**
 * GET /v1/parent/notifications
 * Returns nudges for the parent — currently subscriptions expiring within
 * `RENEWAL_REMINDER_DAYS` (default 3 days) so the parent app can show a
 * banner. Reads from the locally-cached subscription rows so it works
 * offline; computes locally to avoid extra central calls.
 */
const RENEWAL_REMINDER_DAYS = 3;
router.get("/v1/parent/notifications", async (req, res) => {
  const parentId = parentIdOr401(req, res);
  if (parentId == null) return;
  const owned = await listOwnedChildren(parentId);
  if (owned.length === 0) {
    res.json({ notifications: [] });
    return;
  }
  const ownedCodes = owned.map((c) => c.student_code);
  const childByCode = new Map(owned.map((c) => [c.student_code, c]));
  const rows = await db
    .select()
    .from(subscriptionCacheTable)
    .where(inArray(subscriptionCacheTable.student_code, ownedCodes));

  const now = Date.now();
  const cutoff = now + RENEWAL_REMINDER_DAYS * 24 * 60 * 60 * 1000;

  const notifications = rows
    .filter((r) => {
      if (!r.expires_at) return false;
      const t = new Date(r.expires_at).getTime();
      return t < cutoff;
    })
    .map((r) => {
      const child = childByCode.get(r.student_code);
      const t = r.expires_at!.getTime();
      const days = Math.ceil((t - now) / (24 * 60 * 60 * 1000));
      const expired = t < now;
      return {
        id: `renew-${r.student_code}`,
        kind: "renewal_due" as const,
        severity: expired ? ("urgent" as const) : days <= 1 ? ("warning" as const) : ("info" as const),
        child_id: child ? String(child.student_user_id) : null,
        child_name: child?.name ?? r.student_name ?? r.student_code,
        student_code: r.student_code,
        plan: r.plan,
        amount_tsh: r.monthly_price_tsh ?? 0,
        days_remaining: days,
        expires_at: r.expires_at!.toISOString(),
        title: expired
          ? `${child?.name ?? r.student_code}'s plan has expired`
          : days <= 0
          ? `${child?.name ?? r.student_code}'s plan expires today`
          : `${child?.name ?? r.student_code}'s plan expires in ${days} day${days === 1 ? "" : "s"}`,
        body: expired
          ? "The watch's premium features are paused. Pay now to reactivate."
          : "Tap Pay now to renew for another 30 days and keep the watch active.",
      };
    })
    .sort((a, b) => a.days_remaining - b.days_remaining);

  res.json({ notifications });
});

router.get("/v1/parent/subscriptions/payment/:id", async (req, res) => {
  // Read from the central source of truth via license-key proxy. In the demo
  // central + school share one DB, but we go through the central API anyway
  // so that (a) this code keeps working when central moves to its own host
  // and (b) we get the central tenant_id scoping for free.
  //
  // Then enforce that the payment belongs to a student this parent owns —
  // prevents enumerating other parents' payment IDs (IDOR).
  const parentId = parentIdOr401(req, res);
  if (parentId == null) return;
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
  const body = (await upstream.json()) as {
    payment?: { student_code?: string } & Record<string, unknown>;
  };
  const owned = await listOwnedChildren(parentId);
  const ownedCodes = new Set(owned.map((c) => c.student_code));
  if (!body.payment || !ownedCodes.has(body.payment.student_code ?? "")) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }
  res.json({ payment: body.payment });
});

router.post("/v1/parent/wallet/add-funds", async (req, res) => {
  const parentId = parentIdOr401(req, res);
  if (parentId == null) return;
  const parsed = AddFundsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { child_id, amount } = parsed.data;
  const child = await resolveOwnedChild(parentId, String(child_id));
  if (!child) {
    res.status(404).json({ error: "Child not found" });
    return;
  }
  const e = extrasFor(child.student_code);
  const newBalance = e.balance + amount;
  res.json({
    success: true,
    new_balance: newBalance,
    message: `Successfully added TSh ${amount.toLocaleString()} to ${child.name}'s wallet`,
    receipt_id: `RCP-${Date.now()}`,
  });
});

export default router;
