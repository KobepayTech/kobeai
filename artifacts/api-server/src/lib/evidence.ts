// ===========================================================================
// What is allowed to move a mastery score.
//
// The skill engine already holds the line that a question never moves mastery
// (docs/K9_SKILL_ENGINE.md). This generalises it, because a tablet produces far
// more kinds of interaction than a marked paper does, and most of them look
// like evidence without being it.
//
// The distinction is **independence**, not source. A child who gets it wrong,
// takes a hint, and then gets it right has demonstrated that the hint worked —
// which is worth recording and worth nothing as a measure of what they can do
// alone. Counting it as mastery would mean the more help K9 gives, the cleverer
// every child appears, which is the precise failure that makes an AI tutor's
// numbers worthless.
// ===========================================================================

export const EVIDENCE_KINDS = [
  /** Asked about a topic. Says what they are thinking about, not what they can do. */
  "question",
  /** Asked for it to be explained again, or more simply. */
  "explanation_requested",
  /** Took a hint before answering. */
  "hint_accepted",
  /** An attempt made after a hint, or with K9 walking them through it. */
  "guided_attempt",
  /** Worked it out with no help this turn. */
  "independent_attempt",
  /** A question K9 set to test one skill, answered unaided. */
  "diagnostic",
  /** A quiz or class test. */
  "quiz",
  /** A sat exam. */
  "exam",
  /** A teacher marked it. The strongest evidence there is. */
  "teacher_marked",
  /** Said they understood. Self-report — useful signal, not a measurement. */
  "self_reported_understanding",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export type EvidenceEvent = {
  kind: EvidenceKind;
  /** Was help given before this attempt? A hinted correct answer is not mastery. */
  assisted?: boolean;
  correct?: boolean | null;
};

/**
 * Kinds that measure what a child can do unaided.
 *
 * Teacher-marked work is here because a teacher's mark already accounts for
 * whatever help was given — that judgement is theirs and K9 does not second-
 * guess it, which is the same rule the skill engine has always followed.
 */
const MEASURING_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>([
  "diagnostic",
  "quiz",
  "exam",
  "teacher_marked",
  "independent_attempt",
]);

export type Verdict = {
  /** Always true: every interaction is worth recording. */
  record: boolean;
  /** May this change a mastery score? */
  moves_mastery: boolean;
  /** Should K9 offer a diagnostic to turn this into a real measurement? */
  suggest_assessment: boolean;
  reason: string;
};

/**
 * Whether one interaction may move mastery.
 *
 * `assisted` overrides the kind. A diagnostic the child was walked through is
 * a guided attempt wearing a diagnostic's name.
 */
export function assess(event: EvidenceEvent): Verdict {
  const record = true;
  if (!MEASURING_KINDS.has(event.kind))
    return {
      record,
      moves_mastery: false,
      // A child who asked about a topic and took a hint is exactly who a short
      // diagnostic would tell us something real about.
      suggest_assessment: event.kind === "hint_accepted" || event.kind === "guided_attempt",
      reason: `${event.kind}_is_not_a_measurement`,
    };
  if (event.assisted)
    return {
      record,
      moves_mastery: false,
      suggest_assessment: true,
      reason: "assisted_attempt_measures_the_hint",
    };
  if (event.correct == null)
    return {
      record,
      moves_mastery: false,
      suggest_assessment: false,
      reason: "no_outcome_recorded",
    };
  return {
    record,
    moves_mastery: true,
    suggest_assessment: false,
    reason: "independent_demonstration",
  };
}

/**
 * A whole interaction — a child asking, being helped, and trying again.
 *
 * Reported as one verdict because that is how it should be read: the session as
 * a whole moves mastery only if some part of it was an unaided demonstration.
 * A sequence that ends in a correct answer after a hint does not qualify, and
 * this is the thing most likely to be got wrong by someone adding a feature
 * later, because the sequence *feels* like learning happened. It did — it just
 * is not evidence of what the child can now do alone.
 */
export function assessSession(events: EvidenceEvent[]): Verdict {
  if (events.length === 0)
    return { record: false, moves_mastery: false, suggest_assessment: false, reason: "empty" };
  const assisted = events.some((e) => e.kind === "hint_accepted" || e.assisted === true);
  const verdicts = events.map((event) =>
    assess(assisted ? { ...event, assisted: true } : event),
  );
  const moves = verdicts.some((v) => v.moves_mastery);
  return {
    record: true,
    moves_mastery: moves,
    suggest_assessment: !moves,
    reason: moves
      ? "independent_demonstration_in_session"
      : assisted
        ? "whole_session_was_assisted"
        : "no_measurement_in_session",
  };
}
