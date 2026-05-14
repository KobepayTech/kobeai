import crypto from "node:crypto";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const NODE_ENV = process.env["NODE_ENV"] ?? "development";
const ALLOW_DEV_SECRETS = NODE_ENV === "development" || NODE_ENV === "test";
const ENV_SECRET = process.env["WATCH_HCE_SECRET"];
const DEV_FALLBACK = "dev-watch-hce-secret";

// Cache the active tenant secret in-process to keep verifyWatchPayload cheap.
// Invalidate on rotate and after CACHE_TTL_MS as a defence against split-brain
// when admins update the DB out-of-band.
const CACHE_TTL_MS = 60_000;
let cache: { secret: string; tenant_id: number | null; fetched_at: number } | null = null;

/**
 * Resolve the current shared HMAC secret used to verify watch HCE payloads.
 *
 * Precedence:
 *   1. tenants[0].watch_hce_secret (the row-of-truth on a school server)
 *   2. WATCH_HCE_SECRET env var (legacy single-tenant deploys)
 *   3. "dev-watch-hce-secret" in NODE_ENV=development/test only
 *
 * The api-server already throws at startup when both 1 and 2 are missing in
 * non-dev environments (see routes/print.ts), so this function is guaranteed
 * to return something usable in production.
 */
export async function getActiveWatchHceSecret(): Promise<{
  secret: string;
  source: "tenant" | "env" | "dev_fallback";
  tenant_id: number | null;
}> {
  if (cache && Date.now() - cache.fetched_at < CACHE_TTL_MS) {
    return {
      secret: cache.secret,
      source: cache.tenant_id != null ? "tenant" : (ENV_SECRET ? "env" : "dev_fallback"),
      tenant_id: cache.tenant_id,
    };
  }
  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .orderBy(tenantsTable.id)
    .limit(1);
  if (tenant?.watch_hce_secret) {
    cache = { secret: tenant.watch_hce_secret, tenant_id: tenant.id, fetched_at: Date.now() };
    return { secret: cache.secret, source: "tenant", tenant_id: tenant.id };
  }
  if (ENV_SECRET) {
    cache = { secret: ENV_SECRET, tenant_id: null, fetched_at: Date.now() };
    return { secret: ENV_SECRET, source: "env", tenant_id: null };
  }
  if (!ALLOW_DEV_SECRETS) {
    throw new Error("no WATCH_HCE_SECRET configured (tenant row + env both empty)");
  }
  cache = { secret: DEV_FALLBACK, tenant_id: null, fetched_at: Date.now() };
  return { secret: DEV_FALLBACK, source: "dev_fallback", tenant_id: null };
}

/**
 * Generate, persist, and return a fresh 32-byte hex secret for the first tenant.
 * The plaintext is returned ONCE — the caller (admin endpoint) is responsible
 * for showing it to the operator who will rebuild the watch APK with it.
 */
export async function rotateWatchHceSecret(): Promise<{
  secret: string;
  tenant_id: number;
  rotated_at: Date;
}> {
  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .orderBy(tenantsTable.id)
    .limit(1);
  if (!tenant) {
    throw new Error("no tenant row to rotate against");
  }
  const secret = crypto.randomBytes(32).toString("hex");
  const rotatedAt = new Date();
  await db
    .update(tenantsTable)
    .set({
      watch_hce_secret: secret,
      watch_hce_secret_rotated_at: rotatedAt,
    })
    .where(eq(tenantsTable.id, tenant.id));
  cache = { secret, tenant_id: tenant.id, fetched_at: Date.now() };
  logger.info({ tenant_id: tenant.id }, "watch HCE secret rotated");
  return { secret, tenant_id: tenant.id, rotated_at: rotatedAt };
}

/** Lightweight metadata for the admin UI — never returns the secret itself. */
export async function describeWatchHceSecret(): Promise<{
  source: "tenant" | "env" | "dev_fallback";
  tenant_id: number | null;
  rotated_at: string | null;
  fingerprint: string;
}> {
  const { secret, source, tenant_id } = await getActiveWatchHceSecret();
  const fingerprint = crypto
    .createHash("sha256")
    .update(secret)
    .digest("hex")
    .slice(0, 12);
  let rotated_at: string | null = null;
  if (source === "tenant" && tenant_id != null) {
    const [tenant] = await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenant_id));
    rotated_at = tenant?.watch_hce_secret_rotated_at?.toISOString() ?? null;
  }
  return { source, tenant_id, rotated_at, fingerprint };
}
