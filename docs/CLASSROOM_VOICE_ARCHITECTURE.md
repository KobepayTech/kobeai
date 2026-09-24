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
Drop complete models under C:\\KobeOS\\Models according to config/model-warehouse.json. The runtime scans known paths and only routes models marked ready. Production blocks research-only image models.
