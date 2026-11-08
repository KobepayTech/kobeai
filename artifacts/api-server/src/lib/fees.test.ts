// node --import tsx --test artifacts/api-server/src/lib/fees.test.ts
import assert from "node:assert/strict";
import { before, test } from "node:test";

// lib/fees pulls in @workspace/db, which refuses to load without a
// DATABASE_URL. `pg.Pool` does not dial until the first query, so a dummy URL
// is enough to import the module and exercise the validation and arithmetic
// that guard every write, with no database anywhere near the test.
process.env["DATABASE_URL"] ??= "postgres://test:test@127.0.0.1:5432/test";

type Fees = typeof import("./fees");
let fees: Fees;

before(async () => {
  fees = await import("./fees");
});

const base = { student_id: 1, kind: "charge" as const };

async function rejects(input: Parameters<Fees["post"]>[0], pattern: RegExp) {
  await assert.rejects(() => fees.post(input), (err: Error) => {
    assert.ok(err instanceof fees.FeeError, `expected a FeeError, got ${err}`);
    assert.match(err.message, pattern);
    return true;
  });
}

test("an amount that is not a positive whole number of shillings is refused", async () => {
  // These all fail before any database call, which is the point: the guard is
  // in the money path, not in a route handler someone might forget to add.
  await rejects({ ...base, amount_tsh: 0 }, /positive whole number/);
  await rejects({ ...base, amount_tsh: -5000 }, /positive whole number/);
  await rejects({ ...base, amount_tsh: 1500.5 }, /positive whole number/);
  await rejects({ ...base, amount_tsh: Number.NaN }, /positive whole number/);
});

test("an implausibly large figure is refused rather than posted", async () => {
  // A hundred-million-shilling school fee payment is a typo, every time.
  await rejects({ ...base, amount_tsh: 100_000_001 }, /implausibly large/);
});

test("a negative charge cannot sneak in as a credit", async () => {
  // `post` derives the sign from `kind`, so the only way to credit an account
  // is to say "payment" — a caller cannot flip a charge by passing -50,000.
  await rejects({ ...base, kind: "charge", amount_tsh: -50_000 }, /positive whole number/);
  await rejects({ ...base, kind: "payment", amount_tsh: -50_000 }, /positive whole number/);
});

test("the fee methods are exactly the ones the ledger understands", () => {
  assert.deepEqual(fees.FEE_METHODS, ["mpesa", "cash", "bank", "waiver"]);
});

test("FeeError carries the status and code a route needs to answer with", () => {
  const err = new fees.FeeError(409, "Payment QGH4K2LM9X is already on the ledger.", "duplicate_reference");
  assert.equal(err.status, 409);
  assert.equal(err.code, "duplicate_reference");
  assert.ok(err instanceof Error);
});
