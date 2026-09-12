import { brainJson } from "./kobe-brain";
import { logger } from "./logger";
import { titleCase } from "./paper-reader";

// ===========================================================================
// Reading M-Pesa confirmations, and working out whose fees they are.
//
// What happens in a school office today: confirmations arrive as SMS on the
// school phone. Somebody reads them off the screen and copies the name, the
// amount and the receipt into a ledger book. Names arrive mangled — the
// parent's name, not the child's; a first name and a clan name in either
// order; a nickname. Amounts arrive short, or in three instalments across a
// fortnight. Matching them to students is a skilled, tedious, error-prone
// afternoon.
//
// This module does the reading and the guessing. It does NOT do the posting:
// everything here produces a *proposal* with a stated reason, and a named
// human confirms it before `lib/fees.ts` writes anything. A reconciliation
// agent that silently attaches a stranger's money to a child's account is
// worse than the ledger book it replaced.
//
// The regex path is the primary one, not the fallback. M-Pesa confirmation
// text is machine-generated and highly regular — far more so than a
// handwritten class list — so the deterministic reader handles the common
// case and the model is there for the statement layouts it does not know.
// ===========================================================================

export type PaymentRow = {
  receipt: string | null;
  payer_name: string | null;
  payer_phone: string | null;
  amount_tsh: number;
  paid_at: string | null; // ISO date when we could read one
  /** How clearly this row was read, 0-100. */
  confidence: number;
  raw: string;
};

export type MatchCandidate = {
  student_id: number;
  name: string;
  student_code: string | null;
  grade: string | null;
  balance_tsh: number;
  parent_phones: string[];
  parent_names: string[];
};

export type Match = {
  student_id: number;
  student_name: string;
  matched_by: "phone" | "name" | "name+amount" | "manual";
  confidence: number;
  reason: string;
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** "1,250,000.00" / "1250000" / "120,000" → 1250000 (whole shillings). */
function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  // M-Pesa prints two decimal places; school fees are whole shillings.
  return Math.round(n);
}

/** Tanzanian mobile numbers, however the sender wrote them, as 255XXXXXXXXX. */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 9) return null;
  if (digits.startsWith("255") && digits.length === 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return `255${digits.slice(1)}`;
  if (digits.length === 9) return `255${digits}`;
  // A longer string with a Tanzanian number at the end (e.g. "+255 712…").
  const tail = digits.slice(-9);
  return tail.length === 9 ? `255${tail}` : null;
}

const AMOUNT = String.raw`(?:TSh|TZS|Tsh|KSh)\s*([\d,]+(?:\.\d{1,2})?)`;
// M-Pesa receipts are 10 uppercase alphanumerics; older ones are 8-12.
const RECEIPT = String.raw`\b([A-Z0-9]{8,12})\b`;
const NAME = String.raw`([A-Z][A-Za-z'’\-]+(?:\s+[A-Z][A-Za-z'’\-]+){1,4})`;

/**
 * Read one confirmation line. Handles the shapes a Tanzanian school phone
 * actually receives:
 *
 *   QGH4K2LM9X Confirmed. You have received TSh 120,000.00 from
 *   ASHA JUMA MWANGI 255712345678 on 3/2/26 at 10:31 AM
 *
 *   TSh 60,000.00 received from JUMA HAMISI 0712345678. Ref QK7T2M4P1A
 *
 * and the tabular form a printed statement flattens to, where the fields are
 * in whatever order the bank's export felt like.
 */
export function parsePaymentLine(line: string): PaymentRow | null {
  const text = line.replace(/\s+/g, " ").trim();
  if (text.length < 12) return null;

  const amountMatch = new RegExp(AMOUNT).exec(text);
  if (!amountMatch) return null;
  const amount = parseAmount(amountMatch[1]!);
  if (amount == null) return null;

  // Ignore the running balance M-Pesa appends — it is not a payment.
  const beforeBalance = text.split(/new\s+m-?pesa\s+balance/i)[0] ?? text;

  const phone = normalisePhone(
    (/(?:\+?255|0)\s?7\d{2}[\s-]?\d{3}[\s-]?\d{3}/.exec(beforeBalance) ?? [])[0] ?? null,
  );

  // The receipt is the uppercase code, but the amount and phone are digits
  // too — exclude anything we have already claimed.
  let receipt: string | null = null;
  for (const m of beforeBalance.matchAll(new RegExp(RECEIPT, "g"))) {
    const token = m[1]!;
    if (/^\d+$/.test(token)) continue; // pure digits: a phone or an amount
    if (!/[A-Z]/.test(token)) continue;
    if (phone && token.includes(phone.slice(-6))) continue;
    receipt = token;
    break;
  }

  // The payer is the capitalised run after "from", or the longest one on the
  // line when the layout has no preposition.
  let payer: string | null = null;
  const fromMatch = new RegExp(String.raw`from\s+${NAME}`, "i").exec(beforeBalance);
  if (fromMatch) {
    payer = fromMatch[1]!;
  } else {
    const names = [...beforeBalance.matchAll(new RegExp(NAME, "g"))]
      .map((m) => m[1]!)
      .filter((n) => !/^(Confirmed|Received|Payment|Balance|New|Transaction|Ref|Date)\b/i.test(n))
      .sort((a, b) => b.length - a.length);
    payer = names[0] ?? null;
  }

  const dateMatch = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/.exec(beforeBalance);
  let paidAt: string | null = null;
  if (dateMatch) {
    const [, d, m, y] = dateMatch;
    const year = Number(y) < 100 ? 2000 + Number(y) : Number(y);
    const parsed = new Date(Date.UTC(year, Number(m) - 1, Number(d)));
    if (!Number.isNaN(parsed.getTime())) paidAt = parsed.toISOString();
  }

  // Confidence reflects how much of the row we actually pinned down: a line
  // with a receipt, a phone and a name is worth far more to a bursar than one
  // with an amount and a smudge.
  let confidence = 40;
  if (receipt) confidence += 25;
  if (phone) confidence += 20;
  if (payer) confidence += 15;

  return {
    receipt,
    payer_name: payer ? titleCase(payer) : null,
    payer_phone: phone,
    amount_tsh: amount,
    paid_at: paidAt,
    confidence: Math.min(100, confidence),
    raw: text,
  };
}

/** Every confirmation in a block of text, deduped on receipt. */
export function parsePaymentLines(text: string): PaymentRow[] {
  const rows: PaymentRow[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const row = parsePaymentLine(line);
    if (!row) continue;
    const key = row.receipt ?? `${row.payer_phone ?? row.payer_name}|${row.amount_tsh}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

const READER_SYSTEM =
  "You extract mobile-money payment records from Tanzanian M-Pesa confirmations " +
  "and bank statements into JSON. You never invent a payment and never change an " +
  "amount. Output JSON only.";

/**
 * Read a statement the regex could not. Runs only when the deterministic
 * reader found less than the model might, and its output is unioned with the
 * regex rows rather than replacing them — a payment the regex found for
 * certain must not disappear because a model reformatted the page.
 */
export async function parsePaymentSheet(
  text: string,
): Promise<{ rows: PaymentRow[]; model: string | null }> {
  const baseline = parsePaymentLines(text);

  const out = await brainJson<{ payments?: unknown[] }>(
    `Extract every mobile-money payment from this statement.\n\n` +
      `Return {"payments":[{"receipt":"…"|null,"payer_name":"…"|null,` +
      `"payer_phone":"…"|null,"amount_tsh":0,"paid_at":"YYYY-MM-DD"|null,` +
      `"confidence":0-100}]}\n\n` +
      `Rules:\n` +
      `- One entry per payment RECEIVED. Ignore withdrawals, charges, balances and reversals.\n` +
      `- amount_tsh is a whole number of shillings, no separators, no decimals.\n` +
      `- Never invent a receipt or a phone number. null is a valid answer.\n` +
      `- confidence is how clearly that line was legible.\n\n` +
      `STATEMENT:\n${text.slice(0, 8000)}`,
    { tag: "payment-reader:sheet", system: READER_SYSTEM, maxTokens: 3000, temperature: 0.1 },
  );

  const modelRows = sanitisePayments(out?.value?.payments);
  if (modelRows.length === 0) return { rows: baseline, model: null };

  // Union on receipt, preferring the regex row where both found the same
  // payment — the deterministic read of a machine-generated string beats a
  // model's transcription of it every time.
  const merged = [...baseline];
  const seen = new Set(baseline.map((r) => r.receipt ?? `${r.payer_phone}|${r.amount_tsh}`));
  for (const row of modelRows) {
    const key = row.receipt ?? `${row.payer_phone}|${row.amount_tsh}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  if (merged.length > baseline.length) {
    logger.info(
      { regex: baseline.length, model: modelRows.length, merged: merged.length },
      "payment-reader: model found rows the line reader missed",
    );
  }
  return { rows: merged, model: out!.model };
}

function sanitisePayments(raw: unknown): PaymentRow[] {
  if (!Array.isArray(raw)) return [];
  const out: PaymentRow[] = [];
  for (const entry of raw) {
    const r = entry as Record<string, unknown>;
    const amount = parseAmount(String(r?.["amount_tsh"] ?? ""));
    if (amount == null) continue;
    const receiptRaw = String(r?.["receipt"] ?? "").trim().toUpperCase();
    const receipt = /^[A-Z0-9]{6,16}$/.test(receiptRaw) ? receiptRaw : null;
    const name = String(r?.["payer_name"] ?? "").trim();
    const paidAtRaw = String(r?.["paid_at"] ?? "").trim();
    const paidAt = /^\d{4}-\d{2}-\d{2}/.test(paidAtRaw) ? new Date(paidAtRaw).toISOString() : null;
    const confidence = Number(r?.["confidence"]);
    out.push({
      receipt,
      payer_name: name && name !== "null" ? titleCase(name) : null,
      payer_phone: normalisePhone(String(r?.["payer_phone"] ?? "")),
      amount_tsh: amount,
      paid_at: paidAt,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : 60,
      raw: JSON.stringify(r).slice(0, 300),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const normalise = (s: string) =>
  s.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * How well `payer` sits inside `known`, 0-1. Tanzanian names are a first
 * name plus a father's and sometimes a clan name, printed in either order,
 * and a parent paying often gives only two of the three — so containment
 * matters more than exact equality, and a single shared name is worth very
 * little because half a village shares it.
 */
function nameOverlap(payer: string, known: string): { shared: number; complete: boolean } {
  const wa = [...new Set(normalise(payer).split(" ").filter((w) => w.length > 2))];
  const wb = new Set(normalise(known).split(" ").filter((w) => w.length > 2));
  const shared = wa.filter((w) => wb.has(w)).length;
  return { shared, complete: wa.length >= 2 && shared === wa.length };
}

/** Score for the best name reading available, 0 when there is nothing in it. */
function nameScore(payer: string, known: string): { score: number; why: string | null } {
  const { shared, complete } = nameOverlap(payer, known);
  // Every name the payer gave is on the record: as good as a name gets.
  if (complete) return { score: 45, why: "full name" };
  if (shared >= 2) return { score: 30, why: "two names in common" };
  if (shared === 1) return { score: 10, why: "one name in common" };
  return { score: 0, why: null };
}

const fmt = (n: number) => `TSh ${n.toLocaleString()}`;

/**
 * Find who a payment belongs to, and say why.
 *
 * Signals, strongest first:
 *   1. the sending phone is a registered parent's phone;
 *   2. the payer's name matches a student's, or a registered parent's;
 *   3. the amount exactly clears one student's outstanding balance.
 *
 * A single candidate that scores well is proposed. Two plausible candidates
 * produce NO proposal — the row goes to the bursar with both named, because
 * an even split between two children is exactly the case a human must
 * decide. Returning the "slightly better" one would be the worst outcome
 * available: confidently wrong, and confirmed by a tired human who trusted it.
 */
export function matchPayment(row: PaymentRow, candidates: MatchCandidate[]): Match | null {
  type Scored = { c: MatchCandidate; score: number; by: Match["matched_by"]; why: string[] };
  const scored: Scored[] = [];

  for (const c of candidates) {
    let score = 0;
    let by: Match["matched_by"] = "name";
    const why: string[] = [];

    if (row.payer_phone && c.parent_phones.some((p) => normalisePhone(p) === row.payer_phone)) {
      score += 60;
      by = "phone";
      why.push(`parent phone +${row.payer_phone}`);
    }

    if (row.payer_name) {
      const student = nameScore(row.payer_name, c.name);
      const parent = c.parent_names
        .map((p) => nameScore(row.payer_name!, p))
        .sort((a, b) => b.score - a.score)[0] ?? { score: 0, why: null };
      // The registered parent's own name beats a resemblance to the child's.
      const best =
        parent.score >= student.score
          ? { ...parent, who: "the parent's" }
          : { ...student, who: "the student's" };
      if (best.score > 0 && best.why) {
        score += best.score;
        why.push(`${best.who} ${best.why}`);
      }
    }

    // An amount that exactly clears the balance is a strong corroborator and a
    // weak identifier: on its own it would match every student who happens to
    // owe the same termly figure, which in a school is most of a form.
    if (c.balance_tsh > 0 && c.balance_tsh === row.amount_tsh) {
      score += 20;
      why.push(`exactly clears ${fmt(c.balance_tsh)}`);
      if (by === "name" && why.length > 1) by = "name+amount";
    }

    if (score > 0) scored.push({ c, score, by, why });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  const runnerUp = scored[1];

  // Not confident enough on its own, or too close to call.
  if (best.score < 45) return null;
  if (runnerUp && best.score - runnerUp.score < 20) return null;

  return {
    student_id: best.c.student_id,
    student_name: best.c.name,
    matched_by: best.by,
    // Cap below 100: this is a proposal, and a number that reads as certainty
    // is how a human stops checking.
    confidence: Math.min(95, best.score),
    reason: `Matched on ${best.why.join(", ")}.`,
  };
}

export type ProposedPayment = PaymentRow & {
  match: Match | null;
  /** Set when this receipt is already on the ledger — never post it twice. */
  already_posted: boolean;
};
