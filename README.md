# KobeAI

K9 is KobeAI's on-premise, school-wide AI system for Tanzanian secondary
schools. It runs on the school's own server, keeps working offline on the
LAN, and reaches parents on their phones.

No student carries a device. Existing cameras identify students, the
classroom PC + TV is the shared student-facing AI, and teachers use a
laptop, phone or Teacher Lens.

```text
                 K9 SCHOOL SERVER
            KobeAI + Models + Database
                      │
        ┌─────────────┼──────────────┐
        │             │              │
     CAMERAS       CLASSROOM      TEACHERS
    / NVRs         PC + TV       Phone/Laptop
        │             │          + Teacher Lens
        └─────────────┼──────────────┘
                      │
                 SCHOOL LAN/WIFI
                      │
          ┌───────────┼───────────┐
       Students    Parents      Admin
       Profiles     Portal       Portal
```

## What's in the box

| Surface | Tech | Path |
|---|---|---|
| **Teacher Dashboard** | React + Vite + TypeScript | `artifacts/teacher-dashboard` |
| **Teacher Lens** | PWA for a phone or AR glasses + earbud | `artifacts/teacher-lens` |
| **Classroom TV** | Full-screen kiosk on the classroom PC | `artifacts/classroom-tv` |
| **Parent Portal** | React PWA (offline-capable) | `artifacts/parent-app` |
| **API Server** | Node.js + Express 5 + Drizzle ORM (PostgreSQL) | `artifacts/api-server` |
| **Camera network + vision** | K-9 discovery, KobeVision, vision queue worker | `services/`, `scripts/k9-worker.mjs` |
| **Voice** | KobeVoice / LiveKit through the KobeAI voice gateway | `services/kobevoice` |
| **Print agent** | Raspberry Pi + CUPS beside each printer | `tap-box/` |
| **Shared schema / API client** | Drizzle + Zod + Orval | `lib/` |
| **On-prem AI** | Offline Ollama (Mistral 7B by default) | — |

Brand: green `#00A86B` primary, `#1A1A2E` secondary. Currency: Tanzanian
Shilling (TSh).

## How K9 works

- **Presence from cameras.** Fast detection and tracking run continuously on
  existing CCTV/NVR streams and produce structured events
  (`student → zone → time`), not stored video. The timetable engine compares
  where each student is with where they should be and raises missing,
  wrong-room or camera-coverage exceptions for staff.
- **Classroom TV.** The classroom PC shows lessons, announcements,
  birthdays, attendance and a shared AI assistant the class can use by
  keyboard or room microphone.
- **Teacher Lens.** Teachers look up a student, get a private spoken
  briefing, and scan marked papers so results roll into learning profiles.
- **Learning profiles and agents.** Strengths, weak topics, attendance and
  interventions build up per student; K9 flags, teachers decide.
- **Parents** get school-day summaries, progress and approved notices, never
  a live tracking view.

See `docs/K9_ARCHITECTURE.md`, `docs/TEACHER_LENS.md`,
`docs/K9_MODEL_STACK.md`, `docs/K9_ONBOARDING.md`,
`docs/K9_MARKET_AGENT.md` and `docs/K9_BURSAR_AI.md` for the full design.

## Setting a school up

Nobody types a list into a computer.

1. The first person to open the Teacher Dashboard gets the install wizard:
   the school's name, a setup password, and the school's own administrator.
   That is the only account the install creates — the KobepayTech operator
   console is never part of a school install (`docs/K9_ONBOARDING.md`).
2. The administrator prints teacher QR codes from **Staff & Students**.
3. A teacher scans one with their own phone. It opens a form — their name,
   age band, subjects, classes, language, and the name K9 should call them —
   and creates their account. There is no login screen in the flow.
4. The same phone photographs the printed class list. The vision model reads
   it, the teacher checks the rows, and Commit creates the students.
5. K9 then shows one name at a time: call that student over, tap the shutter,
   next. That is the face gallery filled in a period, and camera presence
   starts working.
6. Finally the Form 3+ subject-option sheet, so nobody is quizzed on a paper
   they dropped.

Every read is a proposal a human approves. A school with no vision model
pastes the list in as text through the same parsers.

## Question market

Students browse open questions on a shared classroom PC, rent five minutes of
exclusive time on one for 10 KP, and win the reward if they answer correctly.

The questions come from an agent running on the school's own models: it reads
how thin the floor is per subject, what students are actually clearing, and
which topics they are weak at; writes questions; re-solves each one with the
answer key hidden and drops the ones the two passes disagree on; prices them
from difficulty and scarcity inside an operator-set KP band; and sweeps the
stale ones away. Every cycle is recorded. With no brain installed it recycles
teacher-authored quiz questions rather than leaving the floor empty.

See `docs/K9_MARKET_AGENT.md`.

## School fees

Fees are a real ledger: `fee_transactions` is append-only and signed,
`fee_accounts` is the cached balance, and every write goes through one
function that updates both inside a transaction — so
`balance == SUM(transactions)` always holds, and `GET /v1/fees/verify`
proves it. Nothing is edited or deleted; a mistake is corrected by a
reversal. An M-Pesa receipt can only ever be posted once.

Reconciling those payments is where AI earns its place. The bursar pastes
(or photographs) the M-Pesa confirmations off the school phone; K9 reads
them — regex first, because the text is machine-generated, with the vision
model for statement layouts it does not know — works out whose fees each one
is from the sending phone, the payer's name and the outstanding balance, and
says why. Two plausible children produce no proposal at all. The bursar
confirms, and only then does the ledger move.

See `docs/K9_BURSAR_AI.md`, which also sets out what is deliberately not
built yet and why.

## Printing

Printing is staff-initiated. A teacher picks a document, printer and number
of copies on the Teacher Dashboard **Documents** page, which calls
`POST /api/v1/print/jobs`. The print agent beside that printer polls
`GET /api/v1/print/next`, downloads the PDF and prints it through CUPS.
Every job writes a `print_jobs` audit row; jobs printed for one student show
up in that child's parent print history.

**State:** live jobs live in Redis when `REDIS_URL` is set (a `LIST` queue
per printer) and fall back to in-process `Map`s for local dev.

## Offline AI (Ollama)

The classroom assistant (`POST /api/v1/classroom/ask`) and Teacher Lens run
against an on-prem Ollama instance — no questions ever leave the school LAN.
When `AI_PROVIDER=ollama` the api-server calls `OLLAMA_BASE_URL/api/generate`
with a Tanzania-specific system prompt; if Ollama is unreachable K9 silently
falls back to a small canned answer set so the classroom keeps moving.

To install on a school server (Ubuntu 22.04+):

```bash
sudo MODEL=mistral:7b ./scripts/setup-ollama.sh
```

Then set on the api-server:

```
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

The model comes from the K9 registry (`config/k9-models.json`): the brain is
Qwen3-VL-8B-Instruct (`k9-qwen3-vl`, imported from
`C:\KobeOS\Models\k9\brain\qwen3-vl-8b` and quantized to Q4_K_M), then Qwen2.5-7B,
Mistral, Llama 3, Phi-3 and DeepSeek from the GGUF files under
`C:\KobeOS\Models`. `node scripts/k9-models.mjs ollama-sync` builds them into
Ollama. Set `OLLAMA_MODEL` to pin one model instead.

Health and a one-shot prompt tester are exposed for admins:

- `GET  /api/v1/admin/ai/health` (teacher/admin token)
- `POST /api/v1/admin/ai/test`   (teacher/admin token, body: `{question, system?}`)

The Teacher Dashboard surfaces both at **School AI** in the sidebar.

## Repository layout

This is one pnpm-workspace monorepo. K-9 and KobeVoice are committed directly
inside KobeAI as normal directories; there are no Git submodules and a normal
`git clone` contains the complete source tree.

```
artifacts/
  api-server/          Express API + JWT auth + Drizzle
  teacher-dashboard/   React/Vite teacher web app
  teacher-lens/        Teacher-worn phone / AR-glasses PWA
  classroom-tv/        Classroom PC + TV kiosk
  parent-app/          React/Vite parent PWA
  mockup-sandbox/      Canvas component preview server
config/
  k9-models.json       Canonical K9 model registry — every model path and brain
desktop/               K9 Windows installer (Electron + embedded PostgreSQL)
glasses/               Kobe Glasses SDK — one interface, many vendors (staff only)
lib/
  db/                  Drizzle schema (users, classes, documents, …)
  api-spec/            OpenAPI source of truth
  api-client-react/    Generated react-query hooks (Orval)
services/
  k9-network/          Full vendored K-9 LAN/camera discovery source
  k9-bridge/           K-9 → KobeAI inventory sync bridge
  k9-runtime/          Local model runtime (detection, tracking, faces, ReID, VAD)
  kobevision/          Local camera/face-analysis service
  kobevoice/           Full vendored KobeVoice/LiveKit voice-agent source
tap-box/               Raspberry Pi print agent (Python)
deploy/
  school-server/       Docker compose for on-prem deployments
.github/workflows/     CI (typecheck + build on PR)
```

## Quickstart (development)

Requires Node 24 and pnpm.

```bash
pnpm install
pnpm --filter @workspace/db run push   # apply schema to local PG
pnpm --filter @workspace/api-server run dev
```

The Replit workspace also runs the teacher dashboard, parent app, and
mockup sandbox as separate workflows on path-prefix routes.

### Demo credentials

Development seeds only — `NODE_ENV=development` is the only env in which they
are honoured, and the desktop/ISO builds do not seed them at all. A real
school server has no accounts until someone completes the install wizard.

| Role | Login | Password |
|---|---|---|
| Teacher | `teacher@school.tz` | `teacher123` |
| Admin | `admin@school.tz` | `admin123` |
| Parent | (any registered phone) | `1234` |

## Required environment

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | JWT signing secret (required outside `NODE_ENV=development`) |
| `SESSION_SECRET` | Express session secret |
| `TAP_BOX_SECRET` | Shared secret presented by print agents |
| `CLASSROOM_KIOSK_SECRET` | Optional — lets classroom TVs call `/v1/classroom/*` without a staff login |
| `REDIS_URL` | Optional — switches live print-job state to Redis |
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID` | Object storage bucket for uploaded PDFs |
| `PUBLIC_OBJECT_SEARCH_PATHS` | Object storage public search paths |
| `PRIVATE_OBJECT_DIR` | Object storage private dir |
| `K9_OPERATOR_SECRET` | Optional — the ONLY way a `super_admin` can be created. Set it on operator-run servers; never on a school's. Without it `/v1/setup/operator/unlock` answers 404 |
| `AI_PROVIDER` | `ollama` turns the on-prem brain on (market agent, paper reading, classroom assistant) |
| `OLLAMA_BASE_URL` | Where Ollama lives (default `http://localhost:11434`) |
| `OLLAMA_MODEL` | Optional — pins one text model instead of the K9 registry's list |
| `OLLAMA_VISION_MODEL` | Optional — pins one image-reading model for the paper reader |

## Deploying a school server

**Windows PC:** install `K9-Setup-<version>.exe` (built from `desktop/`, see
`desktop/README.md`). It bundles PostgreSQL, the API and all dashboards,
serves the school LAN on port 8088, and runs from the system tray.

**Linux server:** the `deploy/school-server/` compose file brings up Postgres, Redis,
the API server, and the dashboards behind a single nginx, designed to
run on a school's own hardware (a NUC or mid-range tower is enough).
Classroom PCs, Teacher Lens devices and print agents on the LAN talk to
this server. No internet required for core operation.

## Print agent hardware

A print agent is ~$30:

- Raspberry Pi Zero 2 W (any Pi 3+ also works)
- microSD + power supply

Install with `sudo bash tap-box/install.sh`, edit
`/etc/default/kobeai-tap-box`, add the printer to CUPS, and start the
systemd unit. See `tap-box/README.md` for the full setup.

## License

Proprietary — KobepayTech, all rights reserved, except vendored third-party
components that retain the licenses included in their own directories.
