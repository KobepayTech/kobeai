// ===========================================================================
// Subject agents and the answer queue.
//
// Two rules shape everything here.
//
// 1. **Identity is an enrichment, never a precondition.** The queue keys on a
//    speaker *label* — the diarizer's "SPEAKER_00" — and a student code is
//    attached only when the voice gate is confident. An unidentified child
//    still gets their answer, and the card says "Someone in Form 2A". This is
//    deliberate: docs/K9_VOICE_IDENTITY.md expects refusal to be common, and a
//    classroom where the AI goes silent whenever it is unsure is worse than one
//    that answers without a name.
//
// 2. **The teacher is never competed with.** Mute and mode are checked before
//    anything is admitted, and a muted room still records questions for the
//    learning profile — silence to the room, not silence in the record.
// ===========================================================================

/** Voice and teaching style per subject. Mirrors services/k9-runtime/classroom_audio.py. */
export const SUBJECT_AGENTS: Record<string, { voice: string; style: string }> = {
  mathematics: { voice: "teacher-a", style: "step_by_step" },
  physics: { voice: "teacher-b", style: "concept_then_example" },
  chemistry: { voice: "teacher-c", style: "safety_first_experimental" },
  biology: { voice: "teacher-d", style: "visual_explanatory" },
  english: { voice: "teacher-e", style: "language_coach" },
  kiswahili: { voice: "teacher-f", style: "kiswahili_teacher" },
  history: { voice: "teacher-g", style: "story_evidence" },
  geography: { voice: "teacher-h", style: "maps_systems" },
  civics: { voice: "teacher-i", style: "neutral_civic_education" },
  computer_science: { voice: "teacher-j", style: "code_and_concepts" },
};

export const DEFAULT_AGENT = { voice: "teacher-a", style: "general_teacher" };

/** Normalise however a timetable spells a subject. */
export function subjectKey(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const key = subject.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (SUBJECT_AGENTS[key]) return key;
  // "Basic Mathematics", "Form 2 Physics" — a timetable rarely writes the bare
  // subject, and a near-miss should still reach the right teacher.
  const hit = Object.keys(SUBJECT_AGENTS).find((known) => key.includes(known));
  return hit ?? null;
}

export function agentFor(subject: string | null | undefined) {
  const key = subjectKey(subject);
  return key ? { subject: key, ...SUBJECT_AGENTS[key]! } : { subject: null, ...DEFAULT_AGENT };
}

// ---------------------------------------------------------------------------
// Which subject is this question actually about?
// ---------------------------------------------------------------------------

/**
 * Words that say a question has left the timetabled subject.
 *
 * Kept small and high-precision on purpose. The timetable is right almost all
 * of the time, so this only overrides on an unambiguous signal — a student
 * naming another subject outright. Guessing from topic words ("energy",
 * "cell") would mis-route far more often than it helped, because those words
 * belong to several subjects at once.
 */
const SUBJECT_MENTIONS: [RegExp, string][] = [
  [/\b(math|maths|mathematics|hesabu)\b/i, "mathematics"],
  [/\b(physics|fizikia)\b/i, "physics"],
  [/\b(chemistry|kemia)\b/i, "chemistry"],
  [/\b(biology|baiolojia)\b/i, "biology"],
  [/\b(english|kiingereza)\b/i, "english"],
  [/\b(kiswahili|swahili)\b/i, "kiswahili"],
  [/\b(history|historia)\b/i, "history"],
  [/\b(geography|jiografia)\b/i, "geography"],
  [/\b(civics|uraia)\b/i, "civics"],
  [/\b(computer|computing|programming)\b/i, "computer_science"],
];

export type Routing = {
  subject: string | null;
  voice: string;
  style: string;
  /** "timetable" | "mentioned" | "continuation" | "default" */
  source: string;
};

/**
 * Pick the agent for an utterance.
 *
 * The timetable does the work — that is the point of §8. A student asking "why
 * do we move the 5 over there?" during the maths period should not have to
 * explain that they are doing simultaneous equations. An explicit mention of
 * another subject wins, and an open conversation wins over both, because a
 * follow-up belongs to the exchange it continues.
 */
export function routeUtterance(input: {
  transcript: string;
  timetableSubject?: string | null;
  openConversationSubject?: string | null;
}): Routing {
  const mentioned = SUBJECT_MENTIONS.find(([pattern]) => pattern.test(input.transcript));
  if (mentioned) {
    const agent = agentFor(mentioned[1]);
    return { subject: agent.subject, voice: agent.voice, style: agent.style, source: "mentioned" };
  }
  if (input.openConversationSubject) {
    const agent = agentFor(input.openConversationSubject);
    if (agent.subject)
      return { subject: agent.subject, voice: agent.voice, style: agent.style, source: "continuation" };
  }
  const agent = agentFor(input.timetableSubject);
  return {
    subject: agent.subject,
    voice: agent.voice,
    style: agent.style,
    source: agent.subject ? "timetable" : "default",
  };
}

// ---------------------------------------------------------------------------
// Was KobeAI actually being asked? (§5)
// ---------------------------------------------------------------------------

/** How long a student may follow up without saying the wake word again. */
export const CONVERSATION_WINDOW_MS = 30_000;

const WAKE = /\b(kobe|kobeai|kobe\s*ai)\b/i;

export type Conversation = { speaker: string; subject: string | null; expiresAt: number };

/**
 * Should this utterance be answered at all?
 *
 * Students talk constantly, and a system that answers every sentence in a
 * classroom is unusable. So: the wake word, or an open conversation with the
 * same speaker. Keying continuation on the *speaker label* rather than the
 * student means a follow-up works even when nobody has been identified.
 */
export function isForKobe(
  transcript: string,
  speaker: string,
  open: Conversation | null,
  now = Date.now(),
): { invoked: boolean; reason: string } {
  if (WAKE.test(transcript)) return { invoked: true, reason: "wake_word" };
  if (open && open.speaker === speaker && open.expiresAt > now)
    return { invoked: true, reason: "continuation" };
  return { invoked: false, reason: "not_addressed" };
}

/** Strip the wake word so the model is not asked "Kobe, why is the sky blue?". */
export function stripWake(transcript: string): string {
  return transcript.replace(/^\s*\b(kobe\s*ai|kobeai|kobe)\b[\s,.:!-]*/i, "").trim() || transcript.trim();
}

// ---------------------------------------------------------------------------
// Modes (§19)
// ---------------------------------------------------------------------------

export const MODES = ["listen", "qa", "teacher_assist", "quiz", "lesson"] as const;
export type Mode = (typeof MODES)[number];

export type Admission = { admit: boolean; answerAloud: boolean; reason: string };

/**
 * What a room in this mode does with an utterance.
 *
 * `admit` means "record it"; `answerAloud` means "say it out loud". They come
 * apart on purpose. A muted room still records questions, because the learning
 * evidence is worth having and costs the lesson nothing — a teacher who mutes
 * KobeAI wants quiet, not amnesia.
 */
export function admit(input: {
  mode: Mode;
  fromTeacher: boolean;
  mutedUntil?: number | null;
  now?: number;
}): Admission {
  const now = input.now ?? Date.now();
  if (input.mutedUntil && input.mutedUntil > now)
    return { admit: true, answerAloud: false, reason: "muted" };
  switch (input.mode) {
    case "listen":
      return { admit: true, answerAloud: false, reason: "listen_only" };
    case "teacher_assist":
      return input.fromTeacher
        ? { admit: true, answerAloud: true, reason: "teacher" }
        : { admit: true, answerAloud: false, reason: "teacher_only_mode" };
    case "quiz":
      // KobeAI is asking the questions; an unprompted student question would
      // cut across its own prompt on the one loudspeaker.
      return input.fromTeacher
        ? { admit: true, answerAloud: true, reason: "teacher" }
        : { admit: true, answerAloud: false, reason: "quiz_in_progress" };
    case "qa":
    case "lesson":
      return { admit: true, answerAloud: true, reason: "open" };
  }
}
