import assert from "node:assert/strict";
import { test } from "node:test";
// Optional hermetic PostgreSQL engine. No school database is used or modified.
// K9_TEST_PGLITE_PATH=/absolute/path/to/@electric-sql/pglite/dist/index.js
const modulePath = process.env.K9_TEST_PGLITE_PATH;
test(
  "PostgreSQL printing reservations, settlement and recovery",
  { skip: !modulePath },
  async () => {
    process.env.DATABASE_URL = "postgres://unused/test";
    const { PGlite } = await import(modulePath!);
    const pg = new PGlite();
    const { pool } = await import("@workspace/db");
    const oldQuery = pool.query,
      oldConnect = pool.connect;
    const query = async (sql: string, values?: unknown[]) =>
      values?.length
        ? pg.query(sql, values)
        : ((await pg.exec(sql)).at(-1) ?? { rows: [] });
    Object.assign(pool, {
      query,
      connect: async () => ({ query, release() {} }),
    });
    try {
      await pg.exec(
        `CREATE TABLE users(id INT PRIMARY KEY,name TEXT,role TEXT,student_code TEXT); CREATE TABLE classes(id INT PRIMARY KEY,grade TEXT,teacher_id INT); CREATE TABLE subscription_cache(student_code TEXT PRIMARY KEY,status TEXT,expires_at TIMESTAMPTZ); INSERT INTO users VALUES(1,'Asha','student','S1'),(2,'Teacher','admin',NULL); INSERT INTO classes VALUES(1,'Form 1',2);`,
      );
      const service = await import("./learning-packs");
      await service.ensureLearningPacks();
      await pg.exec(
        `INSERT INTO academic_terms(id,name,academic_year) VALUES(1,'Term 1','2026'); INSERT INTO result_exams(id,term_id,class_id,subject,title,kind,total_marks,status) VALUES(1,1,1,'Maths','Test','ca',10,'closed'); INSERT INTO learning_packs(exam_id,student_id,kind,sides,status) VALUES(1,1,'quick',2,'ready');`,
      );
      await service.reservePack(1);
      assert.equal(
        (await query("SELECT status FROM learning_packs")).rows[0].status,
        "subscription_required",
      );
      await pg.exec(
        `INSERT INTO subscription_cache VALUES('S1','active',NOW()+INTERVAL '1 day');`,
      );
      await service.reservePack(1);
      assert.equal(
        (await query("SELECT status FROM learning_packs")).rows[0].status,
        "awaiting_funds",
      );
      await pg.exec(
        "UPDATE print_cash_accounts SET balance_tsh=1000 WHERE student_id=1",
      );
      await service.reservePack(1);
      await service.reservePack(1);
      assert.deepEqual(
        (
          await query(
            "SELECT balance_tsh,reserved_tsh FROM print_cash_accounts",
          )
        ).rows[0],
        { balance_tsh: 1000, reserved_tsh: 200 },
      );
      await assert.rejects(service.settlePack(1, true, 2), /awaiting printer/);
      await pg.exec("UPDATE learning_packs SET status='submitted' WHERE id=1");
      await service.settlePack(1, true, 2);
      await service.settlePack(1, true, 2);
      assert.deepEqual(
        (
          await query(
            "SELECT balance_tsh,reserved_tsh FROM print_cash_accounts",
          )
        ).rows[0],
        { balance_tsh: 800, reserved_tsh: 0 },
      );
      assert.equal(
        (await query("SELECT * FROM print_cash_ledger")).rows.length,
        1,
      );
      await pg.exec(
        "INSERT INTO learning_packs(exam_id,student_id,kind,sides,status) VALUES(1,1,'extended',6,'ready')",
      );
      await service.reservePack(2);
      await service.settlePack(2, false, 2);
      await service.settlePack(2, false, 2);
      assert.deepEqual(
        (
          await query(
            "SELECT balance_tsh,reserved_tsh FROM print_cash_accounts",
          )
        ).rows[0],
        { balance_tsh: 800, reserved_tsh: 0 },
      );
      assert.equal(
        (await query("SELECT * FROM print_cash_ledger")).rows.length,
        1,
      );
    } finally {
      Object.assign(pool, { query: oldQuery, connect: oldConnect });
      await pg.close();
      await pool.end();
    }
  },
);
