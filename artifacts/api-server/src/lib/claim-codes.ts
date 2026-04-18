// Claim codes & watch-pairing tokens.
//
// Codes look like `<PREFIX>-XXXX-XXXX`, where PREFIX is the school slug's
// first 4 letters (uppercased) and the two trailing groups are 4 chars each
// from a Crockford-style alphabet (no I/O/0/1, so a parent can't confuse
// "I" with "1" or "O" with "0" when they read it off a printout).
//
// We never store the plaintext code — only its SHA-256 hash. The school
// admin sees the plaintext exactly once, when the code is generated.
//
// Pairing tokens use the same alphabet but are 12 chars total (no prefix).
// They're meant to live on a watch face for ≤2 minutes inside a QR.

import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomChars(n: number): string {
  const buf = crypto.randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) {
    s += ALPHABET[buf[i]! % ALPHABET.length];
  }
  return s;
}

export function schoolPrefix(slug: string): string {
  const cleaned = slug.replace(/[^a-zA-Z]/g, "").toUpperCase();
  return (cleaned + "XXXX").slice(0, 4);
}

export function generateClaimCode(slug: string): string {
  return `${schoolPrefix(slug)}-${randomChars(4)}-${randomChars(4)}`;
}

export function generatePairingToken(): string {
  // 12 chars in groups of 4 for human-readable fallback if QR fails.
  return `${randomChars(4)}-${randomChars(4)}-${randomChars(4)}`;
}

export function hashCode(code: string): string {
  return crypto
    .createHash("sha256")
    .update(code.trim().toUpperCase())
    .digest("hex");
}

export function normalizeCode(input: string): string {
  // Tolerate spaces, lowercase, missing dashes — re-insert canonical dashes
  // so two visually-identical inputs always hash to the same value.
  const cleaned = input.replace(/\s+/g, "").toUpperCase();
  // If user typed without dashes, re-insert them assuming PREFIX-4-4 layout.
  if (!cleaned.includes("-") && cleaned.length === 12) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}-${cleaned.slice(8)}`;
  }
  return cleaned;
}
