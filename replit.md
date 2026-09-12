# Overview

KobeAI is a pnpm workspace monorepo using TypeScript, designed to build a comprehensive educational ecosystem. The project aims to provide an integrated solution for schools, including a teacher dashboard, parent application, classroom TV displays, and the teacher-worn Teacher Lens. Students do not carry devices: K9 identifies them through school cameras. Key features include AI-powered classroom assistance, quiz management, camera-based attendance, staff-initiated printing, and a multi-tenant control plane for managing schools and student subscriptions. The business vision is to empower schools with modern, accessible tools for enhanced learning and administration, with market potential in educational technology sectors.

# User Preferences

I prefer iterative development, with a focus on delivering functional components that can be tested and integrated continuously. Please use clear and concise language in explanations and documentation. Before making any major architectural changes or introducing new dependencies, please ask for my approval. Ensure that all code is type-safe and follows modern TypeScript best practices.

## Naming conventions
- **In-app reward/score currency is called `KP`** (KobeAI Points). Do **not** use "EduCoin", "EduCoins", or "EC" anywhere in code, UI, schema, or documentation. The question-market and any future reward features must use `KP` as the unit (e.g. `kp_balance`, `kp_awarded`, `+50 KP`).
- Real-world currency is **TSh** (Tanzanian Shilling), e.g. `TSh 50,000` for membership.

## Question market (KP economy)
- Tables: `market_questions`, `question_locks`, `kp_ledger`, `student_kp` (see `lib/db/src/schema/index.ts`).
- Routes mounted at `/api/v1/student/market/*` (student JWT). Lock cost = 10 KP, lock duration = 5 min, configurable in `routes/market.ts`.
- Atomicity: every KP write happens inside a Drizzle transaction that updates `student_kp` AND inserts a `kp_ledger` row in the same tx. The ledger is the audit trail; `student_kp.balance` is the denormalized fast-read.
- Stale locks (expired but not released) are self-healed on the next lock attempt against that question, and hidden by `/questions` reads.
- Membership KP grant: every successful M-Pesa payment in `central.ts:completePayment` credits `MEMBERSHIP_KP_GRANT` (default 100 KP) inside the same transaction that flips the payment to `success`. If the `users` row doesn't exist yet (student paid for but not provisioned), the grant is parked in `kp_pending_grants` keyed by `student_code` and drained later — see below.
- Pending-grant drain (`lib/kp.ts:drainPendingGrants`): at-most-once, race-safe via `FOR UPDATE SKIP LOCKED` + a `WHERE claimed_at IS NULL` CAS. Triggered from `GET /v1/student/market/me` so the student sees credits the moment they open the market. It is a no-op (one indexed pre-check) when nothing is pending.

## Question market agent
- The market is stocked by an agent, not by hand: `lib/market-agent.ts`, scheduled from `index.ts`, plus `market_agent_runs` and `market_agent_settings`. Full design in `docs/K9_MARKET_AGENT.md`.
- Every posted question is verified by a second model pass with the answer key hidden; a draft the two passes disagree on is never posted. An unreachable brain means "not verified", so nothing is posted — it falls back to recycling `quiz_questions` instead.
- `kp_reward` is set by the agent from difficulty × scarcity, clamped to the operator's `reward_min`/`reward_max` band. `max_open_questions` caps total open liability. The agent never touches balances; KP still only moves through `kp_ledger`.
- Students only see `review_status = 'approved'` questions, and only subjects they take once `student_subjects` has rows for them.
- Operator console at `/central/v1/admin/market-agent` (`super_admin` only) — dry-run plan, settings, review queue, run history.

## School fees (money, NOT KP)
- `student_kp` is a REWARDS balance and must never be used as an account receivable. School fees live in `fee_structures`, `fee_accounts`, `fee_transactions`, `payment_matches`; full design in `docs/K9_BURSAR_AI.md`.
- Every write goes through `lib/fees.ts:post()` — routes never touch the tables directly. It takes `SELECT … FOR UPDATE` on the account and writes the ledger row and the cached balance in one transaction, so `fee_accounts.balance_tsh == SUM(fee_transactions.delta_tsh)` always holds. `GET /v1/fees/verify` recomputes and reports drift.
- Sign convention: a balance is what the student OWES. charge +, payment −, waiver −, reversal = the opposite of the row it undoes. Nothing is edited or deleted.
- Partial unique indexes are the controls: one payment per `reference`, one charge per `(student_id, fee_structure_id)`.
- Reconciliation (`lib/payment-reader.ts`, `/v1/fees/reconcile/*`) reads M-Pesa confirmations with a regex first and the vision model second, proposes a student with a stated reason, and posts nothing until a human confirms. Two plausible candidates → no proposal.
- Removed in this change: `buildBalances()` and the fabricated student list, the hard-coded billing summary, and `/v1/bursar/deposit` (which credited the KP ledger with shillings). Bulk invoicing now uses real parent phones from `parent_children` instead of deriving them from the student id.

## School setup and the operator boundary
- A school server ships with no accounts. `POST /v1/setup/school` (public, once) creates the tenant, the `school_setup` row and the school's own administrator — always role `admin`.
- **The install flow has no path to `super_admin`.** The operator console requires `K9_OPERATOR_SECRET` in the environment AND the school's setup password at `/v1/setup/operator/unlock`; without the env var that route answers 404. Never set it on a school's server.
- The dashboard nav is built from `GET /v1/me/capabilities`, defaulting closed. That is the courtesy; `requireAuth(["super_admin"])` on the central router is the enforcement.

## Staff and student onboarding
- Teachers onboard from a printed QR: `teacher_invites` (token hash only) → `/lens/#/onboard/<token>` → a personalisation form → account minted and signed in. `staff_profiles` holds the nickname, language, teaching style and briefing length K9 uses for them.
- Class lists and Form 3+ subject-option sheets are photographed, read by the vision model (`lib/paper-reader.ts`), checked by the teacher, then committed. `paper_imports` holds the proposal; nothing writes to `users` until commit. `student_subjects` holds who takes what.
- `GET /v1/onboarding/face-queue` drives the face walk: one name at a time, shutter, next, into the existing `/v1/faces/students/:code` enrolment.
- Full flow in `docs/K9_ONBOARDING.md`.

# System Architecture

## Monorepo Structure
The project is a pnpm workspace monorepo, with each package managing its own dependencies. Node.js 24 and TypeScript 5.9 are the core technologies.

## API Server (`api-server`)
- **Framework**: Express 5.
- **Database**: PostgreSQL with Drizzle ORM for schema management.
- **Validation**: Zod for schema validation.
- **API Codegen**: Orval is used to generate API hooks and Zod schemas from an OpenAPI specification.
- **Authentication**: JWT bearer tokens are used for most routes, with role-based access control managed by `requireAuth` middleware. Print-agent (tap-box) endpoints use `x-tap-box-secret`.
- **Data Model**: Core entities include `users`, `classes`, `class_memberships`, `documents`, and `document_assignments`.
- **Document Management**: Teachers upload documents via presigned object-storage URLs, register them, and assign them to classes with optional scheduling (`scheduled_at`, `expires_at`).
- **PrintStore**: Pluggable store for live print jobs queued by staff (`POST /v1/print/jobs`). `RedisStore` provides persistence and atomic operations, while `MemoryStore` serves as an in-process fallback for development.
- **Payment System**: Integrates with M-Pesa STK push for subscription payments. The system handles payment initiation, status tracking, and subscription renewal with idempotency.
- **Object Storage**: Requires configuration for `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PUBLIC_OBJECT_SEARCH_PATHS`, and `PRIVATE_OBJECT_DIR`.

## Teacher Dashboard
- **Technology**: React-based frontend.
- **Features**:
    - **Documents Page**: Allows teachers to upload, assign, and manage PDFs, including setting availability windows.
    - **School AI Page**: Displays the health and status of the integrated Ollama AI, providing a prompt tester and remediation hints.
    - **Quiz Authoring**: Teachers can create multi-question quizzes with correct-answer picking and view per-quiz leaderboards.
    - **Timetable**: Weekly grid editor (Mon–Sun × periods) for adding/removing class periods with subject and minute-of-day ranges. Class-scoped: teachers can only edit their own classes.
    - **Exam Mode**: Live countdown supervisor at `/exams` with start/pause/resume/+time/−time/finish controls. Server-of-truth timer (status `active` → `ends_at` is wall-clock deadline; `paused`/`scheduled` → `remaining_seconds` is authoritative). State transitions are atomic CAS (`UPDATE ... WHERE id=? AND status=?`) so concurrent supervisor actions can't lose updates. Partial unique index enforces one open exam per class.
- **UI/UX**: Uses `FileText` icon for documents and `Cpu` icon for School AI.

## Parent App (PWA)
- **Distribution**: installed via a link, not from any app store. Parents open `<deployment-origin>/parent/` in their phone browser:
    - **Android (Chrome)**: an in-app banner ("Install KobeAI") fires on `beforeinstallprompt` and adds the icon to the Home Screen with one tap.
    - **iOS (Safari)**: the same banner shows a step-by-step "Add to Home Screen" sheet (Safari can't auto-prompt).
    - Banner is dismissible and snoozes for 72h via `localStorage["kobeai.install.dismissed"]`.
- **Manifest**: `public/manifest.webmanifest` declares `display: standalone`, `theme_color: #00A86B`, scope `./` (relative — works under any `BASE_PATH`), and three PNG icons (192/512/maskable-512) plus a 180px `apple-touch-icon.png`. All PNGs are generated from a single brand SVG by `pnpm --filter @workspace/parent-app run icons` (Sharp).
- **Service worker** (`public/sw.js`): two roles — (1) web-push for parent notifications (VAPID, `/api/v1/parent/push/*`), and (2) offline app-shell. Strategy: network-first for HTML navigations (cached fallback when offline), cache-first for static assets, never caches `/api/*`. Bump `CACHE_VERSION` on UI releases that should reach offline users.
- **Distribution helper**: `/parent-install` page in the teacher dashboard (sidebar: "Parent Install Link") shows the install URL, a downloadable QR code, a pre-filled WhatsApp/SMS message, and a print-poster button — bursars can ship it to every parent in the school.

## Parent App
- **Technology**: React-based frontend.
- **Features**:
    - **Print Page**: Shows documents assigned to children's classes. Includes print history.
    - **Print History Page**: Displays a chronological log of handouts staff printed for the child, with status and page counts.
- **UI/UX**: Features a bottom-nav tab for "Print" and a "View print history" pill.

## Offline AI (Ollama Integration)
- **Provider**: `askAI(question, systemOverride?)` function attempts to use Ollama (`AI_PROVIDER=ollama`) with a fallback to canned answers if offline.
- **Health Checks**: `getAiHealth()` probes Ollama for reachability, installed models, and latency.
- **Configuration**: Uses `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, and `OLLAMA_TIMEOUT_MS` environment variables.
- **Setup Script**: `scripts/setup-ollama.sh` automates Ollama installation and configuration on Ubuntu.

## Multi-Tenant Control Plane (`central` server)
- **Architecture**: Designed for N school servers + 1 central server. In demo, runs within the same Express process.
- **Schema**: Manages `tenants`, `student_subscriptions`, `subscription_cache`, and `tenant_usage_snapshots`.
- **Central API**: Provides endpoints for managing tenants, student subscriptions, and synchronization with school servers.
- **Local Sync Agent**: `central-sync.ts` pulls subscription data from the central server at regular intervals, populating `subscription_cache`. Enforces subscriptions via `requireActiveSubscription()` middleware.
- **License Keys**: `kobeai_lk_` prefixed 48-character license keys for tenant authentication.
- **Super-admin endpoints** (under `/central/v1/admin/*`, gated by `requireAuth(["super_admin"])`):
    - `GET/POST/PATCH /central/v1/admin/market/questions` — operator-curated Question Market CRUD; list returns `active_locks` per question; PATCH only allows `status ∈ {open, expired}` (won/locked are system-managed); `kp_reward` clamped to `[1, 100000]`.
    - `GET /central/v1/admin/kp/stats` — headline numbers for the global KP economy: `entries_24h`, `net_kp_24h`, `pending_grants` (in `kp_pending_grants` awaiting onboarding), and a conservation check (`Σ ledger.delta == Σ student_kp.balance`) that surfaces seed/migration drift.
    - `GET /central/v1/admin/kp/ledger?limit=&tenant_id=` — append-only ledger with school resolution via a `LATERAL` subquery on `student_subscriptions` (tenant filter is applied in SQL so paging stays correct).
- **Parent app payment success**: `GET /central/v1/payments/:id` returns `kp_granted` (defaults to `MEMBERSHIP_KP_GRANT=100` env var when payment status is `success`) so the parent app can render a "+100 KP Bonus" card after a successful subscription.

## K9 clients
- **No student devices**: the Wear OS watch app and `/api/v1/watch/*` were removed. Students are identified by cameras and served through the classroom PC + TV.
- **Classroom TV** (`artifacts/classroom-tv`), **Teacher Lens** (`artifacts/teacher-lens`), and the **print agent** (`tap-box/`) are the LAN clients. Non-camera clients register via `/api/v1/devices/*`.
- Student-JWT reads that remain (timetable, active exam, question market) live under `/api/v1/student/*` for shared school PCs.

## Ad Exchange (self-serve)

Runs as its own Express service (`artifacts/ads-server`) — isolated from the
school API for hot-path independence and independent scaling. Mounted by the
platform proxy at `/ads-api/*`. Shares `SESSION_SECRET` (JWT + HMAC) with the
main api-server so admin tokens issued by `/api/v1/auth/teacher/login` are
accepted by the ads-server's admin endpoints.

- **Tables** (in `lib/db`): `advertisers`, `advertiser_users`, `ad_campaigns`,
  `ad_creatives`, `ad_placements` (seeded), `ad_impressions`, `ad_clicks`,
  `ad_ledger`, `ad_frequency_caps`.
- **Routes** (all under `/ads-api`):
    - `ads.ts` — public `GET /v1/ads/serve?placement=…` returns
      `{ ad: { impression_token, placement_id, campaign_id, pricing_model,
      creative: { id, format, title, body, image_url, cta_url, cta_label,
      width, height } } }`. Tokens are HMAC-SHA256 signed (imp+cmp+cre+pl+exp,
      30 min); `POST /v1/ads/event { token, type }` charges advertiser ledger.
    - `advertiser.ts` — signup/login/me/campaigns/creatives/stats/topup/ledger.
    - `admin-ads.ts` — admin moderation (requires admin JWT from main api):
      `GET /v1/admin/ads/{advertisers,campaigns,revenue,ledger}`,
      `PATCH /v1/admin/ads/campaigns/:id { status: active|paused|rejected }`.
- **Clients**:
    - Advertiser Portal artifact (`artifacts/advertiser-portal`).
    - Parent app `<AdBanner>` mounted on dashboard + stationery pages.
    - Developer Portal `/ads-admin` page (admin login → moderate campaigns +
      view exchange revenue).

# External Dependencies

- **pnpm**: Monorepo package manager.
- **Node.js**: Runtime environment (v24).
- **TypeScript**: Programming language (v5.9).
- **Express**: Web application framework (v5).
- **PostgreSQL**: Relational database.
- **Drizzle ORM**: TypeScript ORM for PostgreSQL.
- **Zod**: Schema declaration and validation library (`zod/v4`).
- **drizzle-zod**: Integration between Drizzle and Zod.
- **Orval**: OpenAPI code generator.
- **esbuild**: Bundler for JavaScript and TypeScript.
- **Redis**: In-memory data store (for `RedisStore` in PrintStore).
- **Ollama**: Local LLM provider for offline AI capabilities.
- **M-Pesa STK Push**: Mobile payment gateway for subscription payments.
- **GitHub**: Version control system and CI/CD integration.
- **`x-tap-box-secret`**: Custom authentication mechanism for print-agent (tap-box) endpoints.
- **JWT**: JSON Web Tokens for authentication.

# Planned KobeAI Distributed Runtime

This section records the agreed direction for extending KobeAI beyond a single Ollama host. The goal is to keep KobeAI's own application-level AI router in control while using proven open-source infrastructure for two lower-level jobs: distributing inference across spare computers and isolating agent execution.

## NVIDIA Personal AI Router (PAIR)

PAIR is software, not special NVIDIA server hardware. It is installed on participating computers on the same trusted local network and exposes inference endpoints that applications can use while PAIR decides which eligible machine serves each independent request.

### Role in KobeAI

KobeAI should **not** replace its model/intent router with PAIR. The responsibilities are different:

- **KobeAI AI Router** decides *what* should answer: everyday assistant, reasoning model, coding model, vision model, retrieval flow, deterministic tool, or agent.
- **PAIR** decides *where a selected model request should physically run* among paired machines that are online, have a compatible inference engine running, have the requested model available, and have suitable current capacity.
- **Ollama / LM Studio** remain the actual local inference engines underneath PAIR.

Proposed request path:

```text
Teacher Lens / Teacher Dashboard / Classroom TV / API client
                    |
                    v
              KobeAI AI Router
          +---------+----------+
          |                    |
    deterministic tool      LLM request
                               |
                               v
                         PAIR adapter
                               |
                 +-------------+-------------+
                 |             |             |
              School PC     Office PC     Spare PC
              Ollama        Ollama        LM Studio
```

### Integration approach

Do not vendor or copy the whole PAIR project into KobeAI. Add a provider/adapter so KobeAI can talk to the Ollama-compatible or OpenAI-compatible proxy endpoint exposed by PAIR. This keeps PAIR independently upgradable and allows one-machine KobeAI deployments to continue working without a cluster.

Proposed provider order:

```text
KobeAI Router
  -> PAIR when configured and healthy
  -> direct local Ollama fallback
  -> optional remote/server fallback when policy permits
```

Suggested configuration contract for the future implementation:

- `AI_PROVIDER=pair|ollama|...`
- `PAIR_BASE_URL` — configured PAIR proxy endpoint; no hard-coded port until implementation verifies the deployed PAIR version.
- Existing `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, and timeout settings remain valid as the direct-local fallback.
- Health/status output should expose PAIR reachability, connected node count, model availability, selected provider, latency, and fallback reason without leaking private node details to students.

### Important PAIR limitation

PAIR distributes **independent inference requests**. It does not combine multiple GPUs into one larger logical GPU, pool VRAM, shard one model across several machines, or split one in-flight request across nodes. A model must fit on a single eligible machine. Multiple machines primarily improve concurrency, throughput, resilience, and utilization of otherwise idle compute.

### Storage and package-size implications

PAIR itself is small compared with AI model weights (installer/package size varies by operating system and release and is in the hundreds-of-megabytes class rather than multi-GB model size). Model files remain managed by the inference engines and can consume several GB each. KobeAI deployment planning must therefore separate:

1. KobeAI application size.
2. PAIR software size.
3. Ollama/LM Studio engine size.
4. AI model weight storage, which is normally the dominant disk requirement.

A node only needs to store models it is expected to serve; the same model may be replicated to several nodes when load-sharing or failover is wanted.

### Deployment modes

- **Single machine**: KobeAI -> direct Ollama; PAIR optional.
- **Small school cluster**: PAIR on the school server plus one or more spare RTX/AI-capable PCs on the LAN.
- **Headless school server**: use PAIR's headless/terminal runtime rather than requiring its desktop UI.
- **Mixed machines**: treat each node according to what its installed inference engine and memory can actually support; PAIR presence alone does not guarantee that a specific model will run on that machine.

## Tencent Cloud CubeSandbox (Cube Sandbox)

The Tencent project discussed as "CubeBox" is recorded here using its official open-source project name, **CubeSandbox / Cube Sandbox**. Its job is different from PAIR: it provides fast, hardware-isolated execution environments for AI agents and tool-running workloads.

### Role in KobeAI

CubeSandbox becomes the **agent execution layer**, not the model inference layer. When the KobeAI router decides an agent must execute code, manipulate temporary files, run a browser/tool workflow, or perform another untrusted/generated operation, KobeAI should create or reuse an isolated CubeSandbox environment and execute that work there.

```text
                    KobeAI AI Router
                    /             \
                   /               \
          Model inference        Agent/tool task
                |                     |
              PAIR              CubeSandbox API
                |                     |
        Ollama / LM Studio        MicroVM sandbox
                                      |
                               code / tools / files
```

### Why it fits KobeAI

- Hardware-isolated MicroVMs give generated code a stronger security boundary than running it directly in the KobeAI API process.
- CubeSandbox is designed for rapid sandbox startup and high concurrency.
- Snapshot/clone/rollback capabilities can support long-running school agents, repeatable tool environments, and recovery after a failed action.
- E2B-compatible APIs make it possible to keep the KobeAI-facing sandbox adapter relatively portable.
- Network/egress policy should be used so school agents only reach approved services and cannot freely expose secrets or scan the LAN.
- Persistent school records, student profiles, credentials, and primary databases must remain outside disposable sandboxes. Sandboxes receive only the minimum scoped data required for a task.

### Size clarification

CubeSandbox's published sub-5-MB figure refers to **memory overhead per sandbox instance**, not the total installation size. A deployment also includes control-plane/runtime components, guest images/templates, storage, and any tools installed inside sandbox images. Capacity planning must not treat "<5 MB" as the software's install footprint.

### Host/deployment assumptions

CubeSandbox is primarily a Linux virtualization workload using KVM/RustVMM-style MicroVM infrastructure; production planning must verify KVM/PVM support on the intended school-server hardware or cloud/VPS environment. Newer releases also include broader deployment and architecture support, but KobeAI should gate the feature behind a host capability check rather than assume every Windows classroom PC can run the sandbox stack directly.

## Combined KobeAI Architecture

PAIR and CubeSandbox are complementary and should sit beneath KobeAI rather than replace KobeAI's own orchestration logic.

```text
Students / Teachers / Parents / School Displays / APIs
                        |
                        v
                  KobeAI Gateway
                        |
                        v
                  KobeAI AI Router
        +---------------+----------------+
        |               |                |
  deterministic       inference       agent/tool
      tools              |                |
                         v                v
                       PAIR          CubeSandbox
                         |                |
              +----------+------+     isolated
              |          |      |      MicroVM
           PC/node    PC/node PC/node     |
           Ollama     Ollama  LM Studio   tools
```

The router remains responsible for intent classification, model selection, retrieval/tool decisions, safety policy, authentication, tenant boundaries, caching, and whether a request should stay local or use an approved remote fallback. PAIR handles physical inference placement. CubeSandbox handles isolated execution.

## KobeAI Router Evolution

The longer-term router should support the following behavior without forcing every request through the most expensive model:

1. Classify the request and use deterministic code/tools when an LLM is unnecessary.
2. Route normal conversation and tutoring to a fast everyday model.
3. Route difficult reasoning to a reasoning model only when needed.
4. Route programming tasks to a coder model.
5. Route image/document understanding to a vision-capable model.
6. Run retrieval only for requests that actually need school/library context.
7. Execute independent tool or sub-agent work in parallel when safe.
8. Stream tokens/results to clients rather than waiting for the entire response.
9. Keep frequently used local models warm/resident where practical.
10. Cache safe repeatable outputs and retrieval results.
11. Record per-stage latency so the School AI page can show whether delays come from routing, queueing, model inference, retrieval, or tools.
12. Use direct local Ollama when PAIR is absent; use PAIR automatically when a configured healthy cluster is available.
13. Use remote/server inference only according to explicit school policy and only when local execution cannot satisfy the request.

## Reliability and Security Rules

- A PAIR outage must not make single-node KobeAI unusable; direct Ollama fallback remains available.
- A CubeSandbox outage should disable only sandbox-dependent agent actions, not normal tutoring/chat.
- Do not send student data to arbitrary spare nodes outside the trusted school cluster.
- Pairing/cluster membership is an admin operation and should not be exposed to students.
- Agent sandboxes receive short-lived scoped credentials rather than permanent database/API secrets.
- All agent tool actions should be auditable with tenant, user, task, sandbox, start/end time, result, and error metadata.
- Apply resource limits and timeouts so one agent cannot consume the entire school server.
- Apply egress allowlists for agent workloads.
- Keep human approval gates for actions that are financially consequential, destructive, externally publishing, or otherwise high impact.

## Implementation Plan

### Phase 1 — Provider abstraction
- Refactor the current Ollama-only `askAI()` path behind a typed provider interface.
- Preserve the existing Ollama provider and health check.
- Add model capability metadata (chat, reasoning, code, vision, embeddings/retrieval).

### Phase 2 — PAIR adapter
- Add a PAIR provider using its compatible proxy API rather than embedding the PAIR source tree.
- Add health/fallback logic and School AI admin diagnostics.
- Test one-node, two-node, node-offline, missing-model, and overloaded-node scenarios.
- Confirm streaming behavior end-to-end from PAIR through Express to the classroom/dashboard clients.

### Phase 3 — Router v2
- Add intent/capability routing, parallel tool execution, caching, latency telemetry, and model-warmth awareness.
- Avoid a second LLM pass when a deterministic router/tool result is sufficient.

### Phase 4 — CubeSandbox adapter
- Introduce a typed sandbox service interface.
- Start with code execution and temporary-file workflows.
- Add strict CPU/RAM/time/network limits and audit logs.
- Keep persistent student/school data outside sandbox filesystems.

### Phase 5 — Admin UX
- Extend the Teacher/School AI status page to show provider health, PAIR cluster capacity, available models, queue/load indicators, sandbox capacity, recent failures, and fallback state.
- Provide remediation actions to admins without exposing infrastructure controls to students.

### Phase 6 — Packaging
- Keep PAIR and CubeSandbox as independently versioned runtime dependencies/services rather than copying their source into the KobeAI application bundle.
- The installer may offer them as optional components based on host capability and deployment mode.
- Model downloads remain separate from the main application package so the core installer does not grow by many GB unnecessarily.

## Licensing / Dependency Policy

Both projects are open-source projects suitable for evaluation as external dependencies. Before shipping a KobeAI commercial installer that bundles or redistributes either project, pin reviewed versions, retain all required licenses/notices, review third-party notices, and perform security/license review as part of the release process. The preferred architecture is loose integration through documented local APIs, which reduces coupling and makes upgrades/rollback easier.
