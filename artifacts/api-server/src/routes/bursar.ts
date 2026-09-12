import { Router } from "express";
import PDFDocument from "pdfkit";
import { and, eq, inArray } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { parentPhones } from "../lib/fees";
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

  section("If a classroom TV won't connect");
  item("1.", "Confirm the classroom PC is on the school Wi-Fi.");
  item("2.", "Reload the K9 classroom display in the browser (F5), then return to full screen.");
  item("3.", "If still failing, check API server is up (step above).");

  section("If a printer won't print");
  item("1.", "Check the print agent (small box beside the printer) is powered and on Wi-Fi.");
  item("2.", "Check printer power + paper, then resend from Teacher Dashboard → Documents → Print.");
  item("3.", "Agent log: run `journalctl -u kobeai-tap-box -f` on the print agent.");

  section("Daily checklist (5 minutes, every morning)");
  item("✓", "Server LED green; dashboard loads at http://kobeai.local.");
  item("✓", "Date/time on dashboard is correct (UTC drift breaks attendance).");
  item("✓", "At least one print agent online.");
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
 * Body: { student_ids: string[] }   — student_code values, e.g. ["STU0007"]
 *       { amount_tsh: number }
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
  // A phone per student, from `parent_children` → the parent's user row.
  // This used to derive one from the student id, which meant a real STK push
  // at a real stranger's phone every time a bursar pressed "Bulk invoice".
  // A student with no linked parent is reported, never guessed at.
  const wanted = studentIds.map((sid) => String(sid));
  const students = await db
    .select({ id: usersTable.id, name: usersTable.name, student_code: usersTable.student_code })
    .from(usersTable)
    .where(and(eq(usersTable.role, "student"), inArray(usersTable.student_code, wanted)));
  const phones = await parentPhones(students.map((s) => s.id));

  const results = await Promise.all(
    wanted.map(async (idStr) => {
      const student = students.find((s) => s.student_code === idStr);
      if (!student) {
        return { student_id: idStr, ok: false, error: "student not found" };
      }
      const phone = phones.get(student.id)?.[0]?.phone;
      if (!phone) {
        return {
          student_id: idStr,
          ok: false,
          error: "no parent phone linked — send this family a claim code first",
        };
      }
      try {
        const upstream = await fetch(`${base}/api/central/v1/payments/initiate`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-tenant-license-key": key,
          },
          body: JSON.stringify({
            student_code: student.student_code,
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
  });
});

export default router;
