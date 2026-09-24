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

export type Note = { id: number; subject: string; topic: string; body_markdown: string };
export type Practice = {
  id: number;
  subject: string;
  difficulty_level: string | null;
  questions: number;
};
export type PracticeItem = { id: number; topic: string | null; question_text: string };
export type Verdict = {
  correct: boolean;
  moves_mastery: boolean;
  suggest_assessment: boolean;
  reason: string;
};
export type SchoolView = {
  week: {
    day_of_week: number;
    subject: string;
    room: string | null;
    start_minute: number;
    end_minute: number;
  }[];
  results: {
    subject: string;
    marks_awarded: number | null;
    marks_possible: number | null;
    created_at: string;
  }[];
  attendance_rate: number | null;
  kp_balance: number;
  subscription: { status: string; expires_at: string } | null;
};

/** A locked premium response is a 200 with `entitled: false`, never a 402. */
export type Locked = { entitled: false; message?: string };
export function isLocked(value: unknown): value is Locked {
  return !!value && typeof value === "object" && (value as Locked).entitled === false;
}

/** Record an audio clip for the "Talk" button, as a 16 kHz mono WAV. */
export async function recordClip(seconds = 8): Promise<{ wav: string; stop: () => void }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const done = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start();
  const timer = setTimeout(() => recorder.state !== "inactive" && recorder.stop(), seconds * 1000);
  const stop = () => {
    clearTimeout(timer);
    if (recorder.state !== "inactive") recorder.stop();
  };
  await done;
  // Always release the microphone. A tablet quietly recording in a classroom
  // is the thing this whole design exists to avoid.
  stream.getTracks().forEach((track) => track.stop());
  const buffer = await new Blob(chunks).arrayBuffer();
  return { wav: toWav(await decode(buffer)), stop };
}

async function decode(buffer: ArrayBuffer): Promise<AudioBuffer> {
  const context = new AudioContext({ sampleRate: 16_000 });
  try {
    return await context.decodeAudioData(buffer);
  } finally {
    void context.close();
  }
}

/** The runtime wants 16-bit PCM mono at 16 kHz; a browser gives us anything but. */
function toWav(audio: AudioBuffer): string {
  const samples = audio.getChannelData(0);
  const bytes = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  bytes.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVEfmt ");
  bytes.setUint32(16, 16, true);
  bytes.setUint16(20, 1, true);
  bytes.setUint16(22, 1, true);
  bytes.setUint32(24, audio.sampleRate, true);
  bytes.setUint32(28, audio.sampleRate * 2, true);
  bytes.setUint16(32, 2, true);
  bytes.setUint16(34, 16, true);
  ascii(36, "data");
  bytes.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    bytes.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  let binary = "";
  const view = new Uint8Array(bytes.buffer);
  for (let i = 0; i < view.length; i += 0x8000)
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}
