// The tablet's session is the child's identity — see docs/K9_ATTRIBUTION_GATES.md.
// Nothing here runs voice or face recognition: they signed in.

export type Auth = { api_base: string; token: string; name: string; student_code: string };

const KEY = "k9-student.auth";

export function loadAuth(): Auth | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Auth) : null;
  } catch {
    return null;
  }
}

export function saveAuth(auth: Auth | null): void {
  try {
    if (auth) localStorage.setItem(KEY, JSON.stringify(auth));
    else localStorage.removeItem(KEY);
  } catch {
    /* a locked-down tablet may refuse storage; the session still works */
  }
}

export async function api<T>(
  auth: Auth,
  path: string,
  signal?: AbortSignal,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${auth.api_base}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${auth.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  if (response.status === 401) throw new Error("Your sign-in has expired. Sign in again.");
  if (!response.ok) throw new Error("K9 could not reach the school server.");
  return (await response.json()) as T;
}

/**
 * Tell the server what the child actually did.
 *
 * Fire-and-forget on purpose: a dropped record must never stall the answer in
 * front of a student. The evidence is valuable, the lesson is more so.
 */
export function record(auth: Auth, kind: string, extra: Record<string, unknown> = {}): void {
  void api(auth, "/v1/student/interaction", undefined, { kind, ...extra }).catch(() => undefined);
}

export type Band = "starting" | "learning" | "practising" | "strong";
export type SkillView = {
  skill_id: number;
  name: string;
  subject: string;
  band: Band | null;
  label: string;
  pips: number;
  moving: "up" | "down" | null;
  needs_practice_to_tell: boolean;
};
export type LearningMap = {
  subjects: { subject: string; skills: SkillView[] }[];
  focus: SkillView | null;
  week: { questions_asked: number; skills_practised: number };
};
export type Period = {
  period_id: number;
  subject: string;
  room: string | null;
  start_minute: number;
  end_minute: number;
  state: "done" | "now" | "upcoming";
};
