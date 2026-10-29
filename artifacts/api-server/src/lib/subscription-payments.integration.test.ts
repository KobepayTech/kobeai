import assert from "node:assert/strict";
import { test } from "node:test";
import type { PalmClient, PalmPayment, PalmRequest } from "./palmpesa-client";
const modulePath = process.env.K9_TEST_PGLITE_PATH;
test(
  "PalmPesa orders: retries, price integrity, duplicate settlement and late success",
  { skip: !modulePath },
  async () => {
    process.env.DATABASE_URL = "postgres://unused/test";
    process.env.PALMPESA_API_TOKEN = "test-token-not-real";
    process.env.PALMPESA_CALLBACK_URL = "https://example.test/api/callback";
    const { PGlite } = await import(modulePath!);
    const pg = new PGlite();
    const { pool } = await import("@workspace/db");
    const oldQuery = pool.query,
      oldConnect = pool.connect;
    const query = async (sql: string, values?: unknown[]) =>
      values?.length
        ? pg.query(sql, values)
        : ((await pg.exec(sql)).at(-1) ?? { rows: [] });
    Object.assign(pool, {
      query,
      connect: async () => ({ query, release() {} }),
    });
    try {
      await pg.exec(`SET TIME ZONE 'UTC'; CREATE TABLE tenants(id INT PRIMARY KEY); INSERT INTO tenants VALUES(1),(2);
      CREATE TABLE student_subscriptions(id SERIAL PRIMARY KEY,tenant_id INT,student_code TEXT,student_name TEXT,plan TEXT,status TEXT,billing_period TEXT,period_price_tsh INT,monthly_price_tsh INT,expires_at TIMESTAMPTZ,last_payment_at TIMESTAMPTZ,updated_at TIMESTAMPTZ,collected_by TEXT,collection_reference TEXT,UNIQUE(tenant_id,student_code));
      INSERT INTO student_subscriptions(tenant_id,student_code,student_name,plan,status,billing_period,period_price_tsh,monthly_price_tsh,expires_at) VALUES(1,'S1','Asha','learning','active','year',60000,5000,'2030-01-01'),(2,'S1','Other school','learning','active','year',100000,8333,'2030-01-01');
      CREATE TABLE subscription_payments(id SERIAL PRIMARY KEY,tenant_id INT REFERENCES tenants(id),student_code TEXT,student_name TEXT,plan TEXT,amount_tsh INT,phone TEXT,status TEXT,checkout_request_id TEXT,mpesa_receipt TEXT,failure_reason TEXT,initiated_at TIMESTAMPTZ DEFAULT NOW(),completed_at TIMESTAMPTZ);`);
      const svc = await import("./subscription-payments");
      await svc.ensurePalmPayments();
      assert.equal((await svc.subscriptionQuote(1, "S1")).amount_tsh, 60000);
      const input = {
        student_code: "S1",
        phone: "0712345678",
        name: "Parent",
        email: "parent@example.test",
        idempotency_key: "test-request-00000001",
        accepted_amount_tsh: 60000,
        accepted_months: 12,
      };
      await assert.rejects(
        svc.createSubscriptionPayment(1, {
          ...input,
          accepted_amount_tsh: 100,
        }),
        /Price changed/,
      );
      const created = await svc.createSubscriptionPayment(1, input);
      const again = await svc.createSubscriptionPayment(1, input);
      assert.equal(created.payment_id, again.payment_id);
      assert.equal(
        (
          await svc.createSubscriptionPayment(1, {
            ...input,
            idempotency_key: "test-request-00000002",
          })
        ).payment_id,
        created.payment_id,
      );
      await assert.rejects(
        svc.createSubscriptionPayment(1, { ...input, phone: "0712345679" }),
        /different details/,
      );
      let calls = 0,
        request: PalmRequest | undefined;
      const status = (state: PalmPayment["status"]): PalmPayment => ({
        transaction_id: request!.transaction_id,
        order_id: "PALM1",
        status: state,
        amount: 60000,
        currency: "TZS",
        reference: "REF1",
        failure_reason: null,
      });
      const provider: PalmClient = {
        async initiate(body) {
          calls++;
          if (request) assert.deepEqual(body, request);
          request = body;
          if (calls === 1) throw new Error("timeout");
          return status("INITIATING");
        },
        async status() {
          return status("EXPIRED");
        },
      };
      await assert.rejects(
        svc.processPalmOrder(created.payment_id, provider),
        /timeout/,
      );
      await svc.processPalmOrder(created.payment_id, provider);
      assert.equal(calls, 2);
      assert.equal(
        (await query("SELECT status FROM subscription_payments")).rows[0]
          .status,
        "pending",
      );
      await svc.processPalmOrder(created.payment_id, provider);
      assert.equal(
        (await query("SELECT status FROM subscription_payments")).rows[0]
          .status,
        "failed",
      );
      await assert.rejects(
        svc.applyVerifiedPayment(created.payment_id, {
          ...status("COMPLETED"),
          amount: 100,
        }),
        /does not match/,
      );
      await svc.applyVerifiedPayment(created.payment_id, status("COMPLETED"));
      await svc.applyVerifiedPayment(created.payment_id, status("COMPLETED"));
      await svc.applyVerifiedPayment(created.payment_id, status("REJECTED"));
      assert.equal(
        (await query("SELECT status FROM subscription_payments")).rows[0]
          .status,
        "success",
      );
      const subs = (
        await query(
          "SELECT tenant_id,expires_at FROM student_subscriptions ORDER BY tenant_id",
        )
      ).rows;
      assert.equal(
        new Date(subs[0].expires_at).toISOString(),
        "2031-01-01T00:00:00.000Z",
      );
      assert.equal(
        new Date(subs[1].expires_at).toISOString(),
        "2030-01-01T00:00:00.000Z",
      );
      // A forged unsigned callback can request verification, but cannot activate a subscription.
      const second = await svc.createSubscriptionPayment(1, {
        ...input,
        idempotency_key: "test-request-00000003",
      });
      const order = (
        await query("SELECT * FROM palmpesa_orders WHERE payment_id=$1", [
          second.payment_id,
        ])
      ).rows[0];
      const { palmCallback } = await import("../routes/palmpesa-callback");
      const event = {
        event_id: "fake-event-0000000000001",
        transaction_id: order.transaction_id,
        order_id: "FORGED",
        amount: 60000,
        currency: "TZS",
        status: "COMPLETED",
      };
      let response: unknown;
      await palmCallback(
        {
          body: event,
          header: (name: string) =>
            name === "x-palmpesa-event-id" ? event.event_id : undefined,
        } as never,
        {
          json: (body: unknown) => {
            response = body;
          },
        } as never,
      );
      assert.deepEqual(response, { received: true });
      assert.equal(
        (
          await query("SELECT status FROM subscription_payments WHERE id=$1", [
            second.payment_id,
          ])
        ).rows[0].status,
        "pending",
      );
      await palmCallback(
        {
          body: event,
          header: (name: string) =>
            name === "x-palmpesa-event-id" ? event.event_id : undefined,
        } as never,
        { json: () => {} } as never,
      );
      assert.equal(
        (await query("SELECT * FROM palmpesa_events")).rows.length,
        1,
      );
    } finally {
      Object.assign(pool, { query: oldQuery, connect: oldConnect });
      await pg.close();
      await pool.end();
    }
  },
);
