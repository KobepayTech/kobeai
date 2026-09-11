# Teacher Lens

Status: adopted • Owner: KobeAI school-server team • Last updated: 2026-09-10

The teacher-worn client. Instead of every student carrying a device, one
teacher wears a phone or AR glasses + bluetooth earbuds. KobeAI sees what
the teacher sees (over HTTP, not a live video feed); whispers back through
the earbud. This is the primary consumer of the K9 vision stack once the
GPU box lands.

## Why this shape

- **Cost.** A cheap Android + TWS earbuds is ~$100. A device per student
  is ~$100 × 40 per class. For rural Tanzanian schools this is a
  40× cost delta on the same educational outcome.
- **Signal quality.** Paper marking is the cleanest AI feed you can get
  from a classroom. Every wrong answer is a labeled data point:
  `(student, subject, question, expected, got)`. Compare to a mic in the
  ceiling — ambient, unlabeled, privacy-fraught.
- **Existing workflow.** Teachers already mark papers by hand. The lens
  is a passive observer; there is no new behavior for staff to learn.
- **Privacy footprint.** One camera, worn on the teacher who consented
  and can pause any time. No student-facing cameras or microphones
  required for this path.

## Modes

### Lookup

The teacher walks around the classroom. When they look at a student and
tap the shutter, KobeAI answers "who is this and how are they doing" in
one short whisper:

> "Asha. Last Biology: 92 percent. Weak in Newton's laws."

The whisper is played through whatever audio device the phone is currently
paired to — typically a bluetooth earbud, sometimes a bone-conduction
open-ear. Falls back to the phone speaker if nothing else is paired.

The full on-screen brief (recent papers, all strong/weak topics,
attendance rate) shows in a bottom sheet when the teacher wants to look
deeper.

### Mark paper

The teacher's normal marking workflow, with the phone / glasses observing.
When the teacher taps the shutter over a marked paper, a bottom sheet
opens with an editable list of per-question items: **topic**, **student
answer**, **correct answer**, and a big **right / wrong** toggle. "Send to
KobeAI" writes the graded paper into `graded_papers` + `graded_paper_items`.

For any topic where the student got ≥2 answers wrong, the paper-graded
endpoint auto-enqueues a Youtu-VL / Qwen remediation-plan request onto
the intelligence-path vision queue. When the Qwen worker completes, the
suggested plan attaches to that student's learning profile.

### Ambient (planned)

Camera stream to KobeVision for continuous face-recognition. The teacher
never taps the shutter — the lens just knows who's in view and whispers
proactively when it sees a student due for a scheduled follow-up.

## Server surface

Everything under `/v1/teacher-lens/*` (teacher / admin auth).

| Route | Purpose |
|---|---|
| `POST /session`                | Start a lens session (`mode`, `device`). |
| `POST /session/:id/end`         | End it. Client also fires this via `navigator.sendBeacon` on `pagehide`. |
| `POST /paper-graded`            | Ingest one graded paper (envelope + up to 200 items) in one txn. Auto-enqueues a summary whisper + a Youtu-VL/Qwen remediation request when a wrong-answer pattern emerges. |
| `POST /lookup`                  | "I'm looking at this student" → composes a whisper from `getMergedProfile()` + recent papers, enqueues it. Returns the same payload for on-screen render. |
| `GET  /whisper/next`            | Session-scoped queue drain. `SELECT ... FOR UPDATE SKIP LOCKED`, marks the row `played`. |
| `GET  /student/:code/summary`   | Richer detail the phone renders below the whisper (recent papers + recurring weak topics). |

## Database

Four new tables (all auto-migrate on first request):

- `teacher_lens_sessions` — one row per session (teacher, mode, device, start/end).
- `graded_papers` — envelope per marked paper (session, teacher, student, subject, totals, score).
- `graded_paper_items` — per question (`question_topic`, `student_answer`, `expected_answer`, `is_correct`, marks).
- `teacher_lens_whispers` — outgoing TTS queue (session, priority, status, text).

The learning-profile rollup was extended with `computed_remediations JSONB`
and now mines `graded_paper_items` — any topic with ≥2 wrong answers per
student produces a `{topic, urgency, wrong_count, total_seen, evidence}`
entry alongside a `topics_weak` entry.

## Client

`artifacts/teacher-lens/` — a Vite + React PWA, `manifest.webmanifest` so
it installs to the phone home screen. Camera via `getUserMedia`, whisper
via `SpeechSynthesis`. ~155 KB / ~50 KB gz.

Everything the client does is standards-compliant browser APIs, so the
same PWA runs on:

- Any Android phone (Chrome, Firefox, Samsung Internet).
- iOS Safari (with a "Add to Home Screen" install).
- Android-based AR glasses (XREAL / Rokid / Viture) — the built-in Chrome
  browser opens it identically.
- Enterprise glasses with a WebView (Vuzix, RealWear).

Meta Ray-Bans and Oakley Meta are **not** supported — closed platforms,
no arbitrary code, no browser.

## What's here today, what's coming

Shipped:

- All server routes above.
- Learning-profile rollup that consumes graded papers into
  `computed_remediations` and folds new topics into `topics_weak`.
- Full lens PWA with camera preview, both modes, TTS whisper, session
  lifecycle including `sendBeacon` end-of-session.
- Integration into `artifacts/demo/` — the K9 school demo mounts the
  lens at `/lens/` and links to it from the landing page.
- **Auto-generated curated notes + adaptive retests** on every marked
  paper. Each wrong-topic-of-≥2 kicks off a Youtu-VL/Qwen enqueue for
  a richer version that replaces the rule-based note when a real
  worker is available.
- **`POST /v1/teacher-lens/frame`** — accepts raw JPEG bytes (up to
  6 MB), saves to `KOBEAI_LENS_FRAMES_DIR`, enqueues a vision analysis
  request. The stub worker (`scripts/k9-worker.mjs`) drains it today;
  a real SCRFD+ArcFace worker completes it later without any client
  change.
- **Wake-word** — the lens listens for "Kobe" via `webkitSpeechRecognition`
  and fires the shutter automatically. Toggle button on the actions
  row; falls back silently on browsers without support.
- **Face-recognition lookup UX** — shutter uploads the frame in
  parallel with fetching a recent-students list. Teacher taps the
  matching student; when the real worker lands, it fills the answer
  in without the tap.

Follow-up (needs the on-prem GPU box):

- Actual face-recognition on `POST /v1/teacher-lens/frame` (worker
  swap; endpoint is ready).
- Actual OCR that auto-fills the mark-paper sheet from a captured
  frame (worker swap).
- `GET /v1/teacher-lens/context` — proactive whispers when the lens
  sees a student due for a scheduled follow-up.
