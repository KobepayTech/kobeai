// node --import tsx --test artifacts/api-server/src/lib/attribution.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ATTRIBUTION_MIN_CONFIDENCE,
  CORROBORATED_MIN_CONFIDENCE,
  IDENTITY_MIN_CONFIDENCE,
  claimFromVoice,
  decideAttribution,
} from "./attribution";
import { assess, assessSession } from "./evidence";

// ---------------------------------------------------------------------------
// The rule the whole design turns on.
// ---------------------------------------------------------------------------

test("the attribution gate is strictly harder than the identity gate", () => {
  // If these ever converge, the two-gate design has collapsed into one gate and
  // a misidentified child starts acquiring someone else's learning profile.
  assert.ok(ATTRIBUTION_MIN_CONFIDENCE > IDENTITY_MIN_CONFIDENCE);
  assert.ok(CORROBORATED_MIN_CONFIDENCE > IDENTITY_MIN_CONFIDENCE);
  assert.ok(CORROBORATED_MIN_CONFIDENCE < ATTRIBUTION_MIN_CONFIDENCE);
});

test("voice alone never writes to a profile until the school has measured", () => {
  // Not a setting a hurried admin can flip: with no recorded measurement, even
  // a 99% match is answered personally and written anonymously.
  const decision = decideAttribution({ student_code: "K9-001", source: "voice", confidence: 99 });
  assert.equal(decision.outcome, "personalised");
  assert.equal(decision.address_as, "K9-001", "she is still answered as herself");
  assert.equal(decision.attribute_to, null, "but nothing reaches her record");
  assert.equal(decision.reason, "voice_attribution_requires_measurement");
});

test("a measured school can attribute confident voice, and still not weak voice", () => {
  const measured = { voiceAttributionMeasured: true };
  const strong = decideAttribution(
    { student_code: "K9-001", source: "voice", confidence: ATTRIBUTION_MIN_CONFIDENCE },
    measured,
  );
  assert.equal(strong.outcome, "attributable");
  const weak = decideAttribution(
    { student_code: "K9-001", source: "voice", confidence: ATTRIBUTION_MIN_CONFIDENCE - 1 },
    measured,
  );
  assert.equal(weak.outcome, "personalised");
  assert.equal(weak.attribute_to, null);
});

test("the three outcomes are the three the design calls for", () => {
  // IDENTIFIED + ATTRIBUTABLE
  const tablet = decideAttribution({ student_code: "K9-001", source: "tablet_session" });
  assert.equal(tablet.outcome, "attributable");
  assert.equal(tablet.attribute_to, "K9-001");

  // IDENTIFIED + NOT ATTRIBUTABLE — 91% is the worked example: confident enough
  // to carry on as Amani, not confident enough to write to her record.
  const voice = decideAttribution({ student_code: "K9-001", source: "voice", confidence: 91 });
  assert.equal(voice.outcome, "personalised");
  assert.equal(voice.address_as, "K9-001");
  assert.equal(voice.attribute_to, null);

  // UNKNOWN
  const unknown = decideAttribution({ student_code: null, source: "none" });
  assert.equal(unknown.outcome, "anonymous");
  assert.equal(unknown.address_as, null);
});

test("a tablet session needs no confidence score, because it is not a guess", () => {
  // Running voice recognition over an authenticated session would replace a
  // certainty with an inference, and put a child's biometrics in the loop for
  // no gain.
  const decision = decideAttribution({ student_code: "K9-001", source: "tablet_session" });
  assert.equal(decision.outcome, "attributable");
  assert.equal(decision.reason, "tablet_session_is_authoritative");
});

test("a teacher naming a student is authoritative too", () => {
  assert.equal(
    decideAttribution({ student_code: "K9-001", source: "teacher_confirmed" }).outcome,
    "attributable",
  );
});

test("corroborated voice clears a lower bar than voice alone, without measurement", () => {
  // An independent second signal — a face, a seat, the mic array's direction —
  // is not the same kind of evidence as a second look at the same audio.
  const decision = decideAttribution({
    student_code: "K9-001",
    source: "voice_corroborated",
    confidence: CORROBORATED_MIN_CONFIDENCE,
  });
  assert.equal(decision.outcome, "attributable");
});

test("an inferred identity with no confidence figure is refused, not assumed", () => {
  const decision = decideAttribution({ student_code: "K9-001", source: "face" });
  assert.equal(decision.outcome, "anonymous");
  assert.equal(decision.reason, "inferred_identity_without_confidence");
});

test("below the identity gate nobody is addressed by name", () => {
  const decision = decideAttribution({
    student_code: "K9-001",
    source: "voice",
    confidence: IDENTITY_MIN_CONFIDENCE - 1,
  });
  assert.equal(decision.outcome, "anonymous");
  assert.equal(decision.address_as, null);
});

test("a refused voice identification becomes an open-set 'none of these'", () => {
  const claim = claimFromVoice({ student_code: null, accepted: false, top: { score: 0.95 } });
  assert.equal(claim.source, "none");
  assert.equal(decideAttribution(claim).outcome, "anonymous");
});

test("corroboration is the caller's to assert, and changes the source", () => {
  const raw = { student_code: "K9-001", accepted: true, top: { score: 0.88 } };
  assert.equal(claimFromVoice(raw).source, "voice");
  assert.equal(claimFromVoice(raw, true).source, "voice_corroborated");
  assert.equal(claimFromVoice(raw).confidence, 88);
});

// ---------------------------------------------------------------------------
// Evidence: what may move mastery
// ---------------------------------------------------------------------------

test("asking, being explained to, and taking a hint never move mastery", () => {
  for (const kind of ["question", "explanation_requested", "hint_accepted", "guided_attempt"] as const) {
    const verdict = assess({ kind });
    assert.equal(verdict.moves_mastery, false, `${kind} must not move mastery`);
    assert.equal(verdict.record, true, `${kind} is still worth recording`);
  }
});

test("saying you understood is a signal, not a measurement", () => {
  assert.equal(assess({ kind: "self_reported_understanding" }).moves_mastery, false);
});

test("an unaided diagnostic, quiz, exam or marked paper moves mastery", () => {
  for (const kind of ["diagnostic", "quiz", "exam", "teacher_marked", "independent_attempt"] as const) {
    assert.equal(assess({ kind, correct: true }).moves_mastery, true, `${kind} should count`);
  }
});

test("a hinted correct answer measures the hint, not the child", () => {
  // Otherwise the more help K9 gives, the cleverer every child appears.
  assert.equal(assess({ kind: "diagnostic", correct: true, assisted: true }).moves_mastery, false);
  assert.equal(assess({ kind: "diagnostic", correct: true, assisted: true }).suggest_assessment, true);
});

test("a measurement with no recorded outcome moves nothing", () => {
  assert.equal(assess({ kind: "quiz", correct: null }).moves_mastery, false);
});

test("the worked example: wrong, hint, right — evidence yes, mastery no", () => {
  // Straight from the design note. A session that ends correct after a hint
  // feels like learning happened, and it did — it just is not evidence of what
  // the child can now do alone.
  const session = assessSession([
    { kind: "question" },
    { kind: "explanation_requested" },
    { kind: "guided_attempt", correct: false },
    { kind: "hint_accepted" },
    { kind: "independent_attempt", correct: true },
  ]);
  assert.equal(session.record, true, "Learning evidence: ADD");
  assert.equal(session.moves_mastery, false, "Mastery mutation: NO");
  assert.equal(session.suggest_assessment, true, "Recommended assessment: YES");
  assert.equal(session.reason, "whole_session_was_assisted");
});

test("an unaided session from start to finish does move mastery", () => {
  const session = assessSession([
    { kind: "question" },
    { kind: "diagnostic", correct: true },
  ]);
  assert.equal(session.moves_mastery, true);
  assert.equal(session.suggest_assessment, false);
});

test("an empty session records nothing rather than throwing", () => {
  assert.deepEqual(assessSession([]), {
    record: false,
    moves_mastery: false,
    suggest_assessment: false,
    reason: "empty",
  });
});
