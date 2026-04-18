import { Router } from "express";
import { AddDepositBody } from "@workspace/api-zod";
import PDFDocument from "pdfkit";
import { eq, sql } from "drizzle-orm";
import { db, usersTable, studentKpTable, kpLedgerTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";

const router = Router();

const SCHOOL_NAME = process.env["SCHOOL_NAME"] ?? "Demo Secondary School";

/**
 * GET /v1/bursar/subscription-payments
 * Lists subscription M-Pesa collections for THIS school. Reads from the
 * central server using the school's tenant license key.
 *
 * The bursar uses this to reconcile incoming parent payments and to see
 * which subscriptions just renewed.
 *
 * AUTH: locked down to teacher/admin staff only — payment rows contain
 * parent phone numbers and M-Pesa receipts (PII). The other bursar demo
 * endpoints below are intentionally left unauthed for the demo, but the
 * payments feed is real PII so it gets explicit auth.
 */
router.get("/v1/bursar/subscription-payments", requireAuth(["admin", "teacher", "super_admin"]), async (_req, res) => {
  const base = process.env["CENTRAL_BASE_URL"] ?? "";
  const key = process.env["TENANT_LICENSE_KEY"] ?? "";
  if (!base || !key) {
    res.json({ payments: [], summary: { total_count: 0, success_count: 0, pending_count: 0, failed_count: 0, collected_tsh: 0 } });
    return;
  }
  try {
    const upstream = await fetch(`${base}/api/central/v1/payments?limit=50`, {
      headers: { "x-tenant-license-key": key },
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) {
      res.status(502).json({ error: `Central returned ${upstream.status}` });
      return;
    }
    const body = await upstream.json();
    res.json(body);
  } catch (err) {
    logger.warn({ err }, "bursar subscription-payments fetch failed");
    res.status(502).json({ error: "Central unreachable" });
  }
});

/**
 * GET /v1/bursar/subscription-payments/:id/receipt.pdf
 * Streams a printable PDF receipt for a successful M-Pesa payment so the
 * bursar can give a copy to the parent or file it for accounting. Pulls
 * the canonical row from central (license-key authed) and renders with
 * pdfkit. Only `success` payments get a receipt — pending/failed return 404
 * with a clear message so the bursar UI can handle that gracefully.
 */
router.get("/v1/bursar/subscription-payments/:id/receipt.pdf", requireAuth(["admin", "teacher", "super_admin"]), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid payment id" });
    return;
  }
  const base = process.env["CENTRAL_BASE_URL"] ?? "";
  const key = process.env["TENANT_LICENSE_KEY"] ?? "";
  if (!base || !key) {
    res.status(503).json({ error: "Central server not configured" });
    return;
  }
  let payment: {
    id: number;
    student_code: string;
    student_name: string;
    plan: string;
    amount_tsh: number;
    phone: string;
    status: string;
    mpesa_receipt: string | null;
    initiated_at: string;
    completed_at: string | null;
  };
  try {
    const upstream = await fetch(`${base}/api/central/v1/payments/${id}`, {
      headers: { "x-tenant-license-key": key },
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Central returned ${upstream.status}` });
      return;
    }
    const body = (await upstream.json()) as { payment: typeof payment };
    payment = body.payment;
  } catch (err) {
    logger.warn({ err, id }, "receipt: central unreachable");
    res.status(502).json({ error: "Central unreachable" });
    return;
  }
  if (payment.status !== "success") {
    res.status(404).json({ error: `No receipt: payment is ${payment.status}` });
    return;
  }

  res.setHeader("content-type", "application/pdf");
  res.setHeader("content-disposition", `attachment; filename="receipt-${payment.mpesa_receipt ?? payment.id}.pdf"`);

  const doc = new PDFDocument({ size: "A5", margin: 36 });
  doc.pipe(res);

  // Header strip — green brand bar
  doc.rect(0, 0, doc.page.width, 60).fill("#00A86B");
  doc.fillColor("#FFFFFF").fontSize(18).font("Helvetica-Bold").text(SCHOOL_NAME, 36, 18);
  doc.fontSize(10).font("Helvetica").text("Subscription payment receipt", 36, 40);
  doc.fillColor("#1A1A2E");

  doc.moveDown(3);
  doc.fontSize(11).font("Helvetica").fillColor("#666666").text("Receipt no.");
  doc.fontSize(14).font("Helvetica-Bold").fillColor("#1A1A2E").text(payment.mpesa_receipt ?? "—");
  doc.moveDown(0.8);

  const completed = payment.completed_at ? new Date(payment.completed_at) : new Date(payment.initiated_at);
  const rows: Array<[string, string]> = [
    ["Date", completed.toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" })],
    ["Student", `${payment.student_name} (${payment.student_code})`],
    ["Plan", payment.plan.charAt(0).toUpperCase() + payment.plan.slice(1)],
    ["Paid by", payment.phone],
    ["Method", "M-Pesa STK push"],
  ];
  doc.fontSize(10);
  for (const [label, value] of rows) {
    const y = doc.y;
    doc.fillColor("#666666").font("Helvetica").text(label, 36, y, { width: 100 });
    doc.fillColor("#1A1A2E").font("Helvetica-Bold").text(value, 140, y, { width: doc.page.width - 176 });
    doc.moveDown(0.5);
  }

  doc.moveDown(0.5);
  doc.moveTo(36, doc.y).lineTo(doc.page.width - 36, doc.y).strokeColor("#E5E7EB").stroke();
  doc.moveDown(0.5);
  const totalY = doc.y;
  doc.fontSize(12).fillColor("#666666").font("Helvetica").text("Amount paid", 36, totalY);
  doc
    .fontSize(20)
    .fillColor("#00A86B")
    .font("Helvetica-Bold")
    .text(`TSh ${payment.amount_tsh.toLocaleString()}`, 36, totalY, { align: "right" });

  doc.moveDown(2);
  doc
    .fontSize(9)
    .fillColor("#666666")
    .font("Helvetica-Oblique")
    .text(
      "This payment renews the student's subscription for 30 days from the payment date. Keep this receipt for your records.",
      { align: "left" },
    );
  doc.moveDown(2);
  doc.fontSize(8).fillColor("#999999").text("Powered by KobeAI", { align: "center" });

  doc.end();
});

const AI_QUESTION_COST = 50;
const QUIZ_COST = 100;

type StudentSpend = {
  id: string;
  student_id: string;
  name: string;
  grade: string;
  total_deposited: number;
  questions_count: number;
  quizzes_count: number;
  status: string;
};

const STUDENTS: StudentSpend[] = [
  { id: "1", student_id: "DSS001", name: "Amina Hassan", grade: "Form 1", total_deposited: 80000, questions_count: 412, quizzes_count: 73, status: "healthy" },
  { id: "2", student_id: "DSS002", name: "Brian Mwenda", grade: "Form 2", total_deposited: 25000, questions_count: 358, quizzes_count: 53, status: "low" },
  { id: "3", student_id: "DSS003", name: "Fatuma Ali", grade: "Form 1", total_deposited: 60000, questions_count: 264, quizzes_count: 86, status: "healthy" },
  { id: "4", student_id: "DSS004", name: "James Oloo", grade: "Form 3", total_deposited: 15000, questions_count: 161, quizzes_count: 24, status: "medium" },
  { id: "5", student_id: "DSS005", name: "Neema Kibwe", grade: "Form 2", total_deposited: 95000, questions_count: 380, quizzes_count: 90, status: "healthy" },
  { id: "6", student_id: "DSS006", name: "Omar Suleiman", grade: "Form 4", total_deposited: 10000, questions_count: 124, quizzes_count: 30, status: "low" },
  { id: "7", student_id: "DSS007", name: "Pendo Makame", grade: "Form 1", total_deposited: 45000, questions_count: 248, quizzes_count: 35, status: "medium" },
  { id: "8", student_id: "DSS008", name: "Rashidi Juma", grade: "Form 3", total_deposited: 30000, questions_count: 230, quizzes_count: 65, status: "medium" },
];

function buildBalances() {
  return STUDENTS.map((s) => {
    const ai_questions_spend = s.questions_count * AI_QUESTION_COST;
    const quiz_spend = s.quizzes_count * QUIZ_COST;
    const total_spent = ai_questions_spend + quiz_spend;
    const balance = s.total_deposited - total_spent;
    return {
      id: s.id,
      student_id: s.student_id,
      name: s.name,
      grade: s.grade,
      balance,
      total_deposited: s.total_deposited,
      total_spent,
      ai_questions_spend,
      quiz_spend,
      questions_count: s.questions_count,
      quizzes_count: s.quizzes_count,
      status: s.status,
    };
  });
}

router.get("/v1/bursar/students/balances", (_req, res) => {
  const students = buildBalances();
  res.json({
    students,
    summary: {
      total_accounts: 1247,
      total_balance: 45892000,
      low_balance_count: 23,
    },
  });
});

/**
 * POST /v1/bursar/deposit
 * Bursar manually credits a student account (cash/M-Pesa STK confirmation that
 * landed outside the standard flow). When the student exists in our DB we
 * credit the real `student_kp` ledger so the watch wallet, leaderboard, and
 * KP totals all reflect the deposit. Falls back to mock balance display only
 * when the student_id can't be matched (legacy demo IDs).
 *
 * Conversion: TSh amount is credited as KP at 1:1 for now (matches what
 * subscription-grants do). Real prod swaps in a school-specific FX rate.
 */
router.post("/v1/bursar/deposit", requireAuth(["admin", "teacher", "super_admin"]), async (req, res) => {
  const parsed = AddDepositBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { student_id, amount } = parsed.data;
  const reviewer = Number(req.auth?.user_id) || null;
  const [student] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.student_code, student_id));
  let newBalance: number;
  if (student && student.role === "student") {
    // Real credit — atomic SQL increment so concurrent deposits to the same
    // student can never lost-update each other. The upsert handles the
    // first-deposit case (no row yet) without a TOCTOU read. We derive
    // balance_after from the COMMITTED row returned by the upsert and
    // insert the ledger entry inside the same transaction so the audit
    // row and the wallet snapshot always agree.
    newBalance = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(studentKpTable)
        .values({ user_id: student.id, balance: amount })
        .onConflictDoUpdate({
          target: studentKpTable.user_id,
          set: {
            balance: sql`${studentKpTable.balance} + ${amount}`,
            updated_at: new Date(),
          },
        })
        .returning({ balance: studentKpTable.balance });
      const next = row!.balance;
      await tx.insert(kpLedgerTable).values({
        user_id: student.id,
        delta: amount,
        reason: "admin_adjust",
        balance_after: next,
      });
      return next;
    });
    logger.info({ student_id, amount, by: reviewer }, "bursar deposit credited");
  } else {
    // Legacy / unknown student — display only.
    const students = buildBalances();
    const mock = students.find((b) => b.student_id === student_id);
    newBalance = (mock?.balance ?? 0) + amount;
  }
  res.json({
    success: true,
    deposit_id: `dep_${Date.now()}`,
    receipt_number: `RCP-${new Date().toISOString().split("T")[0].replace(/-/g, "")}-${Math.floor(Math.random() * 999).toString().padStart(3, "0")}`,
    new_balance: newBalance,
    message: `Successfully deposited TSh ${amount.toLocaleString()}`,
  });
});

/**
 * GET /v1/admin/cheat-sheet.pdf
 * Single-page PDF that school IT can print and pin near the on-prem server
 * rack. Covers daily ops: how to reset PINs, restart the AI box, where to
 * find logs, and who to call. No PII, so unauthenticated by design — the
 * cheat sheet is meant to be physically pinned, not gated behind a login.
 */
router.get("/v1/admin/cheat-sheet.pdf", (_req, res) => {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="kobeai-cheat-sheet.pdf"`);
  doc.pipe(res);

  doc.fillColor("#00A86B").fontSize(24).font("Helvetica-Bold")
    .text("KobeAI", { continued: true })
    .fillColor("#1A1A2E").text("  School IT Cheat Sheet");
  doc.moveDown(0.3);
  doc.fillColor("#555").fontSize(10).font("Helvetica")
    .text(`School: ${SCHOOL_NAME}    •    Pin near the server rack    •    v1`);
  doc.moveDown(1);

  const section = (title: string) => {
    doc.fillColor("#00A86B").fontSize(13).font("Helvetica-Bold").text(title);
    doc.fillColor("#222").fontSize(10).font("Helvetica");
    doc.moveDown(0.2);
  };
  const item = (label: string, body: string) => {
    doc.font("Helvetica-Bold").text(label, { continued: true })
      .font("Helvetica").text(`  ${body}`);
    doc.moveDown(0.3);
  };

  section("If the server is down");
  item("1.", "Check the green LED on the on-prem box. If off, press the power button once.");
  item("2.", "Wait 90 seconds for the AI service (Ollama) to warm up.");
  item("3.", "From any laptop on the school Wi-Fi, open http://kobeai.local — you should see the dashboard.");
  item("4.", "If still down, run `sudo systemctl restart kobeai` from the server console.");

  section("If a student forgets their PIN");
  item("Teacher Dashboard →", "Students → search by name → Reset PIN.");
  item("New PIN", "is shown once on screen. Write it down or have the student set their own.");

  section("If a parent's M-Pesa payment didn't credit");
  item("1.", "Open Bursar page → Subscription Payments. Search by phone or M-Pesa receipt.");
  item("2.", "If status = 'pending' for >5 min, hit Verify (super-admin) or wait for callback.");
  item("3.", "Manual deposit: Bursar → Add Deposit → enter Student ID + amount.");

  section("If the watch won't connect");
  item("1.", "Confirm watch is on the school Wi-Fi (Settings → Wi-Fi).");
  item("2.", "On the watch: Sign out → Sign in. Use student ID + PIN.");
  item("3.", "If still failing, check API server is up (step above).");

  section("If a printer won't print (NFC tap)");
  item("1.", "Hold watch flat against the NFC label on the printer for 2 seconds.");
  item("2.", "Wait for printer beep. If no beep, check printer power + paper.");
  item("3.", "Print job log: Teacher Dashboard → Documents → Print history.");

  section("Daily checklist (5 minutes, every morning)");
  item("✓", "Server LED green; dashboard loads at http://kobeai.local.");
  item("✓", "Date/time on dashboard is correct (UTC drift breaks attendance).");
  item("✓", "At least one printer paired and online.");
  item("✓", "Backup ran overnight — Settings → Backups → last status = OK.");

  section("Who to call");
  item("Tier 1 (school IT)", "you. Try the steps above first.");
  item("Tier 2 (KobeAI support)", "support@kobeai.tz · WhatsApp +255 700 000 000.");
  item("After hours", "post in #kobeai-schools Slack channel — reply within 1 hour.");

  doc.moveDown(1);
  doc.fontSize(8).fillColor("#888").font("Helvetica-Oblique")
    .text("This sheet is generated live from your KobeAI server. Re-print after every major upgrade.", { align: "center" });
  doc.end();
});

/**
 * POST /v1/bursar/invoices/bulk
 * Sends an STK push to multiple parents in one click. The bursar selects
 * a list of student_ids + an amount; we proxy each one through the central
 * server's /central/v1/payments/initiate endpoint (using the school's
 * tenant license key) so the resulting subscription_payments rows live in
 * central where the rest of the billing flow expects them.
 *
 * AUTH: teacher/admin only (real PII — initiates a charge on a parent's
 * phone). Rate limit is implicit — central enforces idempotency by
 * checkout_request_id.
 *
 * Body: { student_ids: string[], amount_tsh: number }
 * Response: { successes, failures, results: [{ student_id, ok, payment_id?, error? }] }
 */
router.post("/v1/bursar/invoices/bulk", requireAuth(["admin", "teacher", "super_admin"]), async (req, res) => {
  const studentIds: unknown[] = Array.isArray(req.body?.student_ids) ? req.body.student_ids : [];
  const amount = Number(req.body?.amount_tsh);
  if (studentIds.length === 0) {
    res.status(400).json({ error: "student_ids must be a non-empty array" });
    return;
  }
  if (studentIds.length > 100) {
    res.status(400).json({ error: "max 100 invoices per batch" });
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "amount_tsh must be a positive number" });
    return;
  }
  const base = process.env["CENTRAL_BASE_URL"] ?? "";
  const key = process.env["TENANT_LICENSE_KEY"] ?? "";
  if (!base || !key) {
    res.status(503).json({ error: "central server not configured" });
    return;
  }
  // We need a phone per student. The local mock STUDENTS list doesn't carry
  // phone numbers, so we fall back to a deterministic demo phone derived from
  // the student_id. Real prod swaps this for a JOIN against the parents
  // table. Documented loudly in the response so a real bursar wouldn't ship
  // this against live numbers without wiring a real phone source.
  const balances = buildBalances();
  const results = await Promise.all(
    studentIds.map(async (sid) => {
      const idStr = String(sid);
      const student = balances.find((b) => b.student_id === idStr || b.id === idStr);
      if (!student) {
        return { student_id: idStr, ok: false, error: "student not found" };
      }
      // Demo-only phone derivation. Replace with parents.phone JOIN in prod.
      const phone = `2557${String(student.id).padStart(8, "0").slice(-8)}`;
      try {
        const upstream = await fetch(`${base}/api/central/v1/payments/initiate`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-tenant-license-key": key,
          },
          body: JSON.stringify({
            student_code: student.student_id,
            phone,
            amount_tsh: amount,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!upstream.ok) {
          const text = await upstream.text().catch(() => "");
          return { student_id: idStr, ok: false, error: `central ${upstream.status}: ${text.slice(0, 120)}` };
        }
        const body = (await upstream.json()) as { payment_id?: number };
        return { student_id: idStr, ok: true, payment_id: body.payment_id, phone };
      } catch (err) {
        logger.warn({ err, student_id: idStr }, "bulk invoice initiate failed");
        return { student_id: idStr, ok: false, error: "central unreachable" };
      }
    }),
  );
  const successes = results.filter((r) => r.ok).length;
  res.status(207).json({
    successes,
    failures: results.length - successes,
    results,
    note: "Demo: parent phone numbers were derived from student_id. Wire a real parent phone source before production use.",
  });
});

router.get("/v1/bursar/billing/summary", (_req, res) => {
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  res.json({
    period,
    total_ai_questions: 3421,
    total_quizzes: 156,
    ai_cost: 171050,
    quiz_cost: 15600,
    subscription_fee: 6235000,
    total_amount: 6421650,
    status: "pending",
  });
});

export default router;
