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

## Before calling this an MVP
`docs/K9_VOICE_IDENTITY.md` sets the order: enrol one class, run `measure_speaker_id.py` on real lesson audio, and read the coverage-against-misattribution number before building the router, the queue and the screen on top of an unmeasured identity layer. Still outstanding after that: real-model testing of Whisper/TitaNet/pyannote, simultaneous-speech testing, microphone-array direction-of-arrival as a second identity signal, subject-agent routing and the answer queue.
