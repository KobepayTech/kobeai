# Overview

KobeAI is a pnpm workspace monorepo using TypeScript, designed to build a comprehensive educational ecosystem. The project aims to provide an integrated solution for schools, including a teacher dashboard, parent application, and a Wear OS watch app for students. Key features include AI-powered tutoring, quiz management, attendance tracking, secure printing, and a multi-tenant control plane for managing schools and student subscriptions. The business vision is to empower schools with modern, accessible tools for enhanced learning and administration, with market potential in educational technology sectors.

# User Preferences

I prefer iterative development, with a focus on delivering functional components that can be tested and integrated continuously. Please use clear and concise language in explanations and documentation. Before making any major architectural changes or introducing new dependencies, please ask for my approval. Ensure that all code is type-safe and follows modern TypeScript best practices.

## Naming conventions
- **In-app reward/score currency is called `KP`** (KobeAI Points). Do **not** use "EduCoin", "EduCoins", or "EC" anywhere in code, UI, schema, or documentation. The question-market and any future reward features must use `KP` as the unit (e.g. `kp_balance`, `kp_awarded`, `+50 KP`).
- Real-world currency is **TSh** (Tanzanian Shilling), e.g. `TSh 50,000` for membership.

## Question market (KP economy)
- Tables: `market_questions`, `question_locks`, `kp_ledger`, `student_kp` (see `lib/db/src/schema/index.ts`).
- Routes mounted at `/api/v1/watch/market/*` (student JWT). Lock cost = 10 KP, lock duration = 5 min, configurable in `routes/market.ts`.
- Atomicity: every KP write happens inside a Drizzle transaction that updates `student_kp` AND inserts a `kp_ledger` row in the same tx. The ledger is the audit trail; `student_kp.balance` is the denormalized fast-read.
- Stale locks (expired but not released) are self-healed on the next lock attempt against that question, and hidden by `/questions` reads.
- Membership KP grant: every successful M-Pesa payment in `central.ts:completePayment` credits `MEMBERSHIP_KP_GRANT` (default 100 KP) inside the same transaction that flips the payment to `success`. If the `users` row doesn't exist yet (student paid for but not provisioned), the grant is parked in `kp_pending_grants` keyed by `student_code` and drained later — see below.
- Pending-grant drain (`lib/kp.ts:drainPendingGrants`): at-most-once, race-safe via `FOR UPDATE SKIP LOCKED` + a `WHERE claimed_at IS NULL` CAS. Triggered from two places: (a) `GET /v1/watch/market/me` so the student sees credits the moment they open the market, and (b) fire-and-forget on `GET /v1/watch/subscription` so polling watches deliver pending grants even if the student never opens the market. Both are no-ops (one indexed pre-check) when nothing is pending.

# System Architecture

## Monorepo Structure
The project is a pnpm workspace monorepo, with each package managing its own dependencies. Node.js 24 and TypeScript 5.9 are the core technologies.

## API Server (`api-server`)
- **Framework**: Express 5.
- **Database**: PostgreSQL with Drizzle ORM for schema management.
- **Validation**: Zod for schema validation.
- **API Codegen**: Orval is used to generate API hooks and Zod schemas from an OpenAPI specification.
- **Authentication**: JWT bearer tokens are used for most routes, with role-based access control managed by `requireAuth` middleware. Tap-box endpoints use `x-tap-box-secret`.
- **Data Model**: Core entities include `users`, `classes`, `class_memberships`, `documents`, and `document_assignments`.
- **Document Management**: Teachers upload documents via presigned object-storage URLs, register them, and assign them to classes with optional scheduling (`scheduled_at`, `expires_at`).
- **PrintStore**: Pluggable store for print pairings, jobs, and nonces. `RedisStore` provides persistence and atomic operations, while `MemoryStore` serves as an in-process fallback for development.
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
    - **Print Page**: Shows documents assigned to children's classes, mirroring the watch app's print picker. Includes print history.
    - **Print History Page**: Displays a chronological log of print jobs with status and page counts.
    - **Watch Settings Page**: Allows parents to control child-specific watch settings like `audio_enabled` and `keyboard_enabled`.
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

## Wear OS Watch App (`watch-app/`)
- **Technology**: Kotlin / Jetpack Compose for Wear OS. This component does not build within the Replit environment.
- **Backend Contract**: Interacts with `/api/v1/watch/*` endpoints for login, AI, quizzes, attendance, wallet, subscriptions, and settings.
- **Features**:
    - **Quizzes**: DB-backed quizzes with class-scoped visibility, submission persistence, and leaderboard functionality.
    - **AI Chat**: AI tutor with text input (Bluetooth keyboard support) and spoken replies (TTS, Swahili-first).
    - **Timetable Tile**: Home-screen entry showing today's periods with NOW highlight (`/v1/watch/timetable/today`).
    - **Exam Takeover**: Background poller (10s) checks `/v1/watch/exam/active`; when a supervisor starts an exam, ANY screen auto-navigates to a fullscreen countdown (color shifts at 5min / 1min thresholds, ticks locally between server polls).
    - **Bluetooth Setup**: Wizard for pairing earbuds and keyboards.
    - **Parent-Controlled Settings**: `student_settings` table allows parents to toggle `audio_enabled` and `keyboard_enabled` on the watch.

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
    - Watch `AdHomeTile` on home menu + `AdInterstitialScreen` shown before
      mini-app launch via `ads/interstitial/{appId}` route.
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
- **Android Studio**: IDE for Wear OS watch app development.
- **Kotlin / Jetpack Compose**: Technologies for Wear OS watch app development.
- **`x-tap-box-secret`**: Custom authentication mechanism for tap-box endpoints.
- **JWT**: JSON Web Tokens for authentication.