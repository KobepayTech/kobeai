// ===========================================================================
// Two gates, not one.
//
//   speaker embedding
//         │
//   GATE 1 · IDENTITY      "who is probably speaking?"
//         │                 → answer the child as themselves
//         │
//   GATE 2 · ATTRIBUTION   "is this good enough to write to their
//         │                  permanent learning profile — forever?"
//         │
//   attributable / personalised / anonymous
//
// These are different questions with different costs of being wrong.
//
// Calling Amani by the wrong name for one turn is embarrassing and self-
// correcting: she says so, or the moment passes. Writing a misconception onto
// the wrong child's permanent record is silent, compounds over a term, and
// surfaces as a teacher planning a lesson around a weakness the child never
// had. So the second gate is strictly harder to pass than the first, and
// failing it is normal rather than exceptional.
//
// This is a rule of the system, not a setting. There is no configuration that
// lets voice alone write to a profile without a recorded measurement first.
// ===========================================================================

/** How we came to believe we know who this is, in descending authority. */
export const IDENTITY_SOURCES = [
  /** An authenticated session on the child's own tablet. */
  "tablet_session",
  /** A teacher named the student. */
  "teacher_confirmed",
  /** A student scanned in or was selected on a shared device. */
  "device_session",
  /** Camera recognised the face. */
  "face",
  /** Voice, corroborated by an independent signal (face, seat, direction). */
  "voice_corroborated",
  /** Voice alone, from a shared classroom microphone. */
  "voice",
  /** Nobody. */
  "none",
] as const;
export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

/**
 * Sources that are authoritative on their own.
 *
 * A tablet session is not a guess. Amani signed in; the session is the
 * identity. Running voice recognition over a tablet interaction because we can
 * would replace a certainty with an inference — strictly worse, and it puts a
 * child's biometrics in the loop for no gain.
 */
const AUTHORITATIVE: ReadonlySet<IdentitySource> = new Set<IdentitySource>([
  "tablet_session",
  "teacher_confirmed",
  "device_session",
]);

export type Outcome = "attributable" | "personalised" | "anonymous";

export type IdentityClaim = {
  student_code: string | null;
  source: IdentitySource;
  /** 0-100. Meaningless for authoritative sources, which are not inferences. */
  confidence?: number | null;
};

export type AttributionDecision = {
  outcome: Outcome;
  /** Who to answer as. Null only when the outcome is anonymous. */
  address_as: string | null;
  /** Who to write evidence against. Null unless attributable. */
  attribute_to: string | null;
  source: IdentitySource;
  confidence: number | null;
  reason: string;
};

/**
 * Enough to carry on a conversation as this child.
 *
 * Lower than the attribution bar on purpose: getting this wrong costs one
 * awkward turn, and being too shy here means a classroom where KobeAI keeps
 * saying "sorry, who is that?" — which is the failure that gets a feature
 * switched off.
 */
export const IDENTITY_MIN_CONFIDENCE = 62;

/**
 * Enough to write to a permanent record.
 *
 * Deliberately far above the identity bar. Threshold choice is a trade between
 * false acceptance and false rejection, and here the two are not symmetric:
 * a false rejection costs one anonymous event, a false acceptance corrupts a
 * child's profile silently. Open-set speaker identification also has to be able
 * to answer "none of these", which is what `anonymous` is for.
 */
export const ATTRIBUTION_MIN_CONFIDENCE = 85;

/** Voice corroborated by a second signal still has to clear a high bar. */
export const CORROBORATED_MIN_CONFIDENCE = 78;

export type Options = {
  /**
   * Whether this school has recorded a speaker-identification measurement and
   * chosen to trust voice alone for permanent attribution.
   *
   * Defaults to false and should stay false until `measure_speaker_id.py` has
   * been run on that school's own class — see docs/K9_VOICE_IDENTITY.md.
   * Classroom diarization on spontaneous, noisy, overlapping speech is
   * genuinely hard, and a school that has not measured its own rooms has no
   * basis for letting a microphone write to a child's record.
   */
  voiceAttributionMeasured?: boolean;
};

/**
 * Gate 2. Given who we think is speaking, decide what may be done about it.
 */
export function decideAttribution(
  claim: IdentityClaim,
  options: Options = {},
): AttributionDecision {
  const confidence =
    claim.confidence == null ? null : Math.max(0, Math.min(100, Math.round(claim.confidence)));

  const anonymous = (reason: string): AttributionDecision => ({
    outcome: "anonymous",
    address_as: null,
    attribute_to: null,
    source: claim.source,
    confidence,
    reason,
  });

  if (!claim.student_code || claim.source === "none") return anonymous("no_candidate");

  if (AUTHORITATIVE.has(claim.source)) {
    // Not an inference, so no threshold applies. The session *is* the identity.
    return {
      outcome: "attributable",
      address_as: claim.student_code,
      attribute_to: claim.student_code,
      source: claim.source,
      confidence,
      reason: `${claim.source}_is_authoritative`,
    };
  }

  if (confidence == null) return anonymous("inferred_identity_without_confidence");
  if (confidence < IDENTITY_MIN_CONFIDENCE) return anonymous("below_identity_gate");

  const personalised = (reason: string): AttributionDecision => ({
    outcome: "personalised",
    address_as: claim.student_code,
    attribute_to: null,
    source: claim.source,
    confidence,
    reason,
  });

  if (claim.source === "voice" && !options.voiceAttributionMeasured)
    // The rule the whole design turns on. A school that has not measured its
    // own classrooms cannot opt into voice-only attribution, however confident
    // a single utterance happens to look.
    return personalised("voice_attribution_requires_measurement");

  const bar =
    claim.source === "voice_corroborated" ? CORROBORATED_MIN_CONFIDENCE : ATTRIBUTION_MIN_CONFIDENCE;
  if (confidence < bar) return personalised("below_attribution_gate");

  return {
    outcome: "attributable",
    address_as: claim.student_code,
    attribute_to: claim.student_code,
    source: claim.source,
    confidence,
    reason: "above_attribution_gate",
  };
}

/**
 * Turn the voice gate's own output into an identity claim.
 *
 * `identify()` already refuses on score and margin; this maps what survives
 * into the vocabulary the attribution gate speaks. `corroborated` is set by the
 * caller when a second, independent signal agreed — a face, a seat, or the
 * microphone array's direction of arrival.
 */
export function claimFromVoice(
  identification: { student_code: string | null; accepted: boolean; top: { score: number } | null },
  corroborated = false,
): IdentityClaim {
  if (!identification.accepted || !identification.student_code)
    return { student_code: null, source: "none", confidence: null };
  return {
    student_code: identification.student_code,
    source: corroborated ? "voice_corroborated" : "voice",
    confidence: Math.round((identification.top?.score ?? 0) * 100),
  };
}
