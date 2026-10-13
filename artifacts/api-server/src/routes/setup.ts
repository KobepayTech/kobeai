import crypto from "node:crypto";
import { Router } from "express";
import { eq, inArray, sql } from "drizzle-orm";
import { db, schoolSetupTable, tenantsTable, usersTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { generateLicenseKey } from "../lib/license";
import { logger } from "../lib/logger";
import { rateLimit } from "../lib/rate-limit";
import { checkPin, hashPin } from "../lib/seed";

// ===========================================================================
// First-run setup, and the line between a school and the operator.
//
// A K9 server ships with no accounts. The first person to open the dashboard
// is asked for two things — the school's name and a setup password — and that
// call creates the tenant and the school's own administrator. From there the
// administrator prints QR codes and the staff onboard themselves
// (routes/onboarding.ts).
//
// What that flow can NEVER create is a `super_admin`. The operator console
// (/central/v1/admin/*: every school's licence key, the KP economy, the
// market agent's reward band) belongs to KobepayTech, not to the school the
// server is sitting in. So:
//
//   * install creates role "admin" — a school administrator — and nothing else;
//   * a `super_admin` exists only on a server started with K9_OPERATOR_SECRET,
//     and only after someone presents that secret AND the school's own setup
//     password to /v1/setup/operator/unlock;
//   * with no secret in the environment the unlock endpoint answers 404, so a
//     school install has no operator surface to find, probe or brute-force;
//   * the dashboard hides every operator page unless /v1/me/capabilities says
//     the signed-in user actually holds that role.
//
// The UI hiding is a courtesy. The enforcement is requireAuth(["super_admin"])
// on the central router, which no amount of poking at the dashboard changes.
// ===========================================================================

const router = Router();

// Setup is a one-shot endpoint, but it is unauthenticated by necessity, so it
// gets the same throttle the login surfaces use.
const setupLimiter = rateLimit({ windowMs: 60_000, max: 6, name: "setup" });

const MIN_PASSWORD = 8;

async function loadSetup() {
  const [row] = await db.select().from(schoolSetupTable).limit(1);
  return row ?? null;
}

async function hasStaffAccount(): Promise<boolean> {
  const [row] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(inArray(usersTable.role, ["admin", "super_admin"]))
    .limit(1);
  return !!row;
}

/** Constant-time compare so the operator secret can't be probed a byte at a time. */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * GET /v1/setup/state — public.
 * The dashboard calls this before showing a login box: an un-set-up server
 * shows the install wizard instead. It deliberately says nothing about the
 * operator console, whether one exists, or how to reach it.
 *
 * A server that already has an administrator is set up even without a
 * school_setup row — that is the Windows desktop build, which bootstraps its
 * own admin from the installer (lib/k9-bootstrap.ts) — so it must not be sent
 * to a wizard whose first action would be refused.
 */
router.get("/v1/setup/state", async (_req, res) => {
  const setup = await loadSetup();
  const [tenant] = await db
    .select({ name: tenantsTable.name })
    .from(tenantsTable)
    .orderBy(tenantsTable.id)
    .limit(1);
  res.json({
    needs_setup: !setup?.completed_at && !(await hasStaffAccount()),
    school_name: setup?.school_name ?? tenant?.name ?? null,
  });
});

/**
 * POST /v1/setup/school — public, once.
 * Body: { school_name, setup_password, admin_email, admin_password, admin_name?, region?, motto? }
 *
 * Creates the tenant, the school_setup row and the school's first
 * administrator, in one transaction. Refused the moment a setup row exists or
 * any admin account already does — re-running install on a live school server
 * would otherwise be a free account.
 */
router.post("/v1/setup/school", setupLimiter, async (req, res) => {
  if (await loadSetup()) {
    res.status(409).json({ error: "This server is already set up." });
    return;
  }
  if (await hasStaffAccount()) {
    res.status(409).json({ error: "This server already has an administrator." });
    return;
  }

  const schoolName = String(req.body?.school_name ?? "").trim();
  const setupPassword = String(req.body?.setup_password ?? "");
  const adminEmail = String(req.body?.admin_email ?? "").trim().toLowerCase();
  const adminPassword = String(req.body?.admin_password ?? "");
  const adminName = String(req.body?.admin_name ?? "").trim() || "School Administrator";
  const region = String(req.body?.region ?? "").trim() || "Tanzania";
  const motto = String(req.body?.motto ?? "").trim();

  if (schoolName.length < 3 || schoolName.length > 120) {
    res.status(400).json({ error: "School name must be 3-120 characters." });
    return;
  }
  if (setupPassword.length < MIN_PASSWORD) {
    res.status(400).json({ error: `Setup password must be at least ${MIN_PASSWORD} characters.` });
    return;
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
    res.status(400).json({ error: "Administrator email is not valid." });
    return;
  }
  if (adminPassword.length < MIN_PASSWORD) {
    res.status(400).json({ error: `Administrator password must be at least ${MIN_PASSWORD} characters.` });
    return;
  }

  const slug = slugify(schoolName);
  try {
    const created = await db.transaction(async (tx) => {
      let [tenant] = await tx.select().from(tenantsTable).where(eq(tenantsTable.slug, slug)).limit(1);
      if (!tenant) {
        [tenant] = await tx
          .insert(tenantsTable)
          .values({ slug, name: schoolName, region, license_key: generateLicenseKey() })
          .returning();
      }
      const [admin] = await tx
        .insert(usersTable)
        .values({
          // Always "admin". The install flow has no path to "super_admin".
          role: "admin",
          name: adminName,
          email: adminEmail,
          password_hash: hashPin(adminPassword),
        })
        .returning({ id: usersTable.id });
      const [setup] = await tx
        .insert(schoolSetupTable)
        .values({
          id: 1,
          school_name: schoolName,
          setup_password_hash: hashPin(setupPassword),
          tenant_id: tenant!.id,
          region,
          motto: motto || null,
          completed_at: new Date(),
          completed_by: admin!.id,
        })
        .returning();
      return { tenant: tenant!, setup: setup! };
    });

    logger.info({ school: schoolName, slug }, "school setup completed");
    res.status(201).json({
      ok: true,
      school_name: created.setup.school_name,
      // The licence key is what links this server to central. The installer
      // shows it once so the school can write it down; it is masked everywhere
      // else in the school-facing UI.
      license_key: created.tenant.license_key,
      next: "Sign in as the administrator, then print teacher QR codes.",
    });
  } catch (err) {
    if (String((err as { code?: string })?.code) === "23505") {
      res.status(409).json({ error: "That email or school is already registered." });
      return;
    }
    logger.error({ err }, "school setup failed");
    res.status(500).json({ error: "Setup failed." });
  }
});

/**
 * POST /v1/setup/operator/unlock — only exists when K9_OPERATOR_SECRET is set.
 * Body: { operator_secret, setup_password, email, password, name? }
 *
 * Mints (or promotes) the operator account for this server. Needs BOTH the
 * secret that was baked into the environment AND the school's setup password,
 * so neither a leaked environment file nor someone standing at the school's
 * keyboard is enough on its own.
 *
 * Without the environment variable this route answers 404 — identical to a
 * route that was never mounted, which is exactly what a school install should
 * see.
 */
router.post("/v1/setup/operator/unlock", setupLimiter, async (req, res) => {
  const expected = process.env["K9_OPERATOR_SECRET"];
  if (!expected) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const presented = String(req.body?.operator_secret ?? "");
  const setup = await loadSetup();
  if (!setup) {
    res.status(409).json({ error: "Set the school up first." });
    return;
  }
  if (!secretMatches(presented, expected) || !checkPin(String(req.body?.setup_password ?? ""), setup.setup_password_hash)) {
    logger.warn({ ip: req.ip }, "operator unlock refused");
    res.status(403).json({ error: "Refused." });
    return;
  }

  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const name = String(req.body?.name ?? "").trim() || "KobeAI Operator";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < MIN_PASSWORD) {
    res.status(400).json({ error: "A valid email and an 8+ character password are required." });
    return;
  }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (existing) {
    await db
      .update(usersTable)
      .set({ role: "super_admin", password_hash: hashPin(password), name })
      .where(eq(usersTable.id, existing.id));
  } else {
    await db
      .insert(usersTable)
      .values({ role: "super_admin", name, email, password_hash: hashPin(password) });
  }
  logger.warn({ email }, "operator account unlocked");
  res.json({ ok: true, email });
});

/**
 * GET /v1/me/capabilities — what this signed-in user may see.
 *
 * The dashboard builds its navigation from this instead of hard-coding a nav
 * list, which is why a teacher no longer sees "Central Admin" sitting in the
 * sidebar taunting them with a 403.
 */
router.get("/v1/me/capabilities", requireAuth(), async (req, res) => {
  const role = req.auth!.role;
  const setup = await loadSetup();
  const [tenant] = await db
    .select({ name: tenantsTable.name })
    .from(tenantsTable)
    .orderBy(tenantsTable.id)
    .limit(1);
  const operator = role === "super_admin";
  const schoolAdmin = operator || role === "admin";
  res.json({
    role,
    name: req.auth!.name ?? null,
    school_name: setup?.school_name ?? tenant?.name ?? null,
    setup_complete: !!setup?.completed_at,
    capabilities: {
      // School-side
      teaching: schoolAdmin || role === "teacher",
      bursar: schoolAdmin,
      onboarding: schoolAdmin,
      school_settings: schoolAdmin,
      // Operator-side — KobepayTech only.
      operator,
      tenants: operator,
      market_agent: operator,
      kp_economy: operator,
      moderation: operator,
      central_stationery: operator,
    },
  });
});

/**
 * GET /v1/setup/school — the school's own record, for the settings page.
 * Never returns the setup password hash.
 */
router.get("/v1/setup/school", requireAuth(["admin", "super_admin"]), async (_req, res) => {
  const setup = await loadSetup();
  if (!setup) {
    res.status(404).json({ error: "not set up" });
    return;
  }
  const { setup_password_hash: _hash, ...safe } = setup;
  const [counts] = await db
    .select({
      students: sql<number>`count(*) FILTER (WHERE role = 'student')::int`,
      teachers: sql<number>`count(*) FILTER (WHERE role = 'teacher')::int`,
    })
    .from(usersTable);
  res.json({ school: safe, counts: counts ?? { students: 0, teachers: 0 } });
});

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "school";
}

export default router;
