import type { NextFunction, Request, Response } from "express";
import { getCachedSubscription } from "./central-sync";

// ===========================================================================
// What a K9 subscription buys — and, more importantly, what it never gates.
//
// K9 is sold per student per year. The parent is not buying access to an app:
// no student carries a device, and the school already owns the cameras, the
// classroom PCs and the server. What they are buying is the INTELLIGENCE
// PROFILE — K9 continuously working out how their child learns and helping
// the school teach them better.
//
// That makes the boundary unusually clear, and this file is the only place it
// is drawn. Two tiers:
//
//   BASELINE — every student on the roll, paid or not, forever.
//     attendance, presence and safety; identity and the face gallery;
//     timetable; sitting exams; the school's own marks and report cards;
//     everything the school is required to keep about a child.
//
//   PREMIUM — the per-student subscription.
//     the skill mastery map; per-topic analysis of teacher-marked papers;
//     recommended interventions; the longitudinal profile and improvement
//     trend; generated revision, retests and lesson plans; the enhanced
//     parent report.
//
// The line is drawn where it is for a reason worth stating in code, because
// it is the kind of thing that erodes under commercial pressure:
//
//   **A child's attendance, safety and school record are never for sale.**
//
// K9 must still recognise an unpaid student on camera, still mark them
// present, still let them sit their exam, and still tell the school they
// scored 48% in Mathematics — because that is the school's own record of its
// own pupil, not a KobeAI product. What the subscription adds is the answer
// to *why* 48%: which skills, which mistake, what to do next.
//
// If anyone ever proposes moving attendance or safety above this line, the
// answer is no, and this comment is why.
// ===========================================================================

export const BASELINE_FEATURES = [
  "attendance",
  "presence",
  "safety",
  "identity",
  "timetable",
  "exams",
  "results",
  "records",
] as const;

export const PREMIUM_FEATURES = [
  "skill_profile", // the per-skill mastery map
  "exam_analysis", // why marks were lost, per question
  "recommendations", // what to teach this student next
  "longitudinal", // the profile over time, improvement trend
  "revision", // curated notes, retests, practice sets
  "learning_plan", // the generated personalised lesson plan
  "parent_report_plus", // the enhanced parent report / magazine
] as const;

export type PremiumFeature = (typeof PREMIUM_FEATURES)[number];
export type BaselineFeature = (typeof BASELINE_FEATURES)[number];

export const FEATURE_LABELS: Record<PremiumFeature, string> = {
  skill_profile: "Skill mastery map",
  exam_analysis: "Deep exam analysis",
  recommendations: "Recommended interventions",
  longitudinal: "Progress over time",
  revision: "Personalised revision and retests",
  learning_plan: "AI learning plan",
  parent_report_plus: "Enhanced parent report",
};

/** Subscription statuses that count as paid-up. */
const ENTITLED_STATUSES = new Set(["active", "trial", "grace"]);

/**
 * Is enforcement switched on at all? Default false: a school provisions and
 * watches the numbers for a couple of weeks before anything is withheld
 * (docs/K9_SUBSCRIPTIONS.md).
 */
export function enforcementOn(): boolean {
  return (process.env["ENFORCE_SUBSCRIPTIONS"] ?? "false") === "true";
}

export type Entitlement = {
  student_code: string;
  entitled: boolean;
  status: string;
  expires_at: Date | null;
  days_left: number | null;
  /** True when the answer is "yes" only because enforcement is off. */
  unenforced: boolean;
};

/**
 * Whether THIS STUDENT's subscription is current. Note the subject: the
 * caller is usually a teacher, and a teacher's own account has nothing to do
 * with whether a particular child's profile is paid for.
 */
export async function entitlementFor(studentCode: string): Promise<Entitlement> {
  const sub = await getCachedSubscription(studentCode);
  const status = sub?.status ?? "none";
  const paid = ENTITLED_STATUSES.has(status);
  const daysLeft = sub?.expires_at
    ? Math.ceil((sub.expires_at.getTime() - Date.now()) / 86_400_000)
    : null;
  return {
    student_code: studentCode,
    entitled: paid || !enforcementOn(),
    status,
    expires_at: sub?.expires_at ?? null,
    days_left: daysLeft,
    unenforced: !paid && !enforcementOn(),
  };
}

export async function entitlementsFor(studentCodes: string[]): Promise<Map<string, Entitlement>> {
  const out = new Map<string, Entitlement>();
  for (const code of new Set(studentCodes)) {
    out.set(code, await entitlementFor(code));
  }
  return out;
}

/**
 * What a locked response says. Deliberately not a bare 402: this is the one
 * moment a teacher is actively looking at a child and wondering why there is
 * nothing there, which makes it the only honest place to say what the
 * subscription would give them.
 */
export function lockedPayload(feature: PremiumFeature, e: Entitlement) {
  return {
    entitled: false,
    feature,
    feature_label: FEATURE_LABELS[feature],
    subscription_status: e.status,
    student_code: e.student_code,
    message:
      e.status === "none"
        ? "This student has no K9 learning subscription yet."
        : `This student's K9 learning subscription is ${e.status}.`,
    // The school's own record of this child is never withheld — only K9's
    // analysis of it. Saying so plainly stops "K9 is hiding my results".
    still_available: [
      "Attendance and presence",
      "Exam marks and report cards",
      "Timetable and school records",
    ],
    unlocks: PREMIUM_FEATURES.map((f) => FEATURE_LABELS[f]),
  };
}

/**
 * Resolve which student a request is about. Premium routes are mostly
 * staff-facing and name the student in the path; a student's own call names
 * nobody and means themselves.
 */
export function subjectStudentCode(req: Request, param = "studentCode"): string | null {
  const fromParam = req.params?.[param];
  if (typeof fromParam === "string" && fromParam.trim()) return fromParam.trim();
  const fromQuery = req.query?.[param] ?? req.query?.["student_code"];
  if (typeof fromQuery === "string" && fromQuery.trim()) return fromQuery.trim();
  const body = req.body as Record<string, unknown> | undefined;
  const fromBody = body?.["student_code"];
  if (typeof fromBody === "string" && fromBody.trim()) return fromBody.trim();
  // A student calling about themselves.
  return req.auth?.student_id ?? null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      entitlement?: Entitlement;
    }
  }
}

/**
 * Gate one premium feature on the SUBJECT student's subscription.
 *
 * Answers 200 with a `lockedPayload` rather than 402, because every caller is
 * a dashboard rendering a student's page: a 402 makes it look broken, and a
 * described lock makes it look like something the school can fix. The
 * entitlement is always attached to the request so a handler can shade its
 * own response instead of being cut off entirely.
 */
export function requirePremium(feature: PremiumFeature, param = "studentCode") {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const code = subjectStudentCode(req, param);
    if (!code) {
      // No student in scope — a whole-school or cohort read. Those are gated
      // per row by the handler, not here.
      next();
      return;
    }
    const entitlement = await entitlementFor(code);
    req.entitlement = entitlement;
    res.setHeader("x-k9-entitlement", entitlement.entitled ? "active" : "locked");
    if (entitlement.entitled) {
      next();
      return;
    }
    res.status(200).json(lockedPayload(feature, entitlement));
  };
}
