// ===========================================================================
// What a child is told about their own learning.
//
// The engine works in numbers — 31% mastery, 62% confidence, a trend of -8 —
// because a teacher deciding what to reteach needs that resolution. A
// fourteen-year-old looking at their own profile does not, and showing it to
// them is worse than useless: "Acceleration 43.7%" reads as a score out of a
// hundred, invites comparison with the child at the next desk, and asserts a
// precision the evidence cannot support. A mastery figure built from four
// questions is not accurate to a decimal place, or to a whole number.
//
// So the student API sends a **band**, never a percentage. This is a server
// guarantee rather than a client convention: the tablet cannot render a number
// it was never given, and no future screen can leak one by accident.
// ===========================================================================

export const BANDS = ["starting", "learning", "practising", "strong"] as const;
export type Band = (typeof BANDS)[number];

export const BAND_LABELS: Record<Band, string> = {
  starting: "Starting",
  learning: "Learning",
  practising: "Practising",
  strong: "Strong",
};

/** Filled pips out of four, so a band reads at a glance without a number. */
export const BAND_PIPS: Record<Band, number> = {
  starting: 1,
  learning: 2,
  practising: 3,
  strong: 4,
};

/**
 * A mastery score becomes a band.
 *
 * The boundaries are deliberately wide. Narrow ones would put a child in a new
 * band every time one question moved the average, which recreates the anxiety
 * of a percentage while pretending not to.
 */
export function bandOf(mastery: number): Band {
  if (mastery >= 80) return "strong";
  if (mastery >= 60) return "practising";
  if (mastery >= 35) return "learning";
  return "starting";
}

/**
 * How much to say about how sure we are.
 *
 * Below a real threshold of evidence a child should be told the truth — that
 * K9 has not seen enough yet — rather than shown a band that sounds like a
 * verdict. "Not enough practice yet" is honest and actionable; "Starting" off
 * two questions is a label they might carry around.
 */
export const ENOUGH_EVIDENCE = 40;

export type StudentSkillView = {
  skill_id: number;
  name: string;
  subject: string;
  band: Band | null;
  label: string;
  pips: number;
  /** "up" | "down" | null — a direction, never a number of points. */
  moving: "up" | "down" | null;
  /** True when K9 has not seen enough to say anything yet. */
  needs_practice_to_tell: boolean;
};

export function studentView(row: {
  skill_id: number;
  name: string;
  subject: string;
  mastery: number;
  confidence: number;
  trend: number;
}): StudentSkillView {
  if (row.confidence < ENOUGH_EVIDENCE)
    return {
      skill_id: row.skill_id,
      name: row.name,
      subject: row.subject,
      band: null,
      label: "Not enough practice yet",
      pips: 0,
      moving: null,
      needs_practice_to_tell: true,
    };
  const band = bandOf(row.mastery);
  return {
    skill_id: row.skill_id,
    name: row.name,
    subject: row.subject,
    band,
    label: BAND_LABELS[band],
    pips: BAND_PIPS[band],
    // A trend worth mentioning, not every flicker. Telling a child they are
    // sliding because one question went badly is both wrong and unkind.
    moving: row.trend > 8 ? "up" : row.trend < -8 ? "down" : null,
    needs_practice_to_tell: false,
  };
}

/**
 * One thing to work on next, in the child's words.
 *
 * Deliberately singular. A list of seven weaknesses is a demoralising thing to
 * hand a fourteen-year-old, and they will do none of them.
 */
export function nextFocus(views: StudentSkillView[]): StudentSkillView | null {
  const ranked = views
    .filter((v) => !v.needs_practice_to_tell && v.band !== "strong")
    .sort((a, b) => BAND_PIPS[a.band!] - BAND_PIPS[b.band!] || a.name.localeCompare(b.name));
  return ranked[0] ?? null;
}
