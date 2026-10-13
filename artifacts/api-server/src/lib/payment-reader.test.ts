// node --import tsx --test artifacts/api-server/src/lib/payment-reader.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  matchPayment,
  normalisePhone,
  parsePaymentLine,
  parsePaymentLines,
  type MatchCandidate,
  type PaymentRow,
} from "./payment-reader";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test("a standard M-Pesa confirmation is read exactly", () => {
  const row = parsePaymentLine(
    "QGH4K2LM9X Confirmed. You have received TSh 120,000.00 from ASHA JUMA MWANGI 255712345678 " +
      "on 3/2/26 at 10:31 AM. New M-PESA balance is TSh 480,000.00",
  );
  assert.ok(row);
  assert.equal(row!.receipt, "QGH4K2LM9X");
  assert.equal(row!.amount_tsh, 120_000);
  assert.equal(row!.payer_name, "Asha Juma Mwangi");
  assert.equal(row!.payer_phone, "255712345678");
  assert.equal(row!.paid_at?.slice(0, 10), "2026-02-03");
  assert.ok(row!.confidence >= 90);
});

test("the running balance is never mistaken for the payment", () => {
  const row = parsePaymentLine(
    "QK7T2M4P1A Confirmed. You have received TSh 60,000.00 from JUMA HAMISI 0754111222. " +
      "New M-PESA balance is TSh 9,999,999.00",
  );
  assert.equal(row!.amount_tsh, 60_000);
});

test("a local phone format normalises to the international one", () => {
  const row = parsePaymentLine("TSh 45,000.00 received from NEEMA MASSAWE 0712 345 678. Ref QZ1A2B3C4D");
  assert.equal(row!.payer_phone, "255712345678");
  assert.equal(row!.amount_tsh, 45_000);
  assert.equal(row!.receipt, "QZ1A2B3C4D");
});

test("phone normalisation handles every shape a sender writes", () => {
  assert.equal(normalisePhone("+255 712 345 678"), "255712345678");
  assert.equal(normalisePhone("0712345678"), "255712345678");
  assert.equal(normalisePhone("712345678"), "255712345678");
  assert.equal(normalisePhone("255712345678"), "255712345678");
  assert.equal(normalisePhone("12345"), null);
  assert.equal(normalisePhone(null), null);
});

test("a line with no amount is not a payment", () => {
  assert.equal(parsePaymentLine("Your M-PESA statement for February 2026"), null);
  assert.equal(parsePaymentLine(""), null);
  assert.equal(parsePaymentLine("QGH4K2LM9X Confirmed."), null);
});

test("reading a thread keeps every payment and drops the duplicates", () => {
  const rows = parsePaymentLines(
    [
      "QGH4K2LM9X Confirmed. You have received TSh 120,000.00 from ASHA JUMA 255712345678",
      "M-PESA statement, February 2026",
      "QK7T2M4P1A Confirmed. You have received TSh 60,000.00 from JUMA HAMISI 0754111222",
      // The same confirmation forwarded twice — one payment, not two.
      "QGH4K2LM9X Confirmed. You have received TSh 120,000.00 from ASHA JUMA 255712345678",
    ].join("\n"),
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.amount_tsh),
    [120_000, 60_000],
  );
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const row = (over: Partial<PaymentRow> = {}): PaymentRow => ({
  receipt: "QGH4K2LM9X",
  payer_name: null,
  payer_phone: null,
  amount_tsh: 120_000,
  paid_at: null,
  confidence: 80,
  raw: "",
  ...over,
});

const candidate = (over: Partial<MatchCandidate> & { student_id: number; name: string }): MatchCandidate => ({
  student_code: null,
  grade: "Form 2",
  balance_tsh: 0,
  parent_phones: [],
  parent_names: [],
  ...over,
});

test("the sending phone is the strongest signal there is", () => {
  const match = matchPayment(row({ payer_phone: "255712345678" }), [
    candidate({ student_id: 1, name: "Asha Juma Mwangi", parent_phones: ["0712345678"] }),
    candidate({ student_id: 2, name: "Baraka Shayo", parent_phones: ["255754111222"] }),
  ]);
  assert.equal(match?.student_id, 1);
  assert.equal(match?.matched_by, "phone");
  assert.match(match!.reason, /parent phone/);
});

test("the payer's own name matches their child", () => {
  const match = matchPayment(row({ payer_name: "Juma Mwangi" }), [
    candidate({ student_id: 1, name: "Asha Juma Mwangi" }),
    candidate({ student_id: 2, name: "Baraka Peter Shayo" }),
  ]);
  assert.equal(match?.student_id, 1);
});

test("an amount that exactly clears a balance corroborates but never identifies", () => {
  // Amount alone: every Form 2 owes the same termly figure, so this must not
  // be enough on its own.
  const amountOnly = matchPayment(row({ amount_tsh: 120_000 }), [
    candidate({ student_id: 1, name: "Asha Juma", balance_tsh: 120_000 }),
    candidate({ student_id: 2, name: "Baraka Shayo", balance_tsh: 120_000 }),
  ]);
  assert.equal(amountOnly, null);

  // With a name, the same amount pushes it over the line.
  const withName = matchPayment(row({ payer_name: "Asha Juma", amount_tsh: 120_000 }), [
    candidate({ student_id: 1, name: "Asha Juma", balance_tsh: 120_000 }),
    candidate({ student_id: 2, name: "Baraka Shayo", balance_tsh: 120_000 }),
  ]);
  assert.equal(withName?.student_id, 1);
  assert.match(withName!.reason, /exactly clears/);
});

test("two equally plausible children produce no proposal at all", () => {
  // Siblings: one parent phone, two students. There is no defensible answer,
  // and picking the "slightly better" one would be confidently wrong.
  const match = matchPayment(row({ payer_phone: "255712345678" }), [
    candidate({ student_id: 1, name: "Asha Juma", parent_phones: ["255712345678"] }),
    candidate({ student_id: 2, name: "Neema Juma", parent_phones: ["255712345678"] }),
  ]);
  assert.equal(match, null);
});

test("a stranger's payment matches nobody", () => {
  const match = matchPayment(row({ payer_name: "Someone Unrelated", payer_phone: "255799999999" }), [
    candidate({ student_id: 1, name: "Asha Juma Mwangi", parent_phones: ["255712345678"] }),
  ]);
  assert.equal(match, null);
});

test("no candidates, no crash", () => {
  assert.equal(matchPayment(row({ payer_name: "Asha Juma" }), []), null);
});

test("a proposal never claims certainty", () => {
  const match = matchPayment(row({ payer_phone: "255712345678", payer_name: "Asha Juma", amount_tsh: 120_000 }), [
    candidate({
      student_id: 1,
      name: "Asha Juma",
      balance_tsh: 120_000,
      parent_phones: ["255712345678"],
      parent_names: ["Asha Juma"],
    }),
  ]);
  // Every signal fires, and it still reads as a proposal — a number that
  // looks like certainty is how a tired human stops checking.
  assert.ok(match!.confidence <= 95);
});
