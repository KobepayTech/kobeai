# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## KobeAI Print System (api-server)

- **Auth**: JWT bearer tokens issued by `/auth/*` and `/watch/login` routes; `requireAuth(roles?)` middleware (`lib/auth.ts`) protects all `/watch/*`, `/parent/*`, `/teacher/*`, and the watch-facing print routes (`/print/pairing/:id`, `/print/pairing-for-session/:id`, `/print/submit`, `/print/jobs/:id`). Tap-box endpoints (`/print/pair`, `/print/next`, `/print/jobs/:id/document`, `/print/jobs/:id/status`) still use `x-tap-box-secret`. Only the login routes themselves are public. Print routes additionally enforce per-student ownership; teacher routes restrict reads/writes to the teacher's own classes/documents (admin can act on all). `JWT_SECRET` is required in non-development environments — startup fails fast if unset.
- **Data model** (`@workspace/db`): `users`, `classes`, `class_memberships`, `documents`, `document_assignments`. Seed (`lib/seed.ts`) is idempotent and uploads two demo PDFs to object storage assigned to Form 1A.
- **Documents**: teacher uploads via presigned object-storage URL (`POST /teacher/documents/upload-url`), then registers (`POST /teacher/documents`) and assigns to class (`POST /teacher/documents/:docId/assign` with `{ class_id }`). Print pair endpoint resolves available files via class_memberships → document_assignments → documents joins; tap-box `/document` streams real bytes from object storage.
- **PrintStore** (`lib/print-store.ts`): pluggable store for pairings, jobs, and nonces. `RedisStore` (when `REDIS_URL` set) uses `SET EX/NX` for atomic nonce reservation and `LIST` per-printer queues. `MemoryStore` is the in-process fallback for dev. Restart persistence verified end-to-end with redis on port 6399.
- **Demo creds preserved**: student `TEST001/1234`, teacher `teacher@school.tz/teacher123`, admin `admin@school.tz/admin123`, **super-admin `superadmin@kobeai.tz/super123`** (only role allowed into the `/central/v1/admin/*` control plane), parent pin `1234`. Watch APK does not need to be rebuilt — existing demo login flow now returns JWTs transparently.
- **Object storage env**: `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PUBLIC_OBJECT_SEARCH_PATHS`, `PRIVATE_OBJECT_DIR` are required.

## Teacher Dashboard

- **Documents page** (`src/pages/documents.tsx`): lists the teacher's uploaded PDFs and lets them upload new ones (via presigned URL → register → optional class assign) and assign existing docs to classes. Wired into `/documents` route + sidebar nav with the `FileText` icon.
- **API helper** (`src/lib/api.ts`): minimal `apiGet`/`apiPost`/`uploadToPresigned` that attaches the bearer token from `localStorage["teacher_token"]`. Used by pages whose endpoints aren't yet codegenned via `@workspace/api-client-react`.

## Parent App

- **Print page** (`src/pages/print.tsx`): new bottom-nav tab "Print". Calls `GET /api/v1/parent/child/:childId/documents` and renders the documents assigned to each child's class(es) — same join the watch print picker uses, so parents always see exactly what's available for tap-to-print. Per-child tab switcher when more than one child is on the account; honest empty state when nothing is assigned yet.
- **API helper** (`src/lib/api.ts`): minimal `apiGet` that bypasses BASE_URL and hits absolute `/api/...` (the Replit proxy routes `/api/*` to the api-server artifact regardless of origin, matching what the codegen client does). Bearer token from `localStorage["parent_token"]`.
- **Backend**: `routes/parent.ts` exposes `/v1/parent/child/:childId/documents`. Demo bridge `CHILD_TO_STUDENT_CODE` maps child id "1" -> `TEST001` until a parents schema with a real FK lands.
- **Shared**: `lib/student-documents.ts` extracts the class_memberships → document_assignments → documents query; both `routes/print.ts` and `routes/parent.ts` import it so watch and parent app can never disagree.

## Offline AI (Ollama)

- **Provider** (`lib/ai-provider.ts`): `askAI(question, systemOverride?)` tries Ollama when `AI_PROVIDER=ollama`, silently falls back to canned answers on any failure (offline-first by design). New `getAiHealth()` probes `/api/tags` to report reachability + installed models + latency. `OLLAMA_BASE_URL` (default `http://localhost:11434`), `OLLAMA_MODEL` (default `mistral:7b`), `OLLAMA_TIMEOUT_MS` (default 30000).
- **Admin endpoints** (`routes/admin.ts`): `GET /v1/admin/ai/health`, `POST /v1/admin/ai/test {question, system?}` — both require teacher OR admin token. Legacy `/v1/admin/stats` stays open to preserve the school-server admin CLI.
- **Teacher Dashboard "School AI" page** (`src/pages/school-ai.tsx`): sidebar entry with `Cpu` icon at `/school-ai`. Shows status pill (Online / Ollama unreachable / Model not pulled / Canned), health grid with provider, configured model, base URL, latency, installed models, last error. Includes a one-shot prompt tester that hits `/v1/admin/ai/test`. Inline remediation hints (`ollama pull <model>`, `scripts/setup-ollama.sh`) when something is wrong.
- **Setup script** (`scripts/setup-ollama.sh`): one-shot installer for the on-prem LLM on Ubuntu 22.04+. Installs Ollama, configures the systemd service to listen on `0.0.0.0:11434`, pulls the model, smoke-tests with a single prompt. Run as root: `sudo MODEL=mistral:7b ./scripts/setup-ollama.sh`.

## Multi-Tenant Control Plane (central server)

KobeAI is designed to run with **N school servers + 1 central server**. Each
school's local api-server enforces subscriptions and stores data on its own
LAN; the central server is the source of truth for tenants and per-student
subscriptions, and pulls usage stats. For the demo both run in the same
Express process — in production, deploy `central` separately.

- **Schema** (in `lib/db`): `tenants` (one per school, with a `license_key`),
  `student_subscriptions` (source of truth, status `active`/`trial`/`grace`/`expired`),
  `subscription_cache` (local read-only mirror on each school server),
  `tenant_usage_snapshots` (pushed by schools, consumed by the central UI).
- **Central API** (`routes/central.ts`):
  - `GET  /central/v1/admin/tenants` — list all schools (admin JWT)
  - `POST /central/v1/admin/tenants` — create a school + issue license key
  - `GET  /central/v1/admin/tenants/:id` — detail with subs + usage
  - `POST /central/v1/admin/tenants/:id/subscriptions` — upsert a student sub
  - `DELETE /central/v1/admin/tenants/:id/subscriptions/:studentCode`
  - `POST /central/v1/sync` — **called by school server**, auth via `x-tenant-license-key`, returns the tenant's subscription snapshot
  - `POST /central/v1/usage` — school pushes a usage snapshot
- **Local sync agent** (`lib/central-sync.ts`): pulls central every
  `CENTRAL_SYNC_INTERVAL_MS` (default 60s), replaces the `subscription_cache`
  table. Exposes `getCachedSubscription()` and the `requireActiveSubscription()`
  middleware. Wired around `/v1/watch/ask` and `/v1/watch/attendance/checkin`.
  Always sets `x-subscription-status` response header so the watch can show a
  banner; only hard-blocks (HTTP 402) when `ENFORCE_SUBSCRIPTIONS=true`.
- **License keys** (`lib/license.ts`): `kobeai_lk_<48 chars>`, compared in
  constant time. Generated server-side; never derived from anything.
- **Auto-wire for the demo** (`index.ts` boot): seeds 3 demo tenants,
  auto-sets `CENTRAL_BASE_URL=http://127.0.0.1:$PORT` and `TENANT_LICENSE_KEY`
  to Karatu's key when those env vars aren't already set, so the local sync
  has something to talk to without manual config.
- **Env vars (per school)**: `CENTRAL_BASE_URL`, `TENANT_LICENSE_KEY`,
  optional `CENTRAL_SYNC_INTERVAL_MS`, `ENFORCE_SUBSCRIPTIONS=true|false`.
- **Central Admin UI** (in teacher-dashboard, gated by admin login):
  `/central` lists schools with active/total students, MRR, last-sync, AI/print
  counts; `/central/:id` shows the license key (masked, copyable), per-student
  subscription table with add/edit dialog (status, plan, price, expiry, parent
  phone), and recent usage snapshots.
- **Demo seed**: tenants Karatu (pro), Mwanza Tech Prep (standard), Dodoma
  Academy (trial). Karatu has 5 subs covering every status — active, trial,
  grace, expired — so the UI badges are immediately exercisable.

## CI / GitHub

- Repo: `KobepayTech/kobeai` (private). `origin` is configured token-less; pushes use the GitHub connector.
- `.github/workflows/ci.yml` runs `pnpm typecheck` + `pnpm build` on every push to `main` and every PR (Node 24, pnpm 9, frozen lockfile).
