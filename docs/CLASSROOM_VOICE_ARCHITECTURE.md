# K9 classroom voice architecture

## Goal
One classroom screen, microphone array and speakers can serve many students. Audio is processed locally where possible.

Pipeline:
microphone array -> VAD -> overlapping-speaker diarization -> ASR -> speaker embedding -> enrolled-student match -> subject agent -> student context/progress -> answer queue -> TTS voice -> screen + speaker.

## Enrollment
A teacher selects a student already present in the school database. The student says their name and several prompted phrases. K9 records at least three samples, computes speaker embeddings, links the embedding profile to the existing student_id/name, and by default discards raw enrollment audio. Voice enrollment requires the school's appropriate consent/authorization workflow.

Voice is a biometric signal and is not treated as infallible identity. Low-confidence matches remain Unknown and must not alter a student's academic record.

## Multiple students
Diarization separates speaker turns. Speaker-ID maps each turn to an enrolled student. Each detected question creates its own request containing student_id, transcript, confidence, classroom, subject and timestamp. Concurrent questions are queued independently. Overlapping speech that cannot be separated confidently is shown as needing repetition rather than assigned to the wrong child.

## Individual answers in a shared room
The screen shows the student's first name/approved display identifier and the answer. TTS voices differ by subject agent so students can recognize Mathematics, Physics, Biology, etc. A single shared loudspeaker cannot provide truly private simultaneous answers; K9 serializes spoken answers while the screen can maintain multiple answer cards.

## Learning data
Store question topic, curriculum objective, whether clarification was requested, response/quiz outcome and teacher-confirmed observations. Do not infer grades, discipline, emotion, intelligence or ability from voice characteristics. Academic progress comes from learning interactions and assessed work.

## Model placement
Drop complete models under the roots named in `config/k9-models.json`, which is the **single** model registry: every path, root and download comes from it.

The warehouse (`services/k9-runtime/model_warehouse.py`) is a *view* over that registry, not a second one. It originally read its own `config/model-warehouse.json` with its own root and env var; that file is gone, because two registries is how a model becomes visible to one half of the system and invisible to the other, and how a weight gets shipped that nobody checked the licence on.

What the warehouse adds to the registry, and what was worth keeping from it:

- **`capability`** — a stable vocabulary (`vad`, `speech-to-text`, `speaker-id`, `diarization`, `text-to-speech`, …) that callers route on, so swapping a model is a registry edit rather than a code change.
- **`use`** — the licence position for shipping a weight in a paid build: `commercial`, `review` or `restricted`. `route()` returns only `commercial`. A present-but-unshippable weight reports `blocked`, not `ready` — it is on disk and deliberately unavailable, which is a different thing for an operator to see than "missing", and a weight that *works* is exactly the one that ships by accident.

## Where each step runs

    classroom mic
        │
        ├─ services/k9-runtime/server.py        the school PC's runtime
        │     /v1/vad                           speech or silence
        │     /v1/diarize                       who spoke when (SPEAKER_00…)
        │     /v1/speaker/embedding             one turn → a unit-length vector
        │     /v1/transcribe                    what was said
        │
        └─ school server (artifacts/api-server) holds the roster and the record
              POST /v1/voice/identify           vector + class → a name, or none
              POST /v1/classroom/insights       the question, attributed or not
                                                → classroom_skill_questions
              subject agent → screen + speaker

**The runtime returns evidence; it never returns an identity.** Deciding whose voice a vector is needs the class roster, the consent record and the audit trail, none of which belong in a stateless model server. That split also means a classroom PC rebooting mid-lesson loses nothing.

An earlier in-memory `ClassroomVoiceRegistry` in the runtime was removed for three reasons worth not rediscovering: it scored max-over-samples rather than against a centroid (which rewards whoever enrolled with more samples), it had a single threshold and no margin test (so two children who sound alike both pass and the winner is a coin toss), and it kept no consent record, retention or audit. See `docs/K9_VOICE_IDENTITY.md`.

## Subject agents and the answer queue

`lib/classroom-agents.ts` and `lib/answer-queue.ts` hold the decisions; the
routes are thin over them, so the rules are testable without a database.

**Routing (§7, §8).** The timetable does the work: a student asking "why do we
move the 5 over there?" during the maths period should not have to explain that
they are doing simultaneous equations. Precedence is *named subject* → *open
conversation* → *timetable* → default. Topic words never override the
timetable — "energy" and "cell" belong to three subjects at once, so guessing
from them would mis-route more often than it helped. Subject names in Kiswahili
route as well as English ones.

**Invocation (§5).** Forty children talk constantly, so nothing is answered
without the wake word or an open thirty-second conversation. Continuation is
keyed on the **speaker label**, not the student, so a follow-up works even when
nobody has been identified. Open conversations are in memory on purpose: they
live thirty seconds, and the correct behaviour on restart is to forget them.

**The queue (§6).** Three students speak at once, the diarizer separates them,
the screen holds three cards and the room has one loudspeaker. So the queue
schedules *speech*, which is the scarce resource:

- **Round-robin by speaker, not first-come-first-served.** FIFO lets one
  talkative child hold the loudspeaker for a whole lesson while a quiet one is
  never heard. The next answer belongs to whoever has been served least; ties
  break by age, which keeps it fair and predictable.
- **Stale questions stop interrupting.** After 150s the lesson has moved on and
  the answer would land over whatever the teacher is now saying. The card stays
  on screen — it stops speaking, it does not vanish.
- **Repeats are collapsed.** A student who thinks they were not heard says it
  again and the diarizer obliges with a near-identical turn.
- **A position is returned**, because a student who can see "2 ahead of you"
  waits, and one who can see nothing asks again.

**Modes (§9, §19).** `listen`, `qa`, `teacher_assist`, `quiz`, `lesson`, plus
mute. Admission and speech come apart deliberately: a muted room still records
questions, because a teacher who mutes KobeAI wants quiet, not amnesia — the
learning evidence costs the lesson nothing.

**Identity stays an enrichment.** The queue keys on the diarizer's label and
attaches a student code only when the voice gate was confident. An unidentified
child still gets their answer and the card reads "Someone in Form 2A". Putting
the wrong child's name on a screen in front of their class is the failure the
identity gate exists to prevent, and the queue is the component that would
commit it. This is also why the router and the queue do not wait on the
measurement: if voice identification turns out weak, they keep working.

## Before calling this an MVP
`docs/K9_VOICE_IDENTITY.md` sets the order: enrol one class, run `measure_speaker_id.py` on real lesson audio, and read the coverage-against-misattribution number before building the router, the queue and the screen on top of an unmeasured identity layer. Still outstanding after that: real-model testing of Whisper/TitaNet/pyannote, simultaneous-speech testing on real hardware, microphone-array direction-of-arrival as a second identity signal, and the classroom gateway that joins the runtime to these endpoints.
