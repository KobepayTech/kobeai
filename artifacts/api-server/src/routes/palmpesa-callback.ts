import type { Request, Response } from "express";
import { pool } from "@workspace/db";
import { verifySignature } from "../lib/palmpesa-client";
import { ensurePalmPayments } from "../lib/subscription-payments";
import { transaction } from "../lib/learning-packs";
export async function palmCallback(req: Request, res: Response): Promise<void> {
  const secret = process.env.PALMPESA_SIGNING_SECRET;
  if (
    secret &&
    !verifySignature(
      (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0),
      req.header("x-palmpesa-timestamp") ?? "",
      req.header("x-palmpesa-signature") ?? "",
      secret,
    )
  ) {
    res.status(401).json({ error: "Invalid payment signature" });
    return;
  }
  const e = req.body;
  if (
    !e ||
    typeof e.event_id !== "string" ||
    e.event_id.length > 128 ||
    e.event_id.length < 16 ||
    req.header("x-palmpesa-event-id") !== e.event_id
  ) {
    res.status(400).json({ error: "Invalid payment event" });
    return;
  }
  await ensurePalmPayments();
  await transaction(async (q) => {
    const {
      rows: [o],
    } = await q.query("SELECT * FROM palmpesa_orders WHERE transaction_id=$1", [
      String(e.transaction_id ?? ""),
    ]);
    if (
      !o ||
      e.amount !== o.amount_tsh ||
      e.currency !== "TZS" ||
      (o.order_id && o.order_id !== e.order_id)
    )
      return;
    const event = await q.query(
      "INSERT INTO palmpesa_events(event_id,payment_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id",
      [e.event_id, o.payment_id],
    );
    if (event.rows.length)
      await q.query(
        "UPDATE palmpesa_orders SET next_check_at=NOW() WHERE payment_id=$1 AND applied_at IS NULL",
        [o.payment_id],
      );
    // No entitlement changes here. Even unsigned callbacks only wake an authenticated status lookup.
  });
  res.json({ received: true });
}
