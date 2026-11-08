// Integration tests against a real Postgres.
//
//   createdb k9test
//   K9_TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/k9test \
//     pnpm --filter @workspace/db run push --force
//   K9_TEST_DATABASE_URL=... node --import tsx --test \
//     artifacts/api-server/src/lib/db-integration.test.ts
//
// Everything else in this suite runs the arithmetic with no database. These
// exercise the SQL — the transactions, the partial unique indexes, the interval
// casts and the ON CONFLICT clauses — because none of that is typechecked and
// all of it fails at 8am on a school day rather than in CI.
//
// Skipped, not failed, when K9_TEST_DATABASE_URL is absent.

import assert from "node:assert/strict";
import { before, after, describe, test } from "node:test";

const DB = process.env["K9_TEST_DATABASE_URL"];
process.env["DATABASE_URL"] ??= DB ?? "postgres://test:test@127.0.0.1:5432/unused";

type Db = typeof import("@workspace/db");
type Identity = typeof import("./voice-identity");
type Engine = typeof import("./skill-engine");
let db: Db;
let identity: Identity;
let engine: Engine;
let classId = 0;
const students: number[] = [];

/**
 * One child's voice, sampled.
 *
 * Enrolment samples are the *same* voice recorded at different distances and
 * moods, so they must be near each other in embedding space. A fixture of
 * unrelated random vectors would build a centroid that points nowhere and
 * matches nothing — which is a broken fixture, not a broken gate.
 */
const voice = (child: number, take = 0) =>
  Array.from({ length: 8 }, (_, i) => Math.sin(child * 3.7 * (i + 1)) + take * 0.04 * Math.cos(i));

describe("database integration", { skip: DB ? false : "set K9_TEST_DATABASE_URL to run" }, () => {
  before(async () => {
    db = await import("@workspace/db");
    identity = await import("./voice-identity");
    engine = await import("./skill-engine");
    const { rows } = await db.pool.query(
      `INSERT INTO classes (name, grade) VALUES ('Integration 2A','Form 2') RETURNING id`,
    );
    classId = rows[0].id;
    for (const code of ["IT-001", "IT-002", "IT-003"]) {
      const created = await db.pool.query(
        `INSERT INTO users (name, role, student_code) VALUES ($1,'student',$2) RETURNING id`,
        [`Pupil ${code}`, code],
      );
      students.push(created.rows[0].id);
      await db.pool.query(
        `INSERT INTO class_memberships (class_id, student_id) VALUES ($1,$2)`,
        [classId, created.rows[0].id],
      );
    }
  });

  after(async () => {
    if (!DB) return;
    // Clean up rows this suite created that nothing cascades to. An
    // unattributed question has no student to cascade from, and `class_id` is
    // ON DELETE SET NULL rather than CASCADE — deliberately, because the
    // evidence outlives a class being renamed — so it survives both deletes and
    // would poison the next run's ON CONFLICT (insight_id).
    await db.pool.query(`DELETE FROM classroom_skill_questions WHERE insight_id BETWEEN 987650 AND 987659`);
    await db.pool.query(`DELETE FROM users WHERE student_code LIKE 'IT-%'`);
    await db.pool.query(`DELETE FROM classes WHERE name = 'Integration 2A'`);
    await db.pool.end();
  });

  test("enrolment writes a profile, its samples and its audit row in one transaction", async () => {
    const result = await identity.enroll({
      studentId: students[0]!,
      studentCode: "IT-001",
      classId,
      samples: [0, 1, 2].map((n) => ({ embedding: voice(1, n), seconds: 3, prompt: `prompt ${n}` })),
      model: "titanet-large",
      modelRevision: "r1",
      consentReference: "FORM-001",
      consentBy: "Head of school",
      enrolledBy: null,
      retentionDays: 400,
    });
    assert.equal(result.sampleCount, 3);
    assert.equal(result.dims, 8);
    assert.equal(result.replaced, false);
    const samples = await db.pool.query(
      `SELECT COUNT(*)::int AS n FROM voice_enrollment_samples WHERE profile_id = $1`,
      [result.profileId],
    );
    assert.equal(samples.rows[0].n, 3);
    const audit = await db.pool.query(
      `SELECT action FROM voice_audit WHERE student_code='IT-001' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(audit.rows[0].action, "enrolled");
  });

  test("re-enrolment replaces, so one child never has two centroids", async () => {
    const again = await identity.enroll({
      studentId: students[0]!,
      studentCode: "IT-001",
      classId,
      samples: [0, 1, 2, 3].map((n) => ({ embedding: voice(1, n) })),
      model: "titanet-large",
      modelRevision: "r2",
      consentReference: "FORM-001b",
      consentBy: "Head of school",
      enrolledBy: null,
      retentionDays: 400,
    });
    assert.equal(again.replaced, true);
    const { rows } = await db.pool.query(
      `SELECT COUNT(*)::int AS n FROM voice_profiles WHERE student_code='IT-001'`,
    );
    assert.equal(rows[0].n, 1, "identification would depend on which row was read first");
  });

  test("the database refuses a profile with no consent reference", async () => {
    // Not the route's validation — the column. A future code path cannot get
    // around it.
    await assert.rejects(
      db.pool.query(
        `INSERT INTO voice_profiles (student_id, student_code, embedding, dims, sample_count,
           model, model_revision, consent_reference, consent_recorded_at, consent_by, expires_at)
         VALUES ($1,'IT-003','[]'::jsonb,8,3,'m','r',NULL,now(),'x',now()+interval '1 day')`,
        [students[2]!],
      ),
    );
  });

  test("the roster is scoped to the class and excludes expired profiles in the query", async () => {
    await identity.enroll({
      studentId: students[1]!,
      studentCode: "IT-002",
      classId,
      samples: [0, 1, 2].map((n) => ({ embedding: voice(2, n) })),
      model: "titanet-large",
      modelRevision: "r1",
      consentReference: "FORM-002",
      consentBy: "Head of school",
      enrolledBy: null,
      retentionDays: 400,
    });
    const roster = await identity.rosterFor(classId, "titanet-large");
    assert.equal(roster.size, 2);
    // A fresh utterance from the same child: near their own samples, nowhere
    // near the other child's.
    const decision = identity.identify(voice(1, 3), roster, 0.62, 0.12);
    assert.equal(
      decision.student_code,
      "IT-001",
      `the enrolled centroid should match its own voice (got ${JSON.stringify(
        identity.rank(voice(1, 3), roster),
      )})`,
    );

    await db.pool.query(
      `UPDATE voice_profiles SET expires_at = now() - interval '1 day' WHERE student_code='IT-002'`,
    );
    const live = await identity.rosterFor(classId, "titanet-large");
    assert.equal(live.has("IT-002"), false, "an expired profile must not take part in a decision");
  });

  test("the retention sweep deletes, and the audit row outlives the profile", async () => {
    const swept = await identity.sweepExpired();
    assert.ok(swept >= 1);
    const { rows } = await db.pool.query(
      `SELECT action FROM voice_audit WHERE student_code='IT-002' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(rows[0].action, "expired");
    const gone = await db.pool.query(
      `SELECT COUNT(*)::int AS n FROM voice_profiles WHERE student_code='IT-002'`,
    );
    assert.equal(gone.rows[0].n, 0);
  });

  test("a classroom question is recorded once, however often it is re-ingested", async () => {
    const first = await engine.ingestClassroomQuestion({
      studentId: students[0]!,
      classId,
      subject: "Mathematics",
      periodId: null,
      questionText: "why does minus times minus become plus?",
      insightId: 987_654,
    });
    assert.ok(first);
    const repeat = await engine.ingestClassroomQuestion({
      studentId: students[0]!,
      classId,
      subject: "Mathematics",
      periodId: null,
      questionText: "why does minus times minus become plus?",
      insightId: 987_654,
    });
    assert.equal(repeat, null, "the partial unique index must stop a double count");
  });

  test("an unattributed question still counts for the class", async () => {
    await engine.ingestClassroomQuestion({
      studentId: null,
      classId,
      subject: "Mathematics",
      periodId: null,
      questionText: "how do we eliminate the y?",
      insightId: 987_655,
    });
    const demand = await engine.classSkillDemand(classId, 7, 10);
    assert.ok(demand.length >= 1);
    const total = demand.reduce((sum, row) => sum + row.questions, 0);
    assert.ok(total >= 2, "a question with no name attached still counts");
  });

  test("recent question counts come back keyed by skill", async () => {
    const counts = await engine.recentQuestionCounts(students[0]!);
    assert.ok(counts instanceof Map);
  });
});
