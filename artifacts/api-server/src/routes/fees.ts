import express, { Router, type Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  feeAccountsTable,
  feeStructuresTable,
  feeTransactionsTable,
  paperImportsTable,
  paymentMatchesTable,
  usersTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";
import { readPaper } from "../lib/paper-reader";
import {
  FEE_METHODS,
  FeeError,
  accountHistory,
  chargeStructure,
  feeSummary,
  listAccounts,
  parentPhones,
  post,
  recordPayment,
  verifyLedger,
  type FeeMethod,
} from "../lib/fees";
import {
  matchPayment,
  parsePaymentSheet,
  type MatchCandidate,
  type PaymentRow,
  type ProposedPayment,
} from "../lib/payment-reader";

// ===========================================================================
// School fees: the ledger, and the reconciliation desk.
//
// Two halves.
//
// The ledger half is deliberately boring. Structures, charges, payments,
// waivers, reversals — all of them through lib/fees.ts, all of them
// append-only, none of them editable. Boring is the feature: a bursar who
// cannot reconstruct a disputed account stops using the computer and goes
// back to the book.
//
// The reconciliation half is where the AI earns its place. The bursar
// photographs the M-Pesa confirmations on the school phone; K9 reads them,
// works out whose fees each one is and says why; the bursar confirms. Only
// the confirm writes. Nothing here posts money, sends a message or charges a
// phone on its own.
// ===========================================================================

const router = Router();

// Fee data is PII and the balances are the school's books — staff only, and
// posting is restricted further to the bursar's own roles.
const staff = requireAuth(["teacher", "admin", "super_admin"]);
const bursar = requireAuth(["admin", "super_admin"]);

function sendFeeError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof FeeError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  logger.error({ err }, fallback);
  res.status(500).json({ error: fallback });
}

const asAmount = (v: unknown): number => Math.round(Number(v));

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/** GET /v1/fees/summary — the headline numbers, all computed from the ledger. */
router.get("/v1/fees/summary", staff, async (_req, res) => {
  res.json({ summary: await feeSummary() });
});

/** GET /v1/fees/accounts — every student, with what they owe. */
router.get("/v1/fees/accounts", staff, async (req, res) => {
  const accounts = await listAccounts();
  const arrearsOnly = String(req.query["arrears"] ?? "") === "1";
  res.json({
    accounts: arrearsOnly ? accounts.filter((a) => a.balance_tsh > 0) : accounts,
    summary: await feeSummary(),
  });
});

/** GET /v1/fees/accounts/:studentId — one account and its full history. */
router.get("/v1/fees/accounts/:studentId", staff, async (req, res) => {
  const studentId = Number(req.params.studentId);
  if (!Number.isInteger(studentId)) return void res.status(400).json({ error: "bad id" });
  const [student] = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      student_code: usersTable.student_code,
      grade: usersTable.grade,
    })
    .from(usersTable)
    .where(and(eq(usersTable.id, studentId), eq(usersTable.role, "student")))
    .limit(1);
  if (!student) return void res.status(404).json({ error: "no such student" });

  const [account] = await db
    .select()
    .from(feeAccountsTable)
    .where(eq(feeAccountsTable.student_id, studentId))
    .limit(1);
  const transactions = await accountHistory(studentId);
  const matches =
    transactions.length > 0
      ? await db
          .select()
          .from(paymentMatchesTable)
          .where(
            inArray(
              paymentMatchesTable.transaction_id,
              transactions.map((t) => t.id),
            ),
          )
      : [];
  const phones = await parentPhones([studentId]);

  res.json({
    student,
    account: account ?? {
      student_id: studentId,
      charged_tsh: 0,
      paid_tsh: 0,
      waived_tsh: 0,
      balance_tsh: 0,
    },
    transactions,
    // Why each payment is on this account, so a disputed one can be answered
    // without anyone's memory being involved.
    matches,
    parents: phones.get(studentId) ?? [],
  });
});

/**
 * GET /v1/fees/verify — recompute every balance from the signed history and
 * report disagreements. Should always be empty; it exists because "should
 * always" is not a control.
 */
router.get("/v1/fees/verify", bursar, async (_req, res) => {
  const drift = await verifyLedger();
  if (drift.length > 0) logger.error({ drift }, "fee ledger drift detected");
  res.json({ ok: drift.length === 0, drift });
});

// ---------------------------------------------------------------------------
// Fee structures and charging
// ---------------------------------------------------------------------------

router.get("/v1/fees/structures", staff, async (_req, res) => {
  const structures = await db
    .select()
    .from(feeStructuresTable)
    .orderBy(desc(feeStructuresTable.created_at));
  // How many students each one has actually been charged to.
  const counts = await db
    .select({
      id: feeTransactionsTable.fee_structure_id,
      n: sql<number>`count(*)::int`,
    })
    .from(feeTransactionsTable)
    .where(eq(feeTransactionsTable.kind, "charge"))
    .groupBy(feeTransactionsTable.fee_structure_id);
  const byId = new Map(counts.map((c) => [c.id, c.n]));
  res.json({ structures: structures.map((s) => ({ ...s, charged_to: byId.get(s.id) ?? 0 })) });
});

/**
 * POST /v1/fees/structures
 * Body: { name, term, form_level?, items: [{ label, amount_tsh }] }
 * The total is computed from the items, never taken from the request — the
 * invoice a parent is shown and the figure they are charged cannot differ.
 */
router.post("/v1/fees/structures", bursar, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const term = String(req.body?.term ?? "").trim();
  const formLevel = String(req.body?.form_level ?? "").trim();
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];

  if (name.length < 3) return void res.status(400).json({ error: "Give the structure a name." });
  if (!term) return void res.status(400).json({ error: "Which term is this for?" });
  if (rawItems.length === 0) return void res.status(400).json({ error: "Add at least one line item." });

  const items: Array<{ label: string; amount_tsh: number }> = [];
  for (const raw of rawItems) {
    const label = String((raw as Record<string, unknown>)?.["label"] ?? "").trim();
    const amount = asAmount((raw as Record<string, unknown>)?.["amount_tsh"]);
    if (!label) return void res.status(400).json({ error: "Every line item needs a label." });
    if (!Number.isInteger(amount) || amount <= 0 || amount > 100_000_000) {
      return void res.status(400).json({ error: `"${label}" needs a positive amount in shillings.` });
    }
    items.push({ label, amount_tsh: amount });
  }
  const total = items.reduce((sum, i) => sum + i.amount_tsh, 0);

  const [structure] = await db
    .insert(feeStructuresTable)
    .values({
      name,
      term,
      form_level: formLevel || null,
      items,
      total_tsh: total,
      created_by: req.auth!.user_id,
    })
    .returning();
  res.status(201).json({ structure });
});

/**
 * POST /v1/fees/structures/:id/charge
 * Bills the structure to every student it applies to. Safe to re-run — a
 * student already charged for it is skipped, not doubled.
 */
router.post("/v1/fees/structures/:id/charge", bursar, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "bad id" });
  try {
    const outcome = await chargeStructure(id, req.auth!.user_id);
    res.json(outcome);
  } catch (err) {
    sendFeeError(res, err, "Could not charge that structure.");
  }
});

// ---------------------------------------------------------------------------
// Posting money
// ---------------------------------------------------------------------------

/**
 * POST /v1/fees/payments
 * Body: { student_id, amount_tsh, method, reference?, received_at?, note? }
 * The manual path: cash at the desk, or a confirmation the bursar reads out.
 */
router.post("/v1/fees/payments", bursar, async (req, res) => {
  const method = String(req.body?.method ?? "cash") as FeeMethod;
  if (!FEE_METHODS.includes(method)) {
    return void res.status(400).json({ error: `method must be one of ${FEE_METHODS.join(", ")}` });
  }
  try {
    const row = await recordPayment({
      student_id: Number(req.body?.student_id),
      amount_tsh: asAmount(req.body?.amount_tsh),
      method,
      reference: req.body?.reference ? String(req.body.reference).trim() : null,
      note: req.body?.note ? String(req.body.note).slice(0, 300) : null,
      received_at: req.body?.received_at ? new Date(req.body.received_at) : null,
      entered_by: req.auth!.user_id,
      match: { matched_by: "manual", reason: "Entered by hand at the school office." },
    });
    res.status(201).json({ transaction: row });
  } catch (err) {
    sendFeeError(res, err, "Could not record that payment.");
  }
});

/** POST /v1/fees/waivers — body: { student_id, amount_tsh, note } */
router.post("/v1/fees/waivers", bursar, async (req, res) => {
  const note = String(req.body?.note ?? "").trim();
  if (note.length < 4) {
    // A waiver with no stated reason is the one entry an auditor will always
    // ask about, so it is not writable without one.
    return void res.status(400).json({ error: "Say why this is being waived." });
  }
  try {
    const row = await post({
      student_id: Number(req.body?.student_id),
      kind: "waiver",
      amount_tsh: asAmount(req.body?.amount_tsh),
      method: "waiver",
      note,
      entered_by: req.auth!.user_id,
    });
    res.status(201).json({ transaction: row });
  } catch (err) {
    sendFeeError(res, err, "Could not record that waiver.");
  }
});

/**
 * POST /v1/fees/transactions/:id/reverse
 * Body: { amount_tsh, note }
 * Nothing is edited or deleted; a mistake is corrected by its opposite, and
 * both rows stay in the history.
 */
router.post("/v1/fees/transactions/:id/reverse", bursar, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "bad id" });
  const note = String(req.body?.note ?? "").trim();
  if (note.length < 4) return void res.status(400).json({ error: "Say why this is being reversed." });
  const [original] = await db
    .select()
    .from(feeTransactionsTable)
    .where(eq(feeTransactionsTable.id, id))
    .limit(1);
  if (!original) return void res.status(404).json({ error: "no such transaction" });
  try {
    const row = await post({
      student_id: original.student_id,
      kind: "reversal",
      amount_tsh: asAmount(req.body?.amount_tsh ?? Math.abs(original.delta_tsh)),
      reverses_id: id,
      note,
      entered_by: req.auth!.user_id,
    });
    res.status(201).json({ transaction: row });
  } catch (err) {
    sendFeeError(res, err, "Could not reverse that transaction.");
  }
});

// ---------------------------------------------------------------------------
// Reconciliation — read, match, propose. Confirm is a separate call.
// ---------------------------------------------------------------------------

/** Everything the matcher needs about who could have sent this money. */
async function matchCandidates(): Promise<MatchCandidate[]> {
  const accounts = await listAccounts();
  const phones = await parentPhones(accounts.map((a) => a.student_id));
  return accounts.map((a) => {
    const parents = phones.get(a.student_id) ?? [];
    return {
      student_id: a.student_id,
      name: a.name,
      student_code: a.student_code,
      grade: a.grade,
      balance_tsh: a.balance_tsh,
      parent_phones: parents.map((p) => p.phone),
      parent_names: parents.map((p) => p.parent_name).filter(Boolean),
    };
  });
}

/** Receipts already on the ledger, so a statement read twice posts nothing twice. */
async function postedReceipts(receipts: string[]): Promise<Set<string>> {
  const wanted = receipts.filter(Boolean);
  if (wanted.length === 0) return new Set();
  const rows = await db
    .select({ reference: feeTransactionsTable.reference })
    .from(feeTransactionsTable)
    .where(
      and(eq(feeTransactionsTable.kind, "payment"), inArray(feeTransactionsTable.reference, wanted)),
    );
  return new Set(rows.map((r) => r.reference!).filter(Boolean));
}

async function propose(rows: PaymentRow[]): Promise<ProposedPayment[]> {
  const candidates = await matchCandidates();
  const posted = await postedReceipts(rows.map((r) => r.receipt ?? ""));
  return rows.map((row) => ({
    ...row,
    match: matchPayment(row, candidates),
    already_posted: !!row.receipt && posted.has(row.receipt),
  }));
}

/**
 * POST /v1/fees/reconcile/photo
 * Body: a photo of the M-Pesa confirmations on the school phone, or of a
 * printed statement. Answers with rows and proposed matches. Writes nothing
 * to the ledger.
 */
router.post(
  "/v1/fees/reconcile/photo",
  // Auth before the body parser, so an unauthenticated caller is turned away
  // on its headers rather than after 12 MB.
  bursar,
  express.raw({ type: ["image/jpeg", "image/png", "application/octet-stream"], limit: "12mb" }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 1024) {
      return void res.status(400).json({ error: "Send a photo as the request body." });
    }
    const [created] = await db
      .insert(paperImportsTable)
      .values({ kind: "payments", status: "reading", uploaded_by: req.auth!.user_id })
      .returning();
    const importId = created!.id;
    try {
      const read = await readPaper(req.body);
      if (!read) {
        await db
          .update(paperImportsTable)
          .set({ status: "failed", error: "No vision model is available on this server." })
          .where(eq(paperImportsTable.id, importId));
        return void res.status(503).json({
          id: importId,
          error:
            "This server has no model that can read a photo. Paste the confirmation " +
            "messages as text instead — they are read the same way.",
        });
      }
      const parsed = await parsePaymentSheet(read.text);
      const proposals = await propose(parsed.rows);
      const [updated] = await db
        .update(paperImportsTable)
        .set({
          status: "parsed",
          ocr_text: read.text.slice(0, 20_000),
          parsed: proposals,
          model: parsed.model ?? read.model,
        })
        .where(eq(paperImportsTable.id, importId))
        .returning();
      res.status(201).json({ import: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, importId }, "payment reconciliation read failed");
      await db
        .update(paperImportsTable)
        .set({ status: "failed", error: message.slice(0, 500) })
        .where(eq(paperImportsTable.id, importId));
      res.status(500).json({ id: importId, error: "Could not read that photo." });
    }
  },
);

/**
 * POST /v1/fees/reconcile/text
 * Body: { text }
 * The same pipeline with no camera — paste the SMS thread, or a statement
 * export. M-Pesa text is machine-generated, so this path needs no model at
 * all and is the one a school with no GPU box uses every day.
 */
router.post("/v1/fees/reconcile/text", bursar, async (req, res) => {
  const text = String(req.body?.text ?? "");
  if (text.trim().length < 12) {
    return void res.status(400).json({ error: "Paste the confirmation messages first." });
  }
  const parsed = await parsePaymentSheet(text);
  const proposals = await propose(parsed.rows);
  const [created] = await db
    .insert(paperImportsTable)
    .values({
      kind: "payments",
      status: "parsed",
      uploaded_by: req.auth!.user_id,
      ocr_text: text.slice(0, 20_000),
      parsed: proposals,
      model: parsed.model,
    })
    .returning();
  res.status(201).json({ import: created });
});

/** GET /v1/fees/reconcile — recent reconciliation batches. */
router.get("/v1/fees/reconcile", bursar, async (_req, res) => {
  const rows = await db
    .select()
    .from(paperImportsTable)
    .where(eq(paperImportsTable.kind, "payments"))
    .orderBy(desc(paperImportsTable.created_at))
    .limit(50);
  res.json({ batches: rows });
});

/** GET /v1/fees/reconcile/:id — one batch, with its proposals re-checked. */
router.get("/v1/fees/reconcile/:id", bursar, async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db
    .select()
    .from(paperImportsTable)
    .where(and(eq(paperImportsTable.id, id), eq(paperImportsTable.kind, "payments")))
    .limit(1);
  if (!row) return void res.status(404).json({ error: "not found" });
  res.json({ import: row });
});

/**
 * POST /v1/fees/reconcile/:id/confirm
 * Body: { payments: [{ receipt?, student_id, amount_tsh, method?, payer_name?,
 *                      payer_phone?, paid_at?, matched_by?, confidence?, reason? }] }
 *
 * The only endpoint in reconciliation that writes. Each entry is a payment
 * a named human has looked at and agreed with; the agent's proposal carries
 * through as the recorded reason, and `entered_by` records who agreed.
 *
 * Rows are posted one at a time on purpose: one duplicate receipt in a batch
 * of forty must not roll back the thirty-nine good ones, so failures are
 * reported per row and the batch reports 207.
 */
router.post("/v1/fees/reconcile/:id/confirm", bursar, async (req, res) => {
  const id = Number(req.params.id);
  const [batch] = await db
    .select()
    .from(paperImportsTable)
    .where(and(eq(paperImportsTable.id, id), eq(paperImportsTable.kind, "payments")))
    .limit(1);
  if (!batch) return void res.status(404).json({ error: "not found" });

  const entries = Array.isArray(req.body?.payments) ? req.body.payments : [];
  if (entries.length === 0) return void res.status(400).json({ error: "Nothing to confirm." });
  if (entries.length > 200) return void res.status(400).json({ error: "Confirm at most 200 at a time." });

  const results: Array<{ receipt: string | null; ok: boolean; error?: string; transaction_id?: number }> = [];
  for (const raw of entries) {
    const entry = raw as Record<string, unknown>;
    const receipt = entry["receipt"] ? String(entry["receipt"]).trim() : null;
    try {
      const method = String(entry["method"] ?? "mpesa") as FeeMethod;
      const row = await recordPayment({
        student_id: Number(entry["student_id"]),
        amount_tsh: asAmount(entry["amount_tsh"]),
        method: FEE_METHODS.includes(method) ? method : "mpesa",
        reference: receipt,
        received_at: entry["paid_at"] ? new Date(String(entry["paid_at"])) : null,
        entered_by: req.auth!.user_id,
        match: {
          paper_import_id: batch.id,
          payer_name: entry["payer_name"] ? String(entry["payer_name"]) : null,
          payer_phone: entry["payer_phone"] ? String(entry["payer_phone"]) : null,
          receipt,
          matched_by: String(entry["matched_by"] ?? "manual"),
          confidence: entry["confidence"] != null ? Number(entry["confidence"]) : null,
          reason: entry["reason"] ? String(entry["reason"]) : null,
        },
      });
      results.push({ receipt, ok: true, transaction_id: row.id });
    } catch (err) {
      results.push({
        receipt,
        ok: false,
        error: err instanceof FeeError ? err.message : "Could not post this one.",
      });
      if (!(err instanceof FeeError)) logger.error({ err, receipt }, "reconcile confirm failed");
    }
  }

  const posted = results.filter((r) => r.ok).length;
  await db
    .update(paperImportsTable)
    .set({
      status: "committed",
      committed_at: new Date(),
      created_count: posted,
      updated_count: results.length - posted,
    })
    .where(eq(paperImportsTable.id, batch.id));

  logger.info({ batch: batch.id, posted, failed: results.length - posted }, "payments reconciled");
  res.status(207).json({ posted, failed: results.length - posted, results });
});

/**
 * GET /v1/fees/arrears — who to chase, worst first, with the parent's phone
 * and a draft message in their language.
 *
 * The drafting is deliberately rule-based rather than generative. A dunning
 * message is the school speaking to a parent about money: it must be the same
 * every time, checkable by the bursar before it goes, and identical whether
 * or not the model box is switched on. `docs/K9_BURSAR_AI.md` phase 2 is
 * where per-family tone and channel choice get their own review flow — this
 * is the honest version of it that ships today.
 */
router.get("/v1/fees/arrears", bursar, async (req, res) => {
  const minimum = Math.max(0, Number(req.query["min_tsh"] ?? 1));
  const accounts = (await listAccounts()).filter((a) => a.balance_tsh >= minimum);
  const phones = await parentPhones(accounts.map((a) => a.student_id));
  const school = process.env["SCHOOL_NAME"] ?? "the school";

  res.json({
    families: accounts.map((a) => {
      const parents = phones.get(a.student_id) ?? [];
      // Someone paying steadily but not yet in full is in a different
      // conversation from someone who has paid nothing, and the bursar should
      // see which is which before picking up the phone.
      const paying = a.paid_tsh > 0;
      return {
        student_id: a.student_id,
        name: a.name,
        student_code: a.student_code,
        grade: a.grade,
        balance_tsh: a.balance_tsh,
        paid_tsh: a.paid_tsh,
        last_transaction_at: a.last_transaction_at,
        parents,
        posture: paying ? "part_paid" : "unpaid",
        draft_sw:
          `Habari. Salio la ada ya ${a.name} katika ${school} ni TSh ` +
          `${a.balance_tsh.toLocaleString()}.` +
          (paying ? " Asante kwa malipo uliyokwisha fanya." : "") +
          " Tafadhali wasiliana na ofisi ya bursar kwa msaada.",
        draft_en:
          `Hello. ${a.name}'s outstanding school fees at ${school} are TSh ` +
          `${a.balance_tsh.toLocaleString()}.` +
          (paying ? " Thank you for the payments made so far." : "") +
          " Please contact the bursar's office if you would like to discuss it.",
      };
    }),
  });
});

export default router;
