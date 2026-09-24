// ===========================================================================
// The answer queue.
//
// Three students speak at once, the diarizer separates them, and three
// questions arrive within a second of each other. The screen can hold three
// cards. The room has one loudspeaker.
//
// So this schedules *speech*, which is the scarce resource. Everything else —
// answering, showing — happens in parallel and is not this file's problem.
// ===========================================================================

/** How long a question stays worth answering aloud. */
export const STALE_MS = 150_000;

/** Nothing is spoken for longer than this; a long answer is read on screen. */
export const MAX_SPEECH_MS = 25_000;

export type QueueItem = {
  id: number;
  /** The diarizer's label. Present even when nobody has been identified. */
  speaker: string;
  /** Attached only when the voice gate was confident. May stay null forever. */
  student_code: string | null;
  subject: string | null;
  transcript: string;
  /** "queued" | "answering" | "spoken" | "shown" | "expired" */
  status: string;
  created_at: number;
  /** How many answers this speaker has already been *spoken* this lesson. */
  served: number;
};

export type Decision =
  | { action: "speak"; item: QueueItem }
  | { action: "wait"; reason: string }
  | { action: "idle" };

/**
 * Who speaks next.
 *
 * **Round-robin by speaker, not first-come-first-served.** FIFO lets one
 * talkative child hold the loudspeaker for a whole lesson while a quiet one
 * never gets heard — the same failure the priority cap in the skill engine
 * guards against. So the next item is the oldest question belonging to whoever
 * has been served least; ties break by age, which keeps it fair *and*
 * predictable.
 *
 * Stale questions are skipped rather than spoken. A question answered three
 * minutes late is noise: the lesson has moved on, the student has worked it out
 * or stopped caring, and the answer arrives over the top of whatever the
 * teacher is now saying. The card stays on screen — the answer still exists,
 * it just stops interrupting.
 */
export function nextToSpeak(
  queue: QueueItem[],
  speaking: QueueItem | null,
  now = Date.now(),
): Decision {
  if (speaking) return { action: "wait", reason: "loudspeaker_busy" };
  const ready = queue.filter((item) => item.status === "queued" && !isStale(item, now));
  if (ready.length === 0) return { action: "idle" };
  const best = ready.reduce((a, b) => {
    if (a.served !== b.served) return a.served < b.served ? a : b;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? a : b;
    return a.id < b.id ? a : b;
  });
  return { action: "speak", item: best };
}

export function isStale(item: QueueItem, now = Date.now()): boolean {
  return now - item.created_at > STALE_MS;
}

/** Everything queued that has aged out, for the sweep that marks them shown-only. */
export function staleItems(queue: QueueItem[], now = Date.now()): QueueItem[] {
  return queue.filter((item) => item.status === "queued" && isStale(item, now));
}

/**
 * How long this speaker is likely to wait before being heard.
 *
 * Shown on the card, because a number is far better than silence: a student who
 * can see "2 ahead of you" waits, and one who can see nothing asks again — which
 * adds another item to the queue and makes it worse.
 */
export function positionOf(queue: QueueItem[], id: number, now = Date.now()): number | null {
  const ordered: QueueItem[] = [];
  const pending = queue.filter((item) => item.status === "queued" && !isStale(item, now));
  const served = new Map<string, number>();
  for (const item of pending) served.set(item.speaker, item.served);
  const remaining = [...pending];
  while (remaining.length) {
    const next = remaining.reduce((a, b) => {
      const sa = served.get(a.speaker) ?? 0;
      const sb = served.get(b.speaker) ?? 0;
      if (sa !== sb) return sa < sb ? a : b;
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? a : b;
      return a.id < b.id ? a : b;
    });
    ordered.push(next);
    served.set(next.speaker, (served.get(next.speaker) ?? 0) + 1);
    remaining.splice(remaining.indexOf(next), 1);
  }
  const index = ordered.findIndex((item) => item.id === id);
  return index < 0 ? null : index;
}

/**
 * A duplicate of something already queued from the same speaker.
 *
 * A student who thinks they were not heard repeats themselves, and the
 * diarizer happily produces two near-identical turns. Answering both wastes the
 * loudspeaker twice and makes the queue look longer than it is.
 */
export function isRepeat(queue: QueueItem[], speaker: string, transcript: string): boolean {
  const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  const candidate = norm(transcript);
  if (!candidate) return false;
  return queue.some(
    (item) =>
      item.speaker === speaker &&
      (item.status === "queued" || item.status === "answering") &&
      norm(item.transcript) === candidate,
  );
}

/**
 * What the screen shows, newest first.
 *
 * A name only when there is one. "Someone in Form 2A" is honest and costs
 * nothing; putting the wrong child's name on the screen in front of their class
 * is the failure the whole identity gate exists to prevent, and it would be
 * this component that committed it.
 */
export function cardsFor(queue: QueueItem[], className: string | null, limit = 4) {
  return [...queue]
    .filter((item) => item.status !== "expired")
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      who: item.student_code ?? (className ? `Someone in ${className}` : "Someone"),
      identified: item.student_code !== null,
      subject: item.subject,
      question: item.transcript,
      status: item.status,
    }));
}
