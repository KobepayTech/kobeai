// Grading rules for K9 report cards and scoreboards. Pure functions only —
// lib/results.ts feeds them database rows.
//
// The school's own grade bands are the official grade. NECTA grades, points and
// divisions are shown alongside so students know where they stand nationally;
// they follow the NECTA CSEE (O-level) and ACSEE (A-level) conventions and
// should be checked against NECTA's current guidelines.

export type GradeBand = { grade: string; min: number; points?: number; remark?: string };
export type SchoolLevel = "o_level" | "a_level";
export type ScoreMethod = "weighted" | "average" | "terminal";
export const SCORE_METHODS: ScoreMethod[] = ["weighted", "average", "terminal"];

export const NECTA_O_LEVEL: GradeBand[] = [
  { grade: "A", min: 75, points: 1, remark: "Excellent" },
  { grade: "B", min: 65, points: 2, remark: "Very good" },
  { grade: "C", min: 45, points: 3, remark: "Good" },
  { grade: "D", min: 30, points: 4, remark: "Satisfactory" },
  { grade: "F", min: 0, points: 5, remark: "Fail" },
];

export const NECTA_A_LEVEL: GradeBand[] = [
  { grade: "A", min: 80, points: 1, remark: "Excellent" },
  { grade: "B", min: 70, points: 2, remark: "Very good" },
  { grade: "C", min: 60, points: 3, remark: "Good" },
  { grade: "D", min: 50, points: 4, remark: "Satisfactory" },
  { grade: "E", min: 40, points: 5, remark: "Pass" },
  { grade: "S", min: 35, points: 6, remark: "Subsidiary" },
  { grade: "F", min: 0, points: 7, remark: "Fail" },
];

// Divisions use the best (lowest-point) subjects: 7 at O-level, 3 principal at A-level.
const DIVISION_RULES: Record<SchoolLevel, { subjects: number; ranges: Array<[string, number, number]> }> = {
  o_level: { subjects: 7, ranges: [["I", 7, 17], ["II", 18, 21], ["III", 22, 25], ["IV", 26, 33], ["0", 34, 35]] },
  a_level: { subjects: 3, ranges: [["I", 3, 9], ["II", 10, 12], ["III", 13, 17], ["IV", 18, 19], ["0", 20, 21]] },
};

export const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Forms 5–6 are A-level; everything else is treated as O-level. */
export function levelForClassGrade(grade: string | null | undefined): SchoolLevel {
  const form = Number(/form\s*(\d)/i.exec(grade ?? "")?.[1]);
  return form >= 5 ? "a_level" : "o_level";
}

export function nectaScale(level: SchoolLevel): GradeBand[] {
  return level === "a_level" ? NECTA_A_LEVEL : NECTA_O_LEVEL;
}

/** Returns an error message, or null when the bands are usable. */
export function validateBands(bands: unknown): string | null {
  if (!Array.isArray(bands) || bands.length < 2) return "a grading scheme needs at least two bands";
  const grades = new Set<string>();
  const mins = new Set<number>();
  for (const band of bands as Array<Partial<GradeBand>>) {
    if (!band || typeof band.grade !== "string" || !band.grade.trim() || band.grade.trim().length > 4) {
      return "each band needs a grade label of up to 4 characters";
    }
    if (typeof band.min !== "number" || !Number.isFinite(band.min) || band.min < 0 || band.min > 100) {
      return `band ${band.grade}: min must be a number from 0 to 100`;
    }
    if (band.points !== undefined && (typeof band.points !== "number" || !Number.isFinite(band.points))) {
      return `band ${band.grade}: points must be a number`;
    }
    if (grades.has(band.grade.trim())) return `grade ${band.grade} appears twice`;
    if (mins.has(band.min)) return `two bands start at ${band.min}`;
    grades.add(band.grade.trim());
    mins.add(band.min);
  }
  if (!mins.has(0)) return "one band must start at 0 so every score gets a grade";
  return null;
}

export function gradeFor(percent: number, bands: GradeBand[]): GradeBand {
  const sorted = [...bands].sort((a, b) => b.min - a.min);
  return sorted.find((band) => percent >= band.min) ?? sorted[sorted.length - 1]!;
}

export function nectaDivision(
  level: SchoolLevel,
  subjectPoints: number[],
): { division: string; points: number; subjects_counted: number } | null {
  const rule = DIVISION_RULES[level];
  if (subjectPoints.length < rule.subjects) return null;
  const points = [...subjectPoints]
    .sort((a, b) => a - b)
    .slice(0, rule.subjects)
    .reduce((sum, value) => sum + value, 0);
  const range = rule.ranges.find(([, min, max]) => points >= min && points <= max);
  return { division: range ? range[0] : "0", points, subjects_counted: rule.subjects };
}

export type ExamScore = { kind: "ca" | "terminal"; percent: number };
export type SubjectScores = { ca: number | null; terminal: number | null; average: number | null; weighted: number | null };

const mean = (values: number[]): number | null =>
  values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

/**
 * All three ways a subject's term score can be calculated, so the school's
 * official method is on the report card and the others stay visible:
 *   weighted — continuous assessment and terminal exam by the school's weights
 *   average  — every marked paper counts equally
 *   terminal — the terminal exam only
 */
export function subjectScores(exams: ExamScore[], weights: { ca: number; exam: number }): SubjectScores {
  const ca = mean(exams.filter((e) => e.kind === "ca").map((e) => e.percent));
  const terminal = mean(exams.filter((e) => e.kind === "terminal").map((e) => e.percent));
  const average = mean(exams.map((e) => e.percent));
  let weighted: number | null;
  if (ca !== null && terminal !== null) {
    const totalWeight = weights.ca + weights.exam;
    weighted = totalWeight > 0 ? (ca * weights.ca + terminal * weights.exam) / totalWeight : average;
  } else {
    weighted = ca ?? terminal;
  }
  const r = (value: number | null) => (value === null ? null : round1(value));
  return { ca: r(ca), terminal: r(terminal), average: r(average), weighted: r(weighted) };
}

export function officialScore(scores: SubjectScores, method: ScoreMethod): number | null {
  if (method === "average") return scores.average;
  if (method === "terminal") return scores.terminal;
  return scores.weighted;
}

/** Competition ranking, highest first: equal scores share a position (1, 2, 2, 4). */
export function rankPositions<K>(entries: Array<{ key: K; score: number }>): Map<K, number> {
  const sorted = [...entries].sort((a, b) => b.score - a.score);
  const positions = new Map<K, number>();
  sorted.forEach((entry, index) => {
    const previous = sorted[index - 1];
    positions.set(entry.key, previous && previous.score === entry.score ? positions.get(previous.key)! : index + 1);
  });
  return positions;
}

export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}
