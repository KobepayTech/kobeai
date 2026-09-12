// node --import tsx --test artifacts/api-server/src/lib/entitlements.test.ts
import assert from "node:assert/strict";
import { before, test } from "node:test";

process.env["DATABASE_URL"] ??= "postgres://test:test@127.0.0.1:5432/test";

type Ent = typeof import("./entitlements");
let ent: Ent;

before(async () => {
  ent = await import("./entitlements");
});

// ---------------------------------------------------------------------------
// The boundary itself. These are the tests that exist to stop the line moving
// quietly: a child's attendance, safety and school record are never for sale,
// and if someone tries to make them premium, this file fails.
// ---------------------------------------------------------------------------

test("attendance, safety and school records are baseline, never premium", () => {
  for (const feature of ["attendance", "presence", "safety", "identity", "results", "records", "exams", "timetable"]) {
    assert.ok(
      (ent.BASELINE_FEATURES as readonly string[]).includes(feature),
      `${feature} must stay in the baseline tier`,
    );
    assert.ok(
      !(ent.PREMIUM_FEATURES as readonly string[]).includes(feature),
      `${feature} must NEVER be sold — it is the school's record of its own pupil`,
    );
  }
});

test("the premium tier is the intelligence profile and nothing else", () => {
  assert.deepEqual(
    [...ent.PREMIUM_FEATURES],
    [
      "skill_profile",
      "exam_analysis",
      "recommendations",
      "longitudinal",
      "revision",
      "learning_plan",
      "parent_report_plus",
    ],
  );
});

test("no feature is in both tiers", () => {
  const baseline = new Set<string>(ent.BASELINE_FEATURES);
  for (const f of ent.PREMIUM_FEATURES) assert.ok(!baseline.has(f), `${f} is in both tiers`);
});

test("every premium feature has a label a teacher would recognise", () => {
  for (const f of ent.PREMIUM_FEATURES) {
    assert.ok(ent.FEATURE_LABELS[f]?.length > 3, `${f} has no label`);
  }
});

// ---------------------------------------------------------------------------
// The locked response
// ---------------------------------------------------------------------------

test("a locked response still tells the school what it keeps", () => {
  const payload = ent.lockedPayload("skill_profile", {
    student_code: "STU0007",
    entitled: false,
    status: "expired",
    expires_at: null,
    days_left: null,
    unenforced: false,
  });
  assert.equal(payload.entitled, false);
  assert.match(payload.message, /expired/);
  // The point: "K9 is hiding my child's results" must never be a fair
  // complaint, so a lock says out loud what is still there.
  const keeps = payload.still_available.join(" ").toLowerCase();
  assert.match(keeps, /attendance/);
  assert.match(keeps, /report card|marks/);
  assert.ok(payload.unlocks.length === ent.PREMIUM_FEATURES.length);
});

test("a student with no subscription reads as 'none', not as an error", () => {
  const payload = ent.lockedPayload("revision", {
    student_code: "STU0008",
    entitled: false,
    status: "none",
    expires_at: null,
    days_left: null,
    unenforced: false,
  });
  assert.match(payload.message, /no K9 learning subscription/i);
});

// ---------------------------------------------------------------------------
// Whose subscription is being checked
// ---------------------------------------------------------------------------

test("the subject is the student named in the path, not the teacher calling", () => {
  // A teacher's own account has nothing to do with whether a particular
  // child's profile is paid for — getting this backwards would gate every
  // student on whichever member of staff happened to open the page.
  const req = {
    params: { studentCode: "STU0007" },
    query: {},
    auth: { role: "teacher", user_id: 42, sub: "42" },
  };
  assert.equal(ent.subjectStudentCode(req as never), "STU0007");
});

test("a student calling about themselves needs no path parameter", () => {
  const req = { params: {}, query: {}, auth: { role: "student", user_id: 9, sub: "9", student_id: "STU0009" } };
  assert.equal(ent.subjectStudentCode(req as never), "STU0009");
});

test("the student code can also come from the query or the body", () => {
  assert.equal(
    ent.subjectStudentCode({ params: {}, query: { student_code: "STU0010" } } as never),
    "STU0010",
  );
  assert.equal(
    ent.subjectStudentCode({ params: {}, query: {}, body: { student_code: "STU0011" } } as never),
    "STU0011",
  );
});

test("a whole-school read names no student and is not gated here", () => {
  assert.equal(ent.subjectStudentCode({ params: {}, query: {} } as never), null);
});

// ---------------------------------------------------------------------------
// The enforcement switch
// ---------------------------------------------------------------------------

test("enforcement is off unless it is explicitly switched on", () => {
  const before = process.env["ENFORCE_SUBSCRIPTIONS"];
  try {
    delete process.env["ENFORCE_SUBSCRIPTIONS"];
    assert.equal(ent.enforcementOn(), false);
    process.env["ENFORCE_SUBSCRIPTIONS"] = "false";
    assert.equal(ent.enforcementOn(), false);
    // Anything other than the exact string is off, so a typo fails safe.
    process.env["ENFORCE_SUBSCRIPTIONS"] = "yes";
    assert.equal(ent.enforcementOn(), false);
    process.env["ENFORCE_SUBSCRIPTIONS"] = "true";
    assert.equal(ent.enforcementOn(), true);
  } finally {
    if (before === undefined) delete process.env["ENFORCE_SUBSCRIPTIONS"];
    else process.env["ENFORCE_SUBSCRIPTIONS"] = before;
  }
});
