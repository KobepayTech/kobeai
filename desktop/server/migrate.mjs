// Applies the Drizzle schema (lib/db) to the K9 database on every boot.
// scripts/build.mjs bundles this into build/server/migrate.cjs and
// electron/main.cjs runs it before starting the api-server.
//
// It diffs Drizzle snapshots instead of introspecting the live database: the
// snapshot applied last is stored in k9_schema_snapshots, and each boot applies
// generateMigration(previous, current). Tables the api-server creates at
// runtime with raw SQL therefore never enter the comparison, and drizzle-kit's
// pushSchema introspection (which drops query parameters for composite primary
// keys) is not used.
//
// Safety rules for a school server that updates itself:
//   - DROP TABLE / COLUMN / SCHEMA / TYPE / SEQUENCE / VIEW are skipped, so an
//     app update never deletes school data on its own;
//   - changes apply in one transaction with the new snapshot, so a failure
//     records nothing and the next boot retries;
//   - only a brand-new database must sync cleanly for K9 to boot.
import pg from "pg";
import { generateDrizzleJson, generateMigration, upPgSnapshot } from "drizzle-kit/api";
import * as schema from "../../lib/db/src/schema/index.ts";

const DESTRUCTIVE =
  /^\s*(DROP\s+(TABLE|SCHEMA|TYPE|SEQUENCE|VIEW|MATERIALIZED\s+VIEW)\b|ALTER\s+TABLE\s+.+\s+DROP\s+COLUMN\b)/is;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let freshDatabase = false;
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS k9_schema_snapshots (
        id serial PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        snapshot jsonb NOT NULL
      )
    `);
    const latest = (await client.query("SELECT snapshot FROM k9_schema_snapshots ORDER BY id DESC LIMIT 1")).rows[0];
    const usersExist = (await client.query("SELECT to_regclass('public.users') IS NOT NULL AS exists")).rows[0].exists;
    freshDatabase = !latest && !usersExist;

    const current = generateDrizzleJson(schema);
    const tableCount = Object.keys(current.tables).length;

    if (!latest && !freshDatabase) {
      // Tables exist but K9 never recorded a snapshot (e.g. a database made
      // with `drizzle-kit push`): adopt the current schema as the baseline.
      await client.query("INSERT INTO k9_schema_snapshots (snapshot) VALUES ($1)", [JSON.stringify(current)]);
      console.warn("[migrate] existing database without a K9 snapshot — recorded the current schema as the baseline");
      console.log(`[migrate] ${tableCount} tables checked: 0 statements applied, 0 destructive skipped, 0 failed`);
      return;
    }

    const previous = !latest
      ? generateDrizzleJson({})
      : latest.snapshot.version === current.version
        ? latest.snapshot
        : upPgSnapshot(latest.snapshot);
    const statements = await generateMigration(previous, current);

    const toApply = [];
    let skipped = 0;
    for (const statement of statements) {
      if (DESTRUCTIVE.test(statement)) {
        skipped++;
        console.warn(`[migrate] skipped destructive statement: ${statement}`);
      } else {
        toApply.push(statement);
      }
    }

    if (statements.length > 0) {
      await client.query("BEGIN");
      try {
        for (const statement of toApply) await client.query(statement);
        await client.query("INSERT INTO k9_schema_snapshots (snapshot) VALUES ($1)", [JSON.stringify(current)]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    }

    console.log(
      `[migrate] ${tableCount} tables checked: ${toApply.length} statements applied, ` +
      `${skipped} destructive skipped, 0 failed`,
    );
  } catch (err) {
    console.error("[migrate] schema sync failed:", err);
    if (freshDatabase) {
      process.exitCode = 1;
    } else {
      console.warn("[migrate] existing database — K9 starts with its current schema and retries on the next boot");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[migrate] fatal:", err);
  process.exit(1);
});
