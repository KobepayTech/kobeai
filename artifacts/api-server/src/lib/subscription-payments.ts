import type { Queryable } from "./results";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import {
  callbackConfig,
  matchPayment,
  normalizePhone,
  palmPesa,
  paymentConfigured,
  type PalmClient,
  type PalmRequest,
  type PalmPayment,
} from "./palmpesa-client";
import { logger } from "./logger";
import { transaction } from "./learning-packs";
let ready: Promise<void> | null = null;
export function ensurePalmPayments(): Promise<void> {
  return (ready ??= pool
    .query(
      `
  CREATE TABLE IF NOT EXISTS palmpesa_orders(
    payment_id INT PRIMARY KEY REFERENCES subscription_payments(id),tenant_id INT NOT NULL REFERENCES tenants(id),student_code TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,transaction_id TEXT NOT NULL UNIQUE,order_id TEXT UNIQUE,request JSONB NOT NULL,
    amount_tsh INT NOT NULL CHECK(amount_tsh>=100),months INT NOT NULL CHECK(months IN(1,12)),plan TEXT NOT NULL,
    provider_status TEXT NOT NULL DEFAULT 'NEW',last_error TEXT,next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    applied_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(tenant_id,idempotency_key));
  CREATE TABLE IF NOT EXISTS palmpesa_dispatch (id INT PRIMARY KEY CHECK(id=1), last_call TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01');
  INSERT INTO palmpesa_dispatch(id) VALUES(1) ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS palmpesa_events(event_id TEXT PRIMARY KEY,payment_id INT NOT NULL REFERENCES palmpesa_orders(payment_id),received_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE INDEX IF NOT EXISTS palmpesa_due ON palmpesa_orders(next_check_at) WHERE applied_at IS NULL;
`,
    )
    .then(() => undefined)
    .catch((e) => {
      ready = null;
      throw e;
    }));
}
export function quoteFor(sub: {
  billing_period: string;
  period_price_tsh: number;
  monthly_price_tsh: number;
  plan: string;
}) {
  if (!["year", "month"].includes(sub.billing_period))
    throw new Error("Subscription billing period is not configured");
  const amount =
    sub.period_price_tsh > 0
      ? sub.period_price_tsh
      : sub.billing_period === "month"
        ? sub.monthly_price_tsh
        : 0;
  if (!Number.isSafeInteger(amount) || amount < 100 || amount > 100000000)
    throw new Error("Subscription price must be configured before payment");
  return {
    amount_tsh: amount,
    months: sub.billing_period === "year" ? 12 : 1,
    billing_period: sub.billing_period,
    plan: sub.plan,
  };
}
export async function subscriptionQuote(tenant: number, code: string) {
  const {
    rows: [sub],
  } = await pool.query(
    "SELECT * FROM student_subscriptions WHERE tenant_id=$1 AND student_code=$2",
    [tenant, code],
  );
  if (!sub) throw new Error("Subscription not found");
  return {
    ...quoteFor(sub),
    payment_provider: "PalmPesa",
    available: paymentConfigured(),
  };
}
export async function createSubscriptionPayment(
  tenant: number,
  input: {
    student_code: string;
    phone: unknown;
    name: unknown;
    email: unknown;
    idempotency_key: unknown;
    accepted_amount_tsh: unknown;
    accepted_months: unknown;
  },
) {
  if (!paymentConfigured())
    throw new Error("PalmPesa payments are not configured yet");
  await ensurePalmPayments();
  const phone = normalizePhone(input.phone),
    name = String(input.name ?? "").trim(),
    email = String(input.email ?? "").trim(),
    key = String(input.idempotency_key ?? "");
  if (
    !name ||
    name.length > 255 ||
    !/^\S+@\S+\.\S+$/.test(email) ||
    email.length > 255 ||
    !/^[-\w:.]{16,100}$/.test(key)
  )
    throw new Error(
      "Payer name, valid email and payment request key are required",
    );
  return transaction(async (q) => {
    // Locks serialize parents paying for the same student. Amount comes from the server plan.
    const {
      rows: [sub],
    } = await q.query(
      "SELECT * FROM student_subscriptions WHERE tenant_id=$1 AND student_code=$2 FOR UPDATE",
      [tenant, input.student_code],
    );
    if (!sub) throw new Error("Subscription not found");
    const {
      rows: [previous],
    } = await q.query(
      "SELECT * FROM palmpesa_orders WHERE tenant_id=$1 AND idempotency_key=$2",
      [tenant, key],
    );
    if (previous) {
      if (
        previous.student_code !== input.student_code ||
        previous.request.phone !== phone ||
        previous.request.email !== email ||
        previous.request.name !== name ||
        previous.amount_tsh !== input.accepted_amount_tsh ||
        previous.months !== input.accepted_months
      )
        throw new Error(
          "Payment request key was already used with different details",
        );
      return { payment_id: previous.payment_id, reused: true };
    }
    const quote = quoteFor({
      billing_period: sub.billing_period,
      period_price_tsh: sub.period_price_tsh,
      monthly_price_tsh: sub.monthly_price_tsh,
      plan: sub.plan,
    });
    if (
      quote.amount_tsh !== input.accepted_amount_tsh ||
      quote.months !== input.accepted_months
    )
      throw new Error(
        "Price changed. Refresh the payment quote before approving.",
      );
    const {
      rows: [pending],
    } = await q.query(
      "SELECT payment_id FROM palmpesa_orders WHERE tenant_id=$1 AND student_code=$2 AND provider_status IN ('NEW','INITIATING','PENDING','AMBIGUOUS') ORDER BY payment_id DESC LIMIT 1",
      [tenant, input.student_code],
    );
    if (pending) return { payment_id: pending.payment_id, reused: true };
    const txn = `K9-${randomUUID()}`;
    const request: PalmRequest = {
      transaction_id: txn,
      amount: quote.amount_tsh,
      currency: "TZS",
      phone,
      name,
      email,
      callback_url: callbackConfig(),
      buyer_remarks: `K9 subscription: ${quote.months} months`,
    };
    const {
      rows: [p],
    } = await q.query(
      `INSERT INTO subscription_payments(tenant_id,student_code,student_name,plan,amount_tsh,phone,status,checkout_request_id)
      VALUES($1,$2,$3,$4,$5,$6,'pending',$7) RETURNING id`,
      [
        tenant,
        input.student_code,
        sub.student_name,
        sub.plan,
        quote.amount_tsh,
        phone,
        txn,
      ],
    );
    await q.query(
      "INSERT INTO palmpesa_orders(payment_id,tenant_id,student_code,idempotency_key,transaction_id,request,amount_tsh,months,plan) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        p.id,
        tenant,
        input.student_code,
        key,
        txn,
        JSON.stringify(request),
        quote.amount_tsh,
        quote.months,
        sub.plan,
      ],
    );
    return { payment_id: p.id, reused: false };
  });
}
/** Only authenticated provider GET results reach this function. Callback bodies never settle. */
export async function applyVerifiedPayment(
  paymentId: number,
  verified: PalmPayment,
): Promise<void> {
  await transaction(async (q) => {
    const {
      rows: [o],
    } = await q.query(
      "SELECT * FROM palmpesa_orders WHERE payment_id=$1 FOR UPDATE",
      [paymentId],
    );
    if (!o) throw new Error("Payment order not found");
    matchPayment(verified, {
      transaction_id: o.transaction_id,
      order_id: o.order_id,
      amount: o.amount_tsh,
    });
    if (o.applied_at) return; // A stale failure after success cannot revoke paid access.
    if (verified.status === "COMPLETED") {
      const renewed = await q.query(
        `UPDATE student_subscriptions SET status='active',plan=$3,last_payment_at=NOW(),
        expires_at=GREATEST(COALESCE(expires_at,NOW()),NOW())+make_interval(months=>$4),updated_at=NOW(),
        collected_by='parent_palmpesa',collection_reference=$5
        WHERE tenant_id=$1 AND student_code=$2 RETURNING id`,
        [o.tenant_id, o.student_code, o.plan, o.months, o.transaction_id],
      );
      if (renewed.rows.length !== 1)
        throw new Error("Paid subscription missing; reconciliation required");
      await q.query(
        "UPDATE subscription_payments SET status='success',mpesa_receipt=$2,completed_at=NOW(),failure_reason=NULL WHERE id=$1",
        [paymentId, verified.reference ?? verified.order_id],
      );
      await q.query(
        "UPDATE palmpesa_orders SET provider_status='COMPLETED',applied_at=NOW(),last_error=NULL WHERE payment_id=$1",
        [paymentId],
      );
    } else {
      const failed = [
        "CANCELLED",
        "REJECTED",
        "INITIATION_FAILED",
        "EXPIRED",
      ].includes(verified.status);
      await q.query(
        "UPDATE palmpesa_orders SET provider_status=$2,last_error=NULL,next_check_at=NOW()+CASE WHEN $3 THEN INTERVAL '24 hours' ELSE INTERVAL '15 seconds' END WHERE payment_id=$1",
        [paymentId, verified.status, failed],
      );
      await q.query(
        "UPDATE subscription_payments SET status=$2,failure_reason=$3,completed_at=CASE WHEN $2='failed' THEN NOW() ELSE NULL END WHERE id=$1",
        [
          paymentId,
          failed ? "failed" : "pending",
          failed ? (verified.failure_reason ?? verified.status) : null,
        ],
      );
    }
  });
}
export async function processPalmOrder(
  paymentId: number,
  provider: PalmClient = palmPesa,
): Promise<void> {
  const {
    rows: [o],
  } = await pool.query("SELECT * FROM palmpesa_orders WHERE payment_id=$1", [
    paymentId,
  ]);
  if (!o || o.applied_at) return;
  if (!o.order_id) {
    // Persisted request/transaction_id makes timeout retries safe and reproducible.
    const accepted = await provider.initiate(o.request);
    matchPayment(accepted, {
      transaction_id: o.transaction_id,
      order_id: accepted.order_id,
      amount: o.amount_tsh,
    });
    await pool.query(
      "UPDATE palmpesa_orders SET order_id=$2,provider_status=$3,last_error=NULL,next_check_at=NOW()+INTERVAL '15 seconds' WHERE payment_id=$1 AND order_id IS NULL",
      [paymentId, accepted.order_id, "INITIATING"],
    );
    return; // Even a COMPLETED initiation response must be checked via authenticated GET.
  }
  await applyVerifiedPayment(paymentId, await provider.status(o.order_id));
}
let busy = false;
export async function paymentTick(): Promise<void> {
  if (busy || !paymentConfigured()) return;
  busy = true;
  let lock: (Queryable & { release(): void }) | undefined;
  try {
    await ensurePalmPayments();
    lock = await pool.connect();
    const got = await lock.query(
      "SELECT pg_try_advisory_lock(19044,1) AS locked",
    );
    if (!got.rows[0].locked) return;
    const slot = await pool.query(
      "UPDATE palmpesa_dispatch SET last_call=NOW() WHERE id=1 AND last_call<NOW()-INTERVAL '3 seconds' RETURNING id",
    );
    if (!slot.rows.length) return;
    const {
      rows: [o],
    } =
      await pool.query(`UPDATE palmpesa_orders SET next_check_at=NOW()+INTERVAL '30 seconds' WHERE payment_id=(
      SELECT payment_id FROM palmpesa_orders WHERE applied_at IS NULL AND next_check_at<=NOW()
      
      ORDER BY next_check_at LIMIT 1) RETURNING payment_id`);
    if (o) {
      try {
        await processPalmOrder(o.payment_id);
      } catch (err) {
        await pool.query(
          "UPDATE palmpesa_orders SET last_error=$2,next_check_at=NOW()+INTERVAL '60 seconds' WHERE payment_id=$1",
          [o.payment_id, err instanceof Error ? err.message : "Provider error"],
        );
        logger.warn(
          { payment_id: o.payment_id },
          "PalmPesa payment needs retry or reconciliation",
        );
      }
    }
  } catch (err) {
    logger.error({ err }, "PalmPesa payment worker failed");
  } finally {
    if (lock) {
      await lock.query("SELECT pg_advisory_unlock(19044,1)");
      lock.release();
    }
    busy = false;
  }
}
