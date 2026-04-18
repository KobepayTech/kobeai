// Seed the master stationery catalog + the demo parent + an open drive +
// a claim code for TEST001 -> Grace Mwangi. Idempotent.

import {
  db,
  stationeryItemsTable,
  stationeryDrivesTable,
  usersTable,
  parentChildrenTable,
  claimCodesTable,
  tenantsTable,
} from "@workspace/db";
import { eq, and, isNull, gt } from "drizzle-orm";
import { generateClaimCode, hashCode, schoolPrefix } from "./claim-codes";

// (name, category, default_price_tsh)
// Prices are rough Tanzania-market 2026 estimates — super-admin tunes via UI.
const CATALOG: Array<[string, string, number, string?]> = [
  ["Blue pens", "Pens", 500],
  ["Black pens", "Pens", 500],
  ["Red pens", "Pens", 500],
  ["Pencils HB", "Pencils", 400],
  ["Pencils 2B", "Pencils", 500],
  ["Mechanical pencils", "Pencils", 2500],
  ["Markers", "Pens", 1500],
  ["Highlighters", "Pens", 1800],
  ["Exercise books (counter books)", "Books", 1500],
  ["Notebooks ruled", "Books", 1200],
  ["Notebooks unruled", "Books", 1200],
  ["Long books", "Books", 2500],
  ["Loose A4 papers", "Paper", 12000, "ream"],
  ["Sketchbooks", "Books", 3500],
  ["Ruler 30 cm", "Tools", 1000],
  ["Geometry set", "Tools", 6500],
  ["Scientific calculator", "Tools", 28000],
  ["Eraser", "Tools", 500],
  ["Pencil sharpener", "Tools", 800],
  ["Pencil case", "Storage", 4500],
  ["School bag", "Storage", 35000],
  ["Files", "Storage", 1500],
  ["Folders", "Storage", 2500],
  ["Binders", "Storage", 5500],
  ["Clipboards", "Storage", 3500],
  ["Sticky notes", "Paper", 2200],
  ["Index tabs", "Paper", 1800],
  ["Colour pencils", "Art", 6500, "pack"],
  ["Crayons", "Art", 4500, "pack"],
  ["Paints", "Art", 8500, "pack"],
  ["Drawing pencils", "Art", 3500, "pack"],
  ["Glue stick", "Art", 1500],
  ["Scissors", "Tools", 2500],
  ["Stapler", "Tools", 6000],
  ["Paper clips", "Tools", 2000, "pack"],
  ["Tape", "Tools", 2500],
];

export async function seedStationeryDemo(): Promise<void> {
  // Catalog (insert if missing).
  for (const [name, category, price, unit] of CATALOG) {
    const exists = (
      await db.select().from(stationeryItemsTable).where(eq(stationeryItemsTable.name, name))
    )[0];
    if (!exists) {
      await db.insert(stationeryItemsTable).values({
        name,
        category,
        default_price_tsh: price,
        unit: unit ?? "each",
      });
    }
  }

  // Open drive (insert if no open drive exists).
  const openDrive = (
    await db.select().from(stationeryDrivesTable).where(eq(stationeryDrivesTable.status, "open"))
  )[0];
  if (!openDrive) {
    const closes = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000); // 3 weeks
    await db.insert(stationeryDrivesTable).values({
      title: "Term 2 Stationery — May 2026",
      description: "Term 2 starter pack and additional supplies.",
      status: "open",
      closes_at: closes,
    });
  }

  // Demo parent (Grace Mwangi).
  let parent = (
    await db.select().from(usersTable).where(eq(usersTable.email, "+255700000001"))
  )[0];
  if (!parent) {
    [parent] = await db
      .insert(usersTable)
      .values({
        role: "parent",
        name: "Grace Mwangi",
        email: "+255700000001",
      })
      .returning();
  }

  // Demo students - resolve TEST001
  const test001 = (
    await db.select().from(usersTable).where(eq(usersTable.student_code, "TEST001"))
  )[0];
  const tenant = (await db.select().from(tenantsTable).limit(1))[0];

  if (parent && test001 && tenant) {
    // Link Grace -> TEST001
    await db
      .insert(parentChildrenTable)
      .values({
        parent_user_id: parent.id,
        student_user_id: test001.id,
        tenant_id: tenant.id,
        nickname: "John",
      })
      .onConflictDoNothing();

    // Pre-issue a fresh claim code (only if no unconsumed, unexpired code
    // already exists for this student) so the demo "Add a child" UI always
    // has something to claim. Earlier wording matched ANY code which left
    // the demo unusable after the first claim.
    const now = new Date();
    const existingCode = (
      await db
        .select()
        .from(claimCodesTable)
        .where(
          and(
            eq(claimCodesTable.student_user_id, test001.id),
            isNull(claimCodesTable.consumed_at),
            gt(claimCodesTable.expires_at, now),
          ),
        )
        .limit(1)
    )[0];
    if (!existingCode) {
      const code = generateClaimCode(tenant.slug);
      await db.insert(claimCodesTable).values({
        code_hash: hashCode(code),
        code_prefix: schoolPrefix(tenant.slug),
        tenant_id: tenant.id,
        student_user_id: test001.id,
        expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      });
      // Log the demo code so it appears in server logs for testing.
      // eslint-disable-next-line no-console
      console.log(`[stationery seed] Demo claim code for TEST001: ${code}`);
    }
  }
}
