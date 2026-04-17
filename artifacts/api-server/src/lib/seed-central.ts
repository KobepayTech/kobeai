import { db, tenantsTable, studentSubscriptionsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { generateLicenseKey } from "./license";
import { logger } from "./logger";
import crypto from "node:crypto";

function hashPin(pin: string): string {
  return crypto.createHash("sha256").update(pin).digest("hex");
}

/**
 * Idempotent demo seed for the multi-tenant control plane. Creates:
 *   - 3 demo schools (tenants), one of which is "this" school
 *   - A handful of subscriptions on tenant #1 so the central admin UI has
 *     real rows to manage and the local sync has data to cache.
 *
 * Returns the license key for tenant #1 so the boot sequence can wire the
 * local sync module against it without the operator having to set env vars
 * for the demo.
 */
export async function seedCentralDemo(): Promise<{ thisTenantLicenseKey: string }> {
  // --- Super admin (separate from per-school admins) -----------------------
  // Only this account can reach the /central/v1/admin/* control plane.
  const existingSuper = (await db.select().from(usersTable).where(eq(usersTable.email, "superadmin@kobeai.tz")))[0];
  if (!existingSuper) {
    await db.insert(usersTable).values({
      role: "super_admin",
      name: "KobeAI Super Admin",
      email: "superadmin@kobeai.tz",
      password_hash: hashPin("super123"),
    });
    logger.info("seeded super admin");
  }

  const tenants = [
    {
      slug: "karatu-secondary",
      name: "Karatu Secondary School",
      region: "Arusha",
      plan: "pro",
      contact_email: "head@karatu.sc.tz",
      contact_phone: "+255 712 000 001",
      students_cap: 600,
    },
    {
      slug: "mwanza-tech-prep",
      name: "Mwanza Tech Prep",
      region: "Mwanza",
      plan: "standard",
      contact_email: "office@mwanzatech.tz",
      contact_phone: "+255 712 000 002",
      students_cap: 400,
    },
    {
      slug: "dodoma-academy",
      name: "Dodoma Academy",
      region: "Dodoma",
      plan: "trial",
      contact_email: "admin@dodomaacademy.tz",
      contact_phone: "+255 712 000 003",
      students_cap: 200,
    },
  ];

  let thisTenantLicenseKey = "";

  for (const t of tenants) {
    const existing = (await db.select().from(tenantsTable).where(eq(tenantsTable.slug, t.slug)))[0];
    if (existing) {
      if (t.slug === "karatu-secondary") thisTenantLicenseKey = existing.license_key;
      continue;
    }
    const license_key = generateLicenseKey();
    await db.insert(tenantsTable).values({ ...t, license_key });
    if (t.slug === "karatu-secondary") thisTenantLicenseKey = license_key;
    logger.info({ slug: t.slug }, "seeded tenant");
  }

  const [thisTenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.slug, "karatu-secondary"));
  if (!thisTenant) return { thisTenantLicenseKey };

  const demoSubs = [
    { student_code: "TEST001", student_name: "John Doe", plan: "premium", status: "active", monthly_price_tsh: 8000, parent_phone: "+255 712 345 678" },
    { student_code: "TEST002", student_name: "Mary Mwangi", plan: "basic", status: "active", monthly_price_tsh: 5000, parent_phone: "+255 712 345 679" },
    { student_code: "TEST003", student_name: "Asha Juma", plan: "basic", status: "grace", monthly_price_tsh: 5000, parent_phone: "+255 712 345 680" },
    { student_code: "TEST004", student_name: "Ibrahim Ali", plan: "trial", status: "trial", monthly_price_tsh: 0, parent_phone: "+255 712 345 681" },
    { student_code: "TEST005", student_name: "Neema Hassan", plan: "basic", status: "expired", monthly_price_tsh: 5000, parent_phone: "+255 712 345 682" },
  ];

  for (const s of demoSubs) {
    const existing = (
      await db
        .select()
        .from(studentSubscriptionsTable)
        .where(eq(studentSubscriptionsTable.student_code, s.student_code))
    )[0];
    if (existing) continue;
    const expires = s.status === "active" ? new Date(Date.now() + 30 * 24 * 3600 * 1000) : s.status === "trial" ? new Date(Date.now() + 7 * 24 * 3600 * 1000) : s.status === "grace" ? new Date(Date.now() + 7 * 24 * 3600 * 1000) : new Date(Date.now() - 7 * 24 * 3600 * 1000);
    await db.insert(studentSubscriptionsTable).values({
      tenant_id: thisTenant.id,
      ...s,
      expires_at: expires,
      last_payment_at: s.status === "active" ? new Date(Date.now() - 5 * 24 * 3600 * 1000) : null,
    });
  }

  return { thisTenantLicenseKey };
}
