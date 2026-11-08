// node --import tsx --test artifacts/api-server/src/lib/classroom-agents.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONVERSATION_WINDOW_MS,
  DEFAULT_AGENT,
  SUBJECT_AGENTS,
  admit,
  agentFor,
  isForKobe,
  routeUtterance,
  stripWake,
  subjectKey,
} from "./classroom-agents";
import {
  STALE_MS,
  cardsFor,
  isRepeat,
  nextToSpeak,
  positionOf,
  staleItems,
  type QueueItem,
} from "./answer-queue";

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

test("every subject has its own voice, so students learn to tell them apart", () => {
  const voices = Object.values(SUBJECT_AGENTS).map((a) => a.voice);
  assert.equal(voices.length, new Set(voices).size);
});

test("a timetable's spelling still reaches the right teacher", () => {
  assert.equal(subjectKey("Mathematics"), "mathematics");
  assert.equal(subjectKey("computer science"), "computer_science");
  assert.equal(subjectKey("Basic Mathematics"), "mathematics");
  assert.equal(subjectKey("Form 2 Physics"), "physics");
  assert.equal(subjectKey("Needlework"), null);
});

test("an unknown subject still gets a teacher rather than silence", () => {
  assert.deepEqual(agentFor("Needlework"), { subject: null, ...DEFAULT_AGENT });
  assert.deepEqual(agentFor(null), { subject: null, ...DEFAULT_AGENT });
});

// ---------------------------------------------------------------------------
// Routing (§8: the timetable establishes context)
// ---------------------------------------------------------------------------

test("the timetable answers 'why do we move the 5 over there?' without being told", () => {
  // The whole point of §8: the student should not have to say "I'm studying
  // simultaneous equations and...".
  const routing = routeUtterance({
    transcript: "why do we move the 5 over there?",
    timetableSubject: "Mathematics",
  });
  assert.equal(routing.subject, "mathematics");
  assert.equal(routing.source, "timetable");
  assert.equal(routing.voice, SUBJECT_AGENTS["mathematics"]!.voice);
});

test("naming another subject outright overrides the timetable", () => {
  const routing = routeUtterance({
    transcript: "Kobe, in biology why does a leaf need sunlight?",
    timetableSubject: "Mathematics",
  });
  assert.equal(routing.subject, "biology");
  assert.equal(routing.source, "mentioned");
});

test("a follow-up stays with the conversation it continues", () => {
  const routing = routeUtterance({
    transcript: "but why does it need sunlight?",
    timetableSubject: "Mathematics",
    openConversationSubject: "biology",
  });
  assert.equal(routing.subject, "biology");
  assert.equal(routing.source, "continuation");
});

test("Kiswahili subject names route as well as English ones", () => {
  assert.equal(routeUtterance({ transcript: "Kobe, hii hesabu sijaelewa" }).subject, "mathematics");
  assert.equal(routeUtterance({ transcript: "swali la kemia" }).subject, "chemistry");
});

test("topic words alone never override the timetable", () => {
  // "energy" belongs to physics, chemistry and biology at once. Guessing from
  // topic words would mis-route more often than it helped.
  const routing = routeUtterance({
    transcript: "where does the energy in a cell come from?",
    timetableSubject: "Biology",
  });
  assert.equal(routing.subject, "biology");
  assert.equal(routing.source, "timetable");
});

// ---------------------------------------------------------------------------
// Invocation (§5: students talk constantly)
// ---------------------------------------------------------------------------

test("ordinary classroom chatter is not answered", () => {
  assert.equal(isForKobe("did you finish number four", "SPEAKER_01", null).invoked, false);
});

test("the wake word invokes, in either language", () => {
  assert.equal(isForKobe("Kobe, why does ice float?", "SPEAKER_01", null).invoked, true);
  assert.equal(isForKobe("Kobe, sijafahamu hii equation", "SPEAKER_01", null).invoked, true);
});

test("a follow-up needs no wake word, but only from the same speaker", () => {
  const open = { speaker: "SPEAKER_01", subject: "biology", expiresAt: Date.now() + 10_000 };
  assert.equal(isForKobe("but why sunlight?", "SPEAKER_01", open).invoked, true);
  // Someone else talking during the window is not continuing the conversation.
  assert.equal(isForKobe("but why sunlight?", "SPEAKER_02", open).invoked, false);
});

test("the conversation window closes", () => {
  const now = Date.now();
  const open = { speaker: "SPEAKER_01", subject: "biology", expiresAt: now + CONVERSATION_WINDOW_MS };
  assert.equal(isForKobe("and the roots?", "SPEAKER_01", open, now + 1_000).invoked, true);
  assert.equal(
    isForKobe("and the roots?", "SPEAKER_01", open, now + CONVERSATION_WINDOW_MS + 1).invoked,
    false,
  );
});

test("the wake word is stripped before the model sees the question", () => {
  assert.equal(stripWake("Kobe, why does ice float?"), "why does ice float?");
  assert.equal(stripWake("KobeAI explain photosynthesis"), "explain photosynthesis");
  // A question that is only the wake word must not become empty.
  assert.equal(stripWake("Kobe"), "Kobe");
});

// ---------------------------------------------------------------------------
// Modes (§9, §19: the teacher is never competed with)
// ---------------------------------------------------------------------------

test("a muted room records the question but says nothing", () => {
  const decision = admit({ mode: "qa", fromTeacher: false, mutedUntil: Date.now() + 60_000 });
  assert.equal(decision.answerAloud, false);
  assert.equal(decision.admit, true, "silence to the room, not amnesia in the record");
});

test("mute expires on its own", () => {
  const now = Date.now();
  assert.equal(admit({ mode: "qa", fromTeacher: false, mutedUntil: now - 1, now }).answerAloud, true);
});

test("teacher-assist answers the teacher and nobody else", () => {
  assert.equal(admit({ mode: "teacher_assist", fromTeacher: true }).answerAloud, true);
  assert.equal(admit({ mode: "teacher_assist", fromTeacher: false }).answerAloud, false);
});

test("listen mode never speaks, but still records", () => {
  const decision = admit({ mode: "listen", fromTeacher: false });
  assert.equal(decision.answerAloud, false);
  assert.equal(decision.admit, true);
});

test("quiz mode keeps the loudspeaker for the quiz", () => {
  assert.equal(admit({ mode: "quiz", fromTeacher: false }).answerAloud, false);
  assert.equal(admit({ mode: "quiz", fromTeacher: true }).answerAloud, true);
});

// ---------------------------------------------------------------------------
// The queue (§6: three questions, one loudspeaker)
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function item(over: Partial<QueueItem> & { id: number; speaker: string }): QueueItem {
  return {
    student_code: null,
    subject: "mathematics",
    transcript: `question ${over.id}`,
    status: "queued",
    created_at: NOW,
    served: 0,
    ...over,
  };
}

test("nothing speaks while the loudspeaker is busy", () => {
  const queue = [item({ id: 1, speaker: "A" })];
  const decision = nextToSpeak(queue, item({ id: 9, speaker: "B", status: "answering" }), NOW);
  assert.equal(decision.action, "wait");
});

test("an empty queue is idle, not an error", () => {
  assert.equal(nextToSpeak([], null, NOW).action, "idle");
});

test("a talkative child cannot hold the loudspeaker for the lesson", () => {
  // FIFO would speak all three of A's questions before B is ever heard.
  const queue = [
    item({ id: 1, speaker: "A", created_at: NOW }),
    item({ id: 2, speaker: "A", created_at: NOW + 1 }),
    item({ id: 3, speaker: "B", created_at: NOW + 2 }),
    item({ id: 4, speaker: "A", created_at: NOW + 3 }),
  ];
  const first = nextToSpeak(queue, null, NOW);
  assert.equal(first.action === "speak" && first.item.id, 1);
  // A has now been served once; B has not been served at all.
  queue[0]!.status = "spoken";
  for (const q of queue) if (q.speaker === "A") q.served = 1;
  const second = nextToSpeak(queue, null, NOW);
  assert.equal(second.action === "speak" && second.item.speaker, "B");
});

test("among equally-served speakers the oldest question wins", () => {
  const queue = [
    item({ id: 1, speaker: "A", created_at: NOW + 5 }),
    item({ id: 2, speaker: "B", created_at: NOW + 1 }),
  ];
  const decision = nextToSpeak(queue, null, NOW);
  assert.equal(decision.action === "speak" && decision.item.id, 2);
});

test("ordering is deterministic when age and service are identical", () => {
  const queue = [item({ id: 7, speaker: "B" }), item({ id: 3, speaker: "A" })];
  const a = nextToSpeak(queue, null, NOW);
  const b = nextToSpeak([...queue].reverse(), null, NOW);
  assert.equal(a.action === "speak" && a.item.id, b.action === "speak" && b.item.id);
});

test("a stale question is never spoken over the teacher", () => {
  // Three minutes late, the lesson has moved on and the answer lands on top of
  // whatever is being said now.
  const queue = [item({ id: 1, speaker: "A", created_at: NOW - STALE_MS - 1 })];
  assert.equal(nextToSpeak(queue, null, NOW).action, "idle");
  assert.equal(staleItems(queue, NOW).length, 1);
});

test("a stale question still exists on screen", () => {
  const queue = [item({ id: 1, speaker: "A", created_at: NOW - STALE_MS - 1 })];
  assert.equal(cardsFor(queue, "Form 2A").length, 1, "it stops interrupting, it does not vanish");
});

test("repeating yourself does not take the loudspeaker twice", () => {
  const queue = [item({ id: 1, speaker: "A", transcript: "Why is the sky blue?" })];
  assert.equal(isRepeat(queue, "A", "why is the sky blue"), true);
  assert.equal(isRepeat(queue, "A", "Why is the SKY blue??"), true);
  assert.equal(isRepeat(queue, "B", "Why is the sky blue?"), false, "a different child deserves an answer");
  assert.equal(isRepeat(queue, "A", "why is the sea blue?"), false);
});

test("a position is offered so a waiting student does not ask again", () => {
  const queue = [
    item({ id: 1, speaker: "A", created_at: NOW }),
    item({ id: 2, speaker: "B", created_at: NOW + 1 }),
    item({ id: 3, speaker: "A", created_at: NOW + 2 }),
  ];
  assert.equal(positionOf(queue, 1, NOW), 0);
  assert.equal(positionOf(queue, 2, NOW), 1);
  // A's second question goes behind B's first, not straight after A's first.
  assert.equal(positionOf(queue, 3, NOW), 2);
  assert.equal(positionOf(queue, 99, NOW), null);
});

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

test("an unidentified child still gets an answer and an honest label", () => {
  const cards = cardsFor([item({ id: 1, speaker: "SPEAKER_03" })], "Form 2A");
  assert.equal(cards[0]!.who, "Someone in Form 2A");
  assert.equal(cards[0]!.identified, false);
});

test("a name appears only when the voice gate gave one", () => {
  const cards = cardsFor([item({ id: 1, speaker: "SPEAKER_03", student_code: "K9-001" })], "Form 2A");
  assert.equal(cards[0]!.who, "K9-001");
  assert.equal(cards[0]!.identified, true);
});

test("the screen shows the newest questions first and is bounded", () => {
  const queue = Array.from({ length: 9 }, (_, i) =>
    item({ id: i + 1, speaker: `S${i}`, created_at: NOW + i }),
  );
  const cards = cardsFor(queue, "Form 2A", 4);
  assert.equal(cards.length, 4);
  assert.equal(cards[0]!.id, 9);
});
