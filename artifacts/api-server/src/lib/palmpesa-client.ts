import { createHmac, timingSafeEqual } from "node:crypto";
export const PALMPESA_API = "https://palmpesa.co.tz/api/v2/async/payments";
export const PAYMENT_STATES = [
  "INITIATING",
  "PENDING",
  "AMBIGUOUS",
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
  "INITIATION_FAILED",
  "EXPIRED",
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];
export type PalmPayment = {
  transaction_id: string;
  order_id: string;
  status: PaymentState;
  amount: number;
  currency: string;
  reference: string | null;
  failure_reason: string | null;
};
export type PalmRequest = {
  transaction_id: string;
  amount: number;
  currency: "TZS";
  phone: string;
  name: string;
  email: string;
  callback_url: string;
  buyer_remarks: string;
};
export function normalizePhone(value: unknown): string {
  let phone = String(value ?? "").replace(/[\s()+-]/g, "");
  if (/^0[67]\d{8}$/.test(phone)) phone = "255" + phone.slice(1);
  if (/^[67]\d{8}$/.test(phone)) phone = "255" + phone;
  if (!/^255[67]\d{8}$/.test(phone))
    throw new Error("Enter a valid Tanzanian mobile-money number");
  return phone;
}
export function callbackConfig(): string {
  const url = new URL(process.env.PALMPESA_CALLBACK_URL ?? "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hostname === "localhost"
  )
    throw new Error("PalmPesa requires a public HTTPS callback URL");
  return url.toString();
}
export function paymentConfigured(): boolean {
  try {
    return !!process.env.PALMPESA_API_TOKEN && !!callbackConfig();
  } catch {
    return false;
  }
}
export function validatePayment(value: unknown): PalmPayment {
  const p = value as PalmPayment;
  if (
    !p ||
    typeof p.transaction_id !== "string" ||
    typeof p.order_id !== "string" ||
    !/^[-A-Za-z0-9_: .]+$/.test(p.order_id) ||
    !PAYMENT_STATES.includes(p.status) ||
    !Number.isSafeInteger(p.amount) ||
    p.amount < 100 ||
    p.currency !== "TZS"
  )
    throw new Error("Invalid PalmPesa payment response");
  return p;
}
export function matchPayment(
  p: PalmPayment,
  expected: { transaction_id: string; order_id: string; amount: number },
): void {
  if (
    p.transaction_id !== expected.transaction_id ||
    p.order_id !== expected.order_id ||
    p.amount !== expected.amount ||
    p.currency !== "TZS"
  )
    throw new Error("PalmPesa payment does not match the recorded order");
}
export function verifySignature(
  raw: Buffer,
  timestamp: string,
  signature: string,
  secret: string,
  now = Date.now(),
): boolean {
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !/^sha256=[a-f0-9]{64}$/.test(signature)
  )
    return false;
  const expected =
    "sha256=" +
    createHmac("sha256", secret)
      .update(timestamp + ".")
      .update(raw)
      .digest("hex");
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
export interface PalmClient {
  initiate(body: PalmRequest): Promise<PalmPayment>;
  status(order: string): Promise<PalmPayment>;
}
async function api(path: string, body?: PalmRequest): Promise<PalmPayment> {
  if (!process.env.PALMPESA_API_TOKEN)
    throw new Error("PalmPesa is not configured");
  const response = await fetch(PALMPESA_API + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${process.env.PALMPESA_API_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(
      `PalmPesa HTTP ${response.status}; order retained for reconciliation`,
    );
  const result = (await response.json()) as {
    success?: boolean;
    data?: unknown;
  };
  if (result.success !== true)
    throw new Error("PalmPesa did not accept the request");
  return validatePayment(result.data);
}
export const palmPesa: PalmClient = {
  initiate: (body) => api("", body),
  status: (order) => api("/" + encodeURIComponent(order)),
};
