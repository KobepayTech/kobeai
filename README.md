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

See `docs/K9_ARCHITECTURE.md`, `docs/TEACHER_LENS.md` and
`docs/K9_MODEL_STACK.md` for the full design.

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
OLLAMA_MODEL=mistral:7b
```

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
lib/
  db/                  Drizzle schema (users, classes, documents, …)
  api-spec/            OpenAPI source of truth
  api-client-react/    Generated react-query hooks (Orval)
services/
  k9-network/          Full vendored K-9 LAN/camera discovery source
  k9-bridge/           K-9 → KobeAI inventory sync bridge
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

## Deploying a school server

The `deploy/school-server/` compose file brings up Postgres, Redis,
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
