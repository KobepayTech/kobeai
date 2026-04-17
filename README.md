# KobeAI

An end-to-end educational platform built for Tanzanian secondary schools.
Designed to run on cheap on-premise hardware, work offline, and reach
parents on basic phones — all while giving students a magical
tap-to-print experience from a smartwatch.

## What's in the box

| Surface | Tech | Status |
|---|---|---|
| **Teacher Dashboard** | React + Vite + TypeScript (web) | Active |
| **Parent App** | React PWA (offline-capable) | Active |
| **Watch App** | Kotlin + Jetpack Compose for Wear OS, NFC HCE | Active |
| **API Server** | Node.js + Express 5 + Drizzle ORM (PostgreSQL) | Active |
| **Tap-Box** | Raspberry Pi Zero 2 W + ACR122U NFC reader + CUPS | Active |
| **Shared schema / API client** | Drizzle + Zod + Orval | Active |
| **On-prem AI** | Offline Ollama for grading & quiz feedback | In progress |

Brand: green `#00A86B` primary, `#1A1A2E` secondary. Currency: Tanzanian
Shilling (TSh).

## The tap-to-print system

Students wear a Wear OS watch. To print a homework handout:

1. Student taps the watch on a `tap-box` (~$50 BOM) attached to the school
   library printer.
2. The watch's HostApduService emits a signed payload over NFC.
3. The tap-box hits `/api/v1/print/pair` with that payload + its own
   shared secret.
4. The watch immediately polls `/api/v1/print/pairing-for-session/:id`,
   discovers the pairing, fetches the document list available for that
   student (joined from `class_memberships → document_assignments →
   documents`), and lets the student pick one.
5. The watch sends `/api/v1/print/submit` with an HMAC binding the
   pairing-id to the document-id.
6. The tap-box picks up the queued job from `/api/v1/print/next`,
   downloads the PDF from object storage, and prints it via CUPS.

**Security:** HMAC-SHA256 on both the watch payload and the submit;
nonce replay cache (5-min TTL); `x-tap-box-secret` for tap-box auth;
JWT bearer for everything user-facing; per-student ownership checks on
all watch-facing print endpoints.

**State:** in-flight pairings, jobs, and the seen-nonce set live in
Redis when `REDIS_URL` is set (atomic `SET NX EX` for nonces, `LIST`
queues per printer). Falls back to in-process `Map`s for local dev.

## Repository layout

This is a pnpm-workspace monorepo.

```
artifacts/
  api-server/          Express API + JWT auth + Drizzle
  teacher-dashboard/   React/Vite teacher web app
  parent-app/          React/Vite parent PWA
  mockup-sandbox/      Canvas component preview server
lib/
  db/                  Drizzle schema (users, classes, documents, …)
  api-spec/            OpenAPI source of truth
  api-client-react/    Generated react-query hooks (Orval)
watch-app/             Wear OS app (Kotlin / Jetpack Compose)
tap-box/               Raspberry Pi tap-box daemon (Python)
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
| Student (watch) | `TEST001` | `1234` |
| Teacher | `teacher@school.tz` | `teacher123` |
| Admin | `admin@school.tz` | `admin123` |
| Parent | (any registered phone) | `1234` |

## Required environment

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | JWT signing secret (required outside `NODE_ENV=development`) |
| `SESSION_SECRET` | Express session secret |
| `TAP_BOX_SECRET` | Shared secret presented by tap-boxes |
| `WATCH_HCE_SECRET` | Shared secret used by watch HMAC + server verification |
| `REDIS_URL` | Optional — switches print state to Redis |
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID` | Object storage bucket for uploaded PDFs |
| `PUBLIC_OBJECT_SEARCH_PATHS` | Object storage public search paths |
| `PRIVATE_OBJECT_DIR` | Object storage private dir |

Watch APK build:

```bash
./gradlew assembleRelease \
  -PKOBEAI_API_BASE=https://your-school-server/ \
  -PWATCH_HCE_SECRET=$(openssl rand -hex 32)
```

Set the same `WATCH_HCE_SECRET` value on the API server.

## Deploying a school server

The `deploy/school-server/` compose file brings up Postgres, Redis,
the API server, and the dashboards behind a single nginx, designed to
run on a school's own hardware (a NUC or mid-range tower is enough).
The tap-boxes on the LAN talk to this server. No internet required for
core operation.

## Tap-box hardware

A complete tap-box is ~$50:

- Raspberry Pi Zero 2 W
- ACR122U USB NFC reader
- microSD + power supply

Install with `sudo bash tap-box/install.sh`, edit
`/etc/default/kobeai-tap-box`, add the printer to CUPS, and start the
systemd unit. See `tap-box/README.md` for the full BOM and setup.

## License

Proprietary — KobepayTech, all rights reserved.
