import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import {
  normalizePhone,
  matchPayment,
  verifySignature,
  validatePayment,
  type PalmPayment,
} from "./palmpesa-client";
const paid: PalmPayment = {
  transaction_id: "K9-one",
  order_id: "PALM1",
  status: "COMPLETED",
  amount: 60000,
  currency: "TZS",
  reference: "R1",
  failure_reason: null,
};
test("normalizes Tanzanian numbers and rejects foreign/invalid numbers", () => {
  for (const phone of [
    "0712345678",
    "712345678",
    "+255 712 345 678",
    "255712345678",
  ])
    assert.equal(normalizePhone(phone), "255712345678");
  assert.throws(() => normalizePhone("254712345678"));
  assert.throws(() => normalizePhone("123"));
});
test("provider records must match order, transaction, amount and currency", () => {
  const expected = {
    transaction_id: "K9-one",
    order_id: "PALM1",
    amount: 60000,
  };
  matchPayment(paid, expected);
  for (const patch of [
    { amount: 1 },
    { currency: "USD" },
    { order_id: "PALM2" },
    { transaction_id: "K9-two" },
  ])
    assert.throws(() => matchPayment({ ...paid, ...patch }, expected));
  assert.throws(() => validatePayment({ ...paid, status: "SUCCESS" }));
});
test("signatures bind exact bytes and reject stale, malformed or modified callbacks", () => {
  const raw = Buffer.from('{"amount":60000}'),
    timestamp = "1792454400",
    secret = "test-only";
  const signature =
    "sha256=" +
    createHmac("sha256", secret)
      .update(timestamp + ".")
      .update(raw)
      .digest("hex");
  assert.equal(
    verifySignature(
      raw,
      timestamp,
      signature,
      secret,
      Number(timestamp) * 1000,
    ),
    true,
  );
  assert.equal(
    verifySignature(
      Buffer.from('{"amount":1}'),
      timestamp,
      signature,
      secret,
      Number(timestamp) * 1000,
    ),
    false,
  );
  assert.equal(
    verifySignature(
      raw,
      timestamp,
      signature,
      secret,
      Number(timestamp) * 1000 + 301000,
    ),
    false,
  );
  assert.equal(
    verifySignature(
      raw,
      timestamp,
      "sha256=00",
      secret,
      Number(timestamp) * 1000,
    ),
    false,
  );
});
