import { db, schoolSetupTable, tenantsTable, usersTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { generateLicenseKey } from "./license";
import { logger } from "./logger";
import { hashPin } from "./seed";

/**
 * First-boot setup for a K9 desktop school server: one tenant row for this
 * school and one administrator account. It replaces the demo seeds, whose
 * well-known passwords must never exist on a real school server.
 *
 * Env (set by the desktop shell):
 *   K9_SCHOOL_NAME     tenant display name (default "My School")
 *   K9_ADMIN_EMAIL     first administrator login
 *   K9_ADMIN_PASSWORD  its password — only used while no admin exists yet
 *   K9_SETUP_PASSWORD  break-glass setup password (defaults to the admin one)
 *
 * The account it creates is role "admin" — the school's own administrator.
 * Like the web install wizard (routes/setup.ts), this path has no way to
 * create a `super_admin`: the operator console is unlocked out-of-band with
 * K9_OPERATOR_SECRET and never ships with a school.
 */
export async function bootstrapK9School(port: number): Promise<void> {
  let [tenant] = await db.select().from(tenantsTable).orderBy(tenantsTable.id).limit(1);
  if (!tenant) {
    const name = process.env["K9_SCHOOL_NAME"]?.trim() || "My School";
    [tenant] = await db
      .insert(tenantsTable)
      .values({ slug: slugify(name), name, license_key: generateLicenseKey() })
      .returning();
    logger.info({ tenant_id: tenant!.id }, "K9 school tenant created");
  }

  // Point the local sync agent at this server's own central API, as the demo
  // boot does, so subscription caching works without a separate central host.
  process.env["CENTRAL_BASE_URL"] ??= `http://127.0.0.1:${port}`;
  process.env["TENANT_LICENSE_KEY"] ??= tenant!.license_key;

  const email = process.env["K9_ADMIN_EMAIL"]?.trim();
  const password = process.env["K9_ADMIN_PASSWORD"];
  if (!email || !password) return;

  const [existingAdmin] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(inArray(usersTable.role, ["admin", "super_admin"]))
    .limit(1);
  if (existingAdmin) return;

  const [admin] = await db
    .insert(usersTable)
    .values({
      role: "admin",
      name: "School Administrator",
      email,
      password_hash: hashPin(password),
    })
    .returning({ id: usersTable.id });
  logger.info({ email }, "K9 administrator account created");

  // Record the same school_setup row the web wizard writes, so the desktop
  // build lands in the identical state: the dashboard shows the school's name,
  // and /v1/setup/state stops offering a wizard that would only be refused.
  await db
    .insert(schoolSetupTable)
    .values({
      id: 1,
      school_name: tenant!.name,
      setup_password_hash: hashPin(process.env["K9_SETUP_PASSWORD"] || password),
      tenant_id: tenant!.id,
      completed_at: new Date(),
      completed_by: admin?.id ?? null,
    })
    .onConflictDoNothing();
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "school";
}
