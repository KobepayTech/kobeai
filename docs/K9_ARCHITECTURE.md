# K9 architecture

Status: adopted • Owner: KobeAI school-server team • Last updated: 2026-09-07

This document is the reference for how KobeAI's on-premise "K9" school AI
is composed. It lays out the model stack, the vision cascade, the audio
path, latency budgets, and the split between the always-running fast path
and the asynchronous intelligence path.

> Naming: "K9" is the internal name for the whole school-AI experience
> teachers and students interact with. The external K-9 network scanner
> ships inside this repo as `services/k9-network/` and is always surfaced
> to users as **Camera Network Discovery**. Teachers should never need to
> know model names like YOLO-Master, Youtu-VL, TitaNet, Whisper, or Qwen.

## Model stack (K9 v1)

| Layer | Model / technology | Job in K9 |
|---|---|---|
| Always-on vision | Tencent YOLO-Master v26.08 | Detect students, teachers, bags, desks, doors, raised hands on every camera |
| Single-camera tracking | ByteTrack | Persist track IDs as a person moves through one camera |
| Cross-camera ReID | OSNet-AIN | Match a person across cameras when the face isn't visible |
| Face detection | SCRFD | Locate faces inside person boxes |
| Face recognition | ArcFace / InsightFace-class embedding | Face → student identity |
| Visual intelligence | Tencent Youtu-VL-4B | Scene understanding, counting, OCR, grounding, pose, VQA |
| Precision visual search | *(optional)* NVIDIA LocateAnything-3B | Fine-grained "find the student with the blue backpack" |
| Speech recognition | Whisper large-v3-turbo | Classroom speech → text |
| Speaker recognition | NVIDIA TitaNet-Large | Which enrolled speaker is talking |
| Reasoning | Qwen3-4B | Timetable logic, student context, alerts, conversations |
| Video runtime | NVIDIA DeepStream + TensorRT | Efficient many-stream inference on ordinary IP/NVR cameras |

Not adopted:

- **LocateAnything is optional**, not compulsory. Ship without it; add it only
  if testing shows Youtu-VL can't handle a needed grounding case.

Licensing notes:

- InsightFace's code is MIT, but its downloadable pretrained recognition
  models are research/non-commercial. For production ship either an
  appropriately-licensed ArcFace-compatible embedding or an in-house trained
  one — do not silently ship the research weights.
- TitaNet-Large is primarily English-trained. Tanzanian classrooms mix
  English + Kiswahili; fine-tune the speaker component on school-approved
  enrollment recordings before relying on it for attribution.

## Vision cascade

```
CAMERA / NVR
     │
     ▼
YOLO-Master  ── person, face box, bag, chair, door, laptop, hand-raise…
     │
     ▼
ByteTrack    ── associates even low-confidence detections; persists track ID
     │
     ▼
SCRFD         ── face detection inside person boxes
     │
     ▼
ArcFace       ── face → student identity
     │
     ├── face unavailable ──▶ OSNet ReID (cross-camera identity carry)
     │
     ▼
STUDENT IDENTITY  ──▶  K9 LOCATION ENGINE  ──▶  timetable rules
```

Two hard rules for this cascade:

1. **Don't recognise the same face on every frame.** After the first hit,
   ByteTrack keeps the track ID; face recognition only re-runs when the
   track is lost or identity confidence drops.
2. **Don't run heavy detection at 30 FPS per camera.** Cameras record at
   25/30 FPS but K9's inference sees 5–10 FPS per stream. Tracking fills
   the gaps.

## Audio path

```
CLASSROOM MIC
     │
     ├── TitaNet ── who is speaking
     └── Whisper large-v3-turbo ── what they're saying
                    │
                    ▼
                 Qwen3-4B  (reasoning; sees text + structured context, never raw video)
```

Whisper large-v3-turbo trims the decoder from 32 to 4 layers, giving most
of the accuracy at a fraction of the wall-clock cost.

## Fast path vs intelligence path

The critical rule is that Youtu-VL is **never** in the sub-second alert loop.

```
FAST PATH                              INTELLIGENCE PATH
Camera                                 (async queue)
 ↓
YOLO-Master   ── interesting event ──▶ Youtu-VL-4B
 ↓                                       ↓
ByteTrack                        deeper scene analysis
 ↓                                       ↓
Face ID                                 K9 assistant
 ↓
Rules engine
 ↓
Alert
```

Concretely, in this repo:

- **Fast path** is `services/kobevision/app.py` → `POST /v1/presence/event`
  → `presence-monitor.ts` → `current_student_presence` (new; see task 13).
  This is the sub-second location + wrong-place alert path.
- **Intelligence path** is `vision_analysis_requests` (new; see task 14),
  a queue that a future Youtu-VL / LocateAnything worker consumes. The
  fast path enqueues onto it whenever an event looks anomalous (unknown
  person, wrong-location with low ReID confidence, coverage issue),
  without blocking on the answer.

## Continuous presence, not just 30-minute snapshots

The existing 30-minute checkpoint (`runPresenceCheckpoint`) is a
reconciliation event, not the source of truth. K9 maintains student
presence continuously; the 30-minute mark just persists a checkpoint row
for reporting.

- New `current_student_presence` table: one row per student, updated in
  place by `recordPresenceEvent`.
- `GET /v1/presence/live` — where every student is right now.
- `GET /v1/presence/live/mismatches` — where students are in a room they
  shouldn't be, computed against the live timetable.
- The 30-minute `presence_checkpoint_results` is untouched — it's still
  the audit log for reports, historical attendance rates, and the parent
  school-day summary.

Timeline example:

```
10:00 Physics starts
10:00:02  29/30 confirmed via ByteTrack IDs already on-camera
10:00:07  missing student found by cross-camera search
10:00:10  tracked entering library
10:00:10  K9 flags timetable mismatch  (fast path)
10:00:12  Youtu-VL enqueued: "what is this student doing in the library?"
10:00:14  Youtu-VL: "reading, appears to be studying"  (intelligence path)
10:30:00  reconciliation row written to presence_checkpoint_results
```

## Latency budget

For a school with ~20–40 cameras on an RTX 4060 Ti 16 GB (baseline) or
RTX 4090/5090-class (larger deployments):

| K9 action | Target |
|---|---|
| Camera → location event | ≤ 250 ms |
| Face identification | ≤ 300 ms |
| Wrong-place / timetable alert | ≤ 500 ms |
| Cross-camera person search | ≤ 1 s |
| Youtu-VL scene analysis | 1–4 s |
| Spoken K9 answer (starts) | ~1–2 s after utterance ends |

Detector budgets that support the above:

- YOLO-Master EsMoE-M on RTX 4090: ~244 FPS (~4 ms/frame detector)
- SCRFD face detection: 4–12 ms/face on GPU
- ArcFace recognition: 2–3 ms/face on RTX-class hardware
- Qwen3-4B: 46–52 tok/s (Transformers), higher with SGLang serving

Camera decode and network I/O dominate the wall-clock. The models are
usually well under 40 ms combined.

## Cascade sizing (worked example)

100 cameras × 25 FPS = 2,500 frames/second. K9 does **not** process 2,500
frames/s of face recognition.

```
100 cameras
      ↓  DeepStream hardware decode
5–10 analysis FPS per camera
      ↓
YOLO-Master  (500–1,000 detection frames/s)
      ↓
ByteTrack    (fill the gaps between detections)
      ↓
Face recognition ONLY on new tracks / low-confidence tracks
      ↓
K9 events
```

This keeps the GPU headroom for Youtu-VL and Qwen so the intelligence
path doesn't starve.

## What's in the repo today, and where the gaps are

Already in tree:

- `services/kobevision/app.py` — face-detection + recognition service
  (currently uses InsightFace directly; slot for SCRFD/ArcFace with
  commercial-clean weights).
- `services/kobevoice/agent/src/agent.py` — LiveKit-based voice agent
  routed through the KobeAI voice gateway (`routes/voice.ts`).
- `services/k9-network/` — camera discovery scanner.
- `artifacts/api-server/src/lib/presence-monitor.ts` — timetable-aware
  reconciliation with `on_schedule / wrong_location / not_seen /
  low_confidence / insufficient_camera_coverage` statuses.
- `artifacts/api-server/src/lib/vision-queue.ts` +
  `vision_analysis_requests` — the intelligence-path queue.
- `scripts/k9-worker.mjs` — a **stub** worker that drains the queue
  end-to-end. Real GPU models replace `handle()` without changing the
  wire protocol.
- `artifacts/api-server/src/lib/kobe-llm.ts` — the shared `askKobe()`
  shim; every LLM-producing generator (curated notes, retest
  questions, lesson plans) calls it. Gated by
  `AI_PROVIDER=ollama` + `OLLAMA_ENABLE_GENERATION=1`.
- `artifacts/api-server/src/routes/classroom-insights.ts` +
  `classroom_discussion_insights` — the sink for mic-derived Q&A.
- Teacher-lens PWA + `POST /v1/teacher-lens/frame` — end-to-end path
  for the phone/glasses camera. Stub worker acknowledges frames today;
  a real face-rec / OCR worker completes the request via
  `POST /v1/vision/analyze/:id/complete`.
- Classroom TV kiosk with `?mode=display|dashboard|assistant`, mic
  input via `webkitSpeechRecognition`, TTS reply via
  `SpeechSynthesis` (no LiveKit required — pure browser APIs).
- `artifacts/demo/` one-command demo of the whole stack.
- `artifacts/teacher-lens/` PWA (installable to phone home screen).

Not in tree, tracked here:

- YOLO-Master, ByteTrack, OSNet, SCRFD deployment recipe.
- Youtu-VL-4B worker that consumes `vision_analysis_requests` for
  scene analysis / OCR / face recognition.
- TitaNet speaker-recognition wiring in the voice gateway.
- Qwen3-4B serving path (SGLang recommended) — Ollama fills in today
  when `OLLAMA_ENABLE_GENERATION=1`.
- DeepStream + TensorRT bring-up on the school-server tower.

Each of these is its own hardware/model integration and belongs in a
follow-up PR against `services/kobevision/` and `services/kobevoice/`.
The **wire protocols are stable** — swapping a real worker in
requires only editing `handle()` in `scripts/k9-worker.mjs` (or
replacing the whole file with a Python-side drain against the same
endpoints).

## Teacher-worn lens (primary client)

The primary K9 client is a teacher-worn phone or AR glasses + bluetooth
earbuds, not a per-student device. See `docs/TEACHER_LENS.md` for the
full contract; the short version is:

- **Lookup mode**: teacher looks at a student, taps shutter, phone
  whispers a short brief via `SpeechSynthesis`.
- **Mark paper mode**: teacher marks a paper as normal, phone captures
  per-question right/wrong + topic + student answer, `POST
  /v1/teacher-lens/paper-graded` writes it, learning-profile rollup
  mines it into `computed_remediations` and `topics_weak`.

This is where the vision stack earns its keep: face recognition
(SCRFD/ArcFace) for the lookup, and OCR + layout parsing (Youtu-VL) for
the mark-paper flow. Both live on the on-prem GPU box; the phone just
uploads JPEGs.

## Non-goals

- Uploading raw CCTV video to the cloud. The whole point is that this
  runs on the school's own GPU box; only alerts and structured events
  cross the network.
- Automatic discipline or grade adjustments. K9 flags, teachers decide.
  This is enforced in the classroom-insights ingestion (`automated_action`
  is always `flag_for_human_review_only` in the details JSON).
- Continuous listening. Voice is teacher-triggered or wake-word, not
  always-on.
