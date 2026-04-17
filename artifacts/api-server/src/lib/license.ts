import crypto from "node:crypto";

/**
 * License keys are random opaque strings. We use a `kobeai_lk_` prefix so
 * they're easy to spot in logs and to grep out of configs accidentally.
 */
export function generateLicenseKey(): string {
  return `kobeai_lk_${crypto.randomBytes(24).toString("base64url")}`;
}

/**
 * Constant-time compare to avoid leaking timing information when
 * authenticating sync requests.
 */
export function compareLicenseKeys(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
