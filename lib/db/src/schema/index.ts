import { pgTable, text, serial, timestamp, integer, uniqueIndex, primaryKey, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Core identity table. Covers students, teachers, and admins by `role`.
 * - Students: `student_code` is set (e.g. "TEST001") and `password_hash` is null
 *   when the legacy demo PIN flow handles auth.
 * - Teachers / admins: `email` + `password_hash` set.
 */
export const usersTable = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    role: text("role").notNull(), // "student" | "teacher" | "admin" | "parent"
    name: text("name").notNull(),
    student_code: text("student_code"),
    email: text("email"),
    password_hash: text("password_hash"),
    grade: text("grade"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    student_code_idx: uniqueIndex("users_student_code_idx").on(t.student_code),
    email_idx: uniqueIndex("users_email_idx").on(t.email),
  }),
);

export type User = typeof usersTable.$inferSelect;
export type InsertUser = typeof usersTable.$inferInsert;

export const classesTable = pgTable("classes", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(), // e.g. "Form 1A"
  grade: text("grade").notNull(), // e.g. "Form 1"
  teacher_id: integer("teacher_id").references(() => usersTable.id),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

export type Class = typeof classesTable.$inferSelect;

/** Many-to-many: students enrolled in classes. */
export const classMembershipsTable = pgTable(
  "class_memberships",
  {
    class_id: integer("class_id")
      .notNull()
      .references(() => classesTable.id, { onDelete: "cascade" }),
    student_id: integer("student_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.class_id, t.student_id] }) }),
);

/**
 * A document uploaded by a teacher, stored in object storage.
 * `object_path` is the canonical /objects/<id> path returned by the upload flow.
 */
export const documentsTable = pgTable("documents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  subject: text("subject").notNull().default("General"),
  pages: integer("pages").notNull().default(1),
  size_bytes: integer("size_bytes").notNull().default(0),
  content_type: text("content_type").notNull().default("application/pdf"),
  object_path: text("object_path").notNull(),
  uploaded_by: integer("uploaded_by").references(() => usersTable.id),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

export type Document = typeof documentsTable.$inferSelect;

/** Many-to-many: which class can see which document. */
export const documentAssignmentsTable = pgTable(
  "document_assignments",
  {
    document_id: integer("document_id")
      .notNull()
      .references(() => documentsTable.id, { onDelete: "cascade" }),
    class_id: integer("class_id")
      .notNull()
      .references(() => classesTable.id, { onDelete: "cascade" }),
    assigned_at: timestamp("assigned_at").defaultNow().notNull(),
    // Optional scheduling window. The watch print picker, parent app, and
    // tap-box only show the document when (now >= scheduled_at OR null) AND
    // (now < expires_at OR null). Lets teachers queue homework in advance and
    // auto-retire stale worksheets without manual cleanup.
    scheduled_at: timestamp("scheduled_at"),
    expires_at: timestamp("expires_at"),
  },
  (t) => ({ pk: primaryKey({ columns: [t.document_id, t.class_id] }) }),
);

/**
 * Persistent record of every print job. The in-memory `print_store` keeps
 * the live job state (queued / printing / done) for the tap-box flow, but it
 * evicts entries after JOB_TTL_MS. This table is the long-term audit log so
 * parents can see history and bursars can spot abuse.
 */
/**
 * Per-student watch device preferences. The parent app writes these via
 * /v1/parent/child/:childId/settings; the watch reads them on login (and on
 * each app launch) and mirrors them into local DataStore so they survive
 * being offline. Defaults assume both audio and keyboard are enabled — a
 * fresh student gets the full experience until a parent dials it back.
 */
export const studentSettingsTable = pgTable("student_settings", {
  student_code: text("student_code").primaryKey(),
  audio_enabled: boolean("audio_enabled").notNull().default(true),
  keyboard_enabled: boolean("keyboard_enabled").notNull().default(true),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
export type StudentSettings = typeof studentSettingsTable.$inferSelect;

export const printJobsTable = pgTable("print_jobs", {
  id: serial("id").primaryKey(),
  job_ref: text("job_ref").notNull().unique(),
  student_code: text("student_code").notNull(),
  student_id: integer("student_id").references(() => usersTable.id, { onDelete: "set null" }),
  document_id: integer("document_id"),
  document_name: text("document_name").notNull(),
  pages: integer("pages").notNull().default(1),
  printer_id: text("printer_id").notNull(),
  printer_name: text("printer_name"),
  status: text("status").notNull().default("queued"),
  status_message: text("status_message"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  completed_at: timestamp("completed_at"),
});

// ---------------------------------------------------------------------------
// Multi-tenant control plane: managed by the central server.
//
// In production the central server is a separate deployment that owns
// `tenants`, `student_subscriptions`, and `tenant_usage_snapshots`. Each
// school's local api-server holds a read-only `subscription_cache` populated
// by a periodic sync. For the demo, both live in the same database so the
// sync API can be exercised end-to-end.
// ---------------------------------------------------------------------------

/**
 * One row per school. The `license_key` is the bearer token a school's local
 * api-server uses to authenticate with the central sync API.
 */
export const tenantsTable = pgTable(
  "tenants",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull(), // e.g. "karatu-secondary"
    name: text("name").notNull(),
    region: text("region").notNull().default("Tanzania"),
    plan: text("plan").notNull().default("standard"), // standard | pro | trial
    license_key: text("license_key").notNull(),
    contact_email: text("contact_email"),
    contact_phone: text("contact_phone"),
    active: boolean("active").notNull().default(true),
    students_cap: integer("students_cap").notNull().default(500),
    last_sync_at: timestamp("last_sync_at"),
    last_sync_ip: text("last_sync_ip"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    slug_idx: uniqueIndex("tenants_slug_idx").on(t.slug),
    license_idx: uniqueIndex("tenants_license_idx").on(t.license_key),
  }),
);
export type Tenant = typeof tenantsTable.$inferSelect;

/**
 * Source-of-truth subscription for a single student at a single tenant.
 * Status drives gating of premium features (AI tutor, attendance points).
 *
 *  - `active`  : paid and current
 *  - `grace`   : recently lapsed but still allowed (configurable window)
 *  - `expired` : blocked
 *  - `trial`   : free trial, blocked when `expires_at` passes
 */
export const studentSubscriptionsTable = pgTable(
  "student_subscriptions",
  {
    id: serial("id").primaryKey(),
    tenant_id: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    student_code: text("student_code").notNull(),
    student_name: text("student_name").notNull(),
    plan: text("plan").notNull().default("basic"), // basic | premium | trial
    status: text("status").notNull().default("trial"),
    monthly_price_tsh: integer("monthly_price_tsh").notNull().default(0),
    parent_phone: text("parent_phone"),
    last_payment_at: timestamp("last_payment_at"),
    expires_at: timestamp("expires_at"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    tenant_student_idx: uniqueIndex("subs_tenant_student_idx").on(t.tenant_id, t.student_code),
  }),
);
export type StudentSubscription = typeof studentSubscriptionsTable.$inferSelect;

/**
 * Local read-only cache populated from the central sync API. Lets the school
 * server keep enforcing subscriptions even when central is unreachable.
 */
export const subscriptionCacheTable = pgTable(
  "subscription_cache",
  {
    student_code: text("student_code").primaryKey(),
    student_name: text("student_name"),
    status: text("status").notNull(),
    plan: text("plan").notNull(),
    monthly_price_tsh: integer("monthly_price_tsh").notNull().default(0),
    parent_phone: text("parent_phone"),
    expires_at: timestamp("expires_at"),
    synced_at: timestamp("synced_at").defaultNow().notNull(),
  },
);
export type CachedSubscription = typeof subscriptionCacheTable.$inferSelect;

/**
 * Subscription payments collected via M-Pesa STK push from the parent app.
 * Lives on the central server (the bursar of each school sees the rows for
 * their own tenant_id; central also drives subscription renewal upon success).
 *
 * Lifecycle:
 *   pending  -> STK push has been initiated, waiting on parent PIN
 *   success  -> M-Pesa callback confirmed; subscription extended
 *   failed   -> STK timeout / parent declined / insufficient funds
 */
export const subscriptionPaymentsTable = pgTable("subscription_payments", {
  id: serial("id").primaryKey(),
  tenant_id: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  student_code: text("student_code").notNull(),
  student_name: text("student_name").notNull(),
  plan: text("plan").notNull().default("basic"),
  amount_tsh: integer("amount_tsh").notNull(),
  phone: text("phone").notNull(),
  status: text("status").notNull().default("pending"),
  checkout_request_id: text("checkout_request_id").notNull(),
  mpesa_receipt: text("mpesa_receipt"),
  failure_reason: text("failure_reason"),
  initiated_at: timestamp("initiated_at").defaultNow().notNull(),
  completed_at: timestamp("completed_at"),
});
export type SubscriptionPayment = typeof subscriptionPaymentsTable.$inferSelect;

/**
 * Aggregated usage stats pushed by each school's local server. The central
 * dashboard renders these to show MRR, active student counts, AI calls, etc.
 */
export const tenantUsageSnapshotsTable = pgTable("tenant_usage_snapshots", {
  id: serial("id").primaryKey(),
  tenant_id: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  snapshot_at: timestamp("snapshot_at").defaultNow().notNull(),
  students_total: integer("students_total").notNull().default(0),
  students_active_24h: integer("students_active_24h").notNull().default(0),
  ai_questions_24h: integer("ai_questions_24h").notNull().default(0),
  print_jobs_24h: integer("print_jobs_24h").notNull().default(0),
});
export type TenantUsageSnapshot = typeof tenantUsageSnapshotsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Teacher-authored quizzes + per-student attempt history.
//
// Replaces the original hardcoded QUIZZES list in routes/quizzes.ts. The
// route falls back to the legacy hardcoded set when the table is empty so
// existing demos and watch builds keep working out of the box.
// ---------------------------------------------------------------------------

export const quizzesTable = pgTable(
  "quizzes",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    subject: text("subject").notNull(),
    // Optional class scoping: if null, the quiz is globally visible. If set,
    // /v1/watch/quizzes filters to quizzes whose class matches one of the
    // student's enrolled classes.
    class_id: integer("class_id").references(() => classesTable.id, {
      onDelete: "set null",
    }),
    teacher_id: integer("teacher_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    duration_minutes: integer("duration_minutes").notNull().default(15),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    teacher_idx: index("quizzes_teacher_idx").on(t.teacher_id),
    class_idx: index("quizzes_class_idx").on(t.class_id),
  }),
);
export type Quiz = typeof quizzesTable.$inferSelect;

/**
 * One row per question. `options` is a 2..6-element jsonb array of strings.
 * `correct_letter` is "A"|"B"|... matching the option order.
 */
export const quizQuestionsTable = pgTable(
  "quiz_questions",
  {
    id: serial("id").primaryKey(),
    quiz_id: integer("quiz_id")
      .notNull()
      .references(() => quizzesTable.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    options: jsonb("options").$type<string[]>().notNull(),
    correct_letter: text("correct_letter").notNull(),
    points: integer("points").notNull().default(10),
    order_idx: integer("order_idx").notNull().default(0),
  },
  (t) => ({ quiz_idx: index("quiz_questions_quiz_idx").on(t.quiz_id) }),
);
export type QuizQuestion = typeof quizQuestionsTable.$inferSelect;

/**
 * Persistent record of one student's attempt at one quiz. Powers the watch
 * leaderboard and the teacher's "who attempted what" view. Only the most
 * recent attempt counts toward leaderboard ranking (we MAX(score) per
 * student in the SELECT — a re-take that scored worse doesn't penalize them).
 */
export const quizAttemptsTable = pgTable(
  "quiz_attempts",
  {
    id: serial("id").primaryKey(),
    quiz_id: integer("quiz_id")
      .notNull()
      .references(() => quizzesTable.id, { onDelete: "cascade" }),
    student_code: text("student_code").notNull(),
    student_name: text("student_name").notNull(),
    score: integer("score").notNull(), // 0..100 percent
    points_earned: integer("points_earned").notNull(),
    correct_answers: integer("correct_answers").notNull(),
    total_questions: integer("total_questions").notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    quiz_idx: index("quiz_attempts_quiz_idx").on(t.quiz_id),
    student_idx: index("quiz_attempts_student_idx").on(t.student_code),
  }),
);
export type QuizAttempt = typeof quizAttemptsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Web Push (VAPID) subscriptions for the parent PWA.
//
// One row per (parent_phone, endpoint). We dedupe on `endpoint` because
// re-installing the PWA generates a new subscription URL but the underlying
// push service may already have an old one — letting both live in parallel
// would double-send the daily digest.
// ---------------------------------------------------------------------------
export const pushSubscriptionsTable = pgTable(
  "push_subscriptions",
  {
    id: serial("id").primaryKey(),
    parent_phone: text("parent_phone").notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
    last_sent_at: timestamp("last_sent_at"),
  },
  (t) => ({
    endpoint_idx: uniqueIndex("push_subs_endpoint_idx").on(t.endpoint),
    phone_idx: index("push_subs_phone_idx").on(t.parent_phone),
  }),
);
export type PushSubscription = typeof pushSubscriptionsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Class timetable. Admins/teachers populate one row per period in a class's
// weekly schedule. The watch app polls /v1/watch/timetable/current to learn
// which subject is happening *right now* and vibrates when it changes.
//
// Time-of-day is stored as `start_minute` / `end_minute` (minutes from
// midnight, 0..1439) — keeps comparisons trivial in SQL/JS without dragging
// timezone conversion into Postgres.
//
// `day_of_week`: ISO numbering 1=Mon .. 7=Sun (matches PostgreSQL EXTRACT(ISODOW)).
// ---------------------------------------------------------------------------
export const timetablePeriodsTable = pgTable(
  "timetable_periods",
  {
    id: serial("id").primaryKey(),
    class_id: integer("class_id")
      .notNull()
      .references(() => classesTable.id, { onDelete: "cascade" }),
    day_of_week: integer("day_of_week").notNull(),
    start_minute: integer("start_minute").notNull(),
    end_minute: integer("end_minute").notNull(),
    subject: text("subject").notNull(),
    room: text("room"),
    teacher_name: text("teacher_name"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    class_day_idx: index("timetable_class_day_idx").on(t.class_id, t.day_of_week),
  }),
);
export type TimetablePeriod = typeof timetablePeriodsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Exam sessions. A teacher acting as supervisor creates an exam against a
// class. While it is `active`, every student watch in that class polls
// /v1/watch/exam/active and switches to a fullscreen countdown until
// `ends_at`. The supervisor can pause (status=paused, remaining_seconds
// captured), resume (recomputes ends_at), add time (pushes ends_at forward
// or grows remaining_seconds when paused), and finish.
//
// Only one non-finished exam per class is allowed (enforced by partial unique
// index on class_id where status != 'finished').
// ---------------------------------------------------------------------------
export const examSessionsTable = pgTable(
  "exam_sessions",
  {
    id: serial("id").primaryKey(),
    class_id: integer("class_id")
      .notNull()
      .references(() => classesTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    // 'scheduled' | 'active' | 'paused' | 'finished'
    status: text("status").notNull().default("scheduled"),
    supervisor_user_id: integer("supervisor_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    initial_seconds: integer("initial_seconds").notNull(),
    seconds_added: integer("seconds_added").notNull().default(0),
    // Wall-clock deadline while running. Null when scheduled or paused.
    ends_at: timestamp("ends_at"),
    // Captured remaining seconds while paused / scheduled.
    remaining_seconds: integer("remaining_seconds"),
    started_at: timestamp("started_at"),
    finished_at: timestamp("finished_at"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    class_active_idx: uniqueIndex("exam_class_one_open_idx")
      .on(t.class_id)
      .where(sql`status <> 'finished'`),
    class_idx: index("exam_class_idx").on(t.class_id),
  }),
);
export type ExamSession = typeof examSessionsTable.$inferSelect;

// ===========================================================================
// Question market — "education exchange" feature.
//
// Currency is **KP** (KobeAI Points). KP is the in-app reward unit; never
// call it "EduCoin" or "EC" anywhere.
//
// Tables:
//   market_questions  — pool of solvable questions, each with a KP reward.
//   question_locks    — a student "rents" exclusive answering time on a
//                       question (others can see but not answer until it
//                       expires or the locker submits a wrong answer).
//   kp_ledger         — append-only signed-delta history of every KP move.
//   student_kp        — denormalized fast-read balance keyed by user id.
//
// All KP-mutating operations MUST run inside a Drizzle transaction that
// updates both `student_kp.balance` and inserts a `kp_ledger` row, so the
// ledger sum always equals the cached balance.
// ===========================================================================
export const marketQuestionsTable = pgTable(
  "market_questions",
  {
    id: serial("id").primaryKey(),
    subject: text("subject").notNull(), // 'math' | 'physics' | 'coding' | 'geography' | 'history' | ...
    prompt: text("prompt").notNull(),
    choices: jsonb("choices").notNull(), // string[] of 2..6 options
    correct_index: integer("correct_index").notNull(),
    kp_reward: integer("kp_reward").notNull(), // KP awarded to the winning student
    // 'open' (anyone can answer or lock) | 'locked' (only locker can answer)
    // | 'won' (someone correctly answered) | 'expired' (no winner before expires_at)
    status: text("status").notNull().default("open"),
    won_by_user_id: integer("won_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    won_at: timestamp("won_at"),
    released_at: timestamp("released_at").defaultNow().notNull(),
    expires_at: timestamp("expires_at"), // null = no global deadline
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    status_idx: index("market_q_status_idx").on(t.status),
    subject_idx: index("market_q_subject_idx").on(t.subject),
  }),
);
export type MarketQuestion = typeof marketQuestionsTable.$inferSelect;

export const questionLocksTable = pgTable(
  "question_locks",
  {
    id: serial("id").primaryKey(),
    question_id: integer("question_id")
      .notNull()
      .references(() => marketQuestionsTable.id, { onDelete: "cascade" }),
    student_id: integer("student_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    kp_cost: integer("kp_cost").notNull(),
    expires_at: timestamp("expires_at").notNull(),
    // Set when the lock is no longer in force: lock expired, locker submitted
    // a wrong answer, or someone (locker or other) won. While null AND
    // expires_at > now, this lock is "active".
    released_at: timestamp("released_at"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    // At most one active (released_at IS NULL) lock per question.
    one_active_per_q: uniqueIndex("question_lock_one_active_idx")
      .on(t.question_id)
      .where(sql`released_at IS NULL`),
    student_idx: index("question_lock_student_idx").on(t.student_id),
  }),
);
export type QuestionLock = typeof questionLocksTable.$inferSelect;

export const kpLedgerTable = pgTable(
  "kp_ledger",
  {
    id: serial("id").primaryKey(),
    user_id: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Signed: positive for awards/grants/refunds, negative for spends.
    delta: integer("delta").notNull(),
    // 'membership_grant' | 'question_won' | 'lock_purchase' | 'lock_refund' | 'admin_adjust'
    reason: text("reason").notNull(),
    question_id: integer("question_id").references(() => marketQuestionsTable.id, { onDelete: "set null" }),
    balance_after: integer("balance_after").notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    user_idx: index("kp_ledger_user_idx").on(t.user_id, t.created_at),
  }),
);
export type KpLedgerEntry = typeof kpLedgerTable.$inferSelect;

export const studentKpTable = pgTable("student_kp", {
  user_id: integer("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  balance: integer("balance").notNull().default(0),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
export type StudentKp = typeof studentKpTable.$inferSelect;

// ---------------------------------------------------------------------------
// Pending KP grants — the membership grant runs in the payment-success
// transaction inside the central control plane, where the *subscription*
// row exists but the per-school student `users` row may not have been
// provisioned yet. We can't look up a `user_id` and we can't fail the
// payment over it, so we park the grant here keyed by `student_code` and
// drain it the next time that student touches a KP-aware endpoint
// (currently `GET /v1/watch/market/me`).
//
// Each row is at-most-once: when claimed, `claimed_at` and the resulting
// `kp_ledger.id` are set in the same transaction that credits the
// student. Concurrent drain attempts use `WHERE claimed_at IS NULL` as
// the CAS guard.
// ---------------------------------------------------------------------------
export const kpPendingGrantsTable = pgTable(
  "kp_pending_grants",
  {
    id: serial("id").primaryKey(),
    student_code: text("student_code").notNull(),
    delta: integer("delta").notNull(),
    reason: text("reason").notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
    claimed_at: timestamp("claimed_at"),
    claimed_ledger_id: integer("claimed_ledger_id").references(() => kpLedgerTable.id, {
      onDelete: "set null",
    }),
  },
  (t) => ({
    student_unclaimed_idx: index("kp_pending_student_idx")
      .on(t.student_code)
      .where(sql`claimed_at IS NULL`),
  }),
);
export type KpPendingGrant = typeof kpPendingGrantsTable.$inferSelect;

// ===========================================================================
// Parent ↔ Student linking + watch QR pairing
// ===========================================================================
//
// A parent has its own user row (role="parent") and is linked to one or more
// students via `parent_children`. Linking happens through one of:
//
//   1. CLAIM CODE: school issues a globally-unique code shaped like
//      `<school-prefix>-XXXX-XXXX` (e.g. "MARI-7K3P-9XQ2"). Parent types or
//      pastes the code, server hashes + looks up the row in `claim_codes`,
//      consumes it, and inserts into `parent_children`. The school prefix
//      means a parent with kids in 5 different schools never has collisions
//      and the code is self-describing.
//
//   2. WATCH QR: the kid opens "Link Parent" on their watch, which calls
//      POST /v1/watch/pairing/start. Server stores a fresh row in
//      `parent_pairing_tokens` (random short token, 2-min TTL, single-use,
//      bound to that student). Watch displays the token as a QR. Parent
//      scans → POST /v1/parent/pairing/scan { token } consumes the row and
//      links. Static QR on watch face would let bus passengers steal a
//      child link; on-demand + short TTL kills that attack.
//
// Both paths converge on the same `parent_children` join table.
// ---------------------------------------------------------------------------

export const parentChildrenTable = pgTable(
  "parent_children",
  {
    parent_user_id: integer("parent_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    student_user_id: integer("student_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tenant_id: integer("tenant_id").references(() => tenantsTable.id, {
      onDelete: "set null",
    }),
    nickname: text("nickname"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.parent_user_id, t.student_user_id] }),
    parent_idx: index("parent_children_parent_idx").on(t.parent_user_id),
  }),
);
export type ParentChild = typeof parentChildrenTable.$inferSelect;

// Globally unique claim codes. We store ONLY a SHA-256 hash of the code
// (`code_hash`) so a DB dump can't be turned into a list of usable codes;
// `code_prefix` (the school slug part, e.g. "MARI") is kept in plaintext for
// display in the school-side "active codes" admin view. `consumed_by` flips
// from null → parent_user_id when claimed; we keep the row as an audit trail
// instead of deleting it. Per-school regeneration just inserts a new row and
// expires the old one (sets `expires_at` in the past).
export const claimCodesTable = pgTable(
  "claim_codes",
  {
    id: serial("id").primaryKey(),
    code_hash: text("code_hash").notNull(),
    code_prefix: text("code_prefix").notNull(),
    tenant_id: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    student_user_id: integer("student_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    issued_by: integer("issued_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    consumed_by: integer("consumed_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    consumed_at: timestamp("consumed_at"),
    expires_at: timestamp("expires_at"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    code_hash_idx: uniqueIndex("claim_codes_hash_idx").on(t.code_hash),
    student_idx: index("claim_codes_student_idx").on(t.student_user_id),
  }),
);
export type ClaimCode = typeof claimCodesTable.$inferSelect;

// Watch → parent pairing tokens. Random ~12-char base32 string. Hash stored.
// 2-minute TTL by default; consumed_at flips on first successful scan.
export const parentPairingTokensTable = pgTable(
  "parent_pairing_tokens",
  {
    id: serial("id").primaryKey(),
    token_hash: text("token_hash").notNull(),
    student_user_id: integer("student_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tenant_id: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    expires_at: timestamp("expires_at").notNull(),
    consumed_by: integer("consumed_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    consumed_at: timestamp("consumed_at"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    hash_idx: uniqueIndex("pairing_tokens_hash_idx").on(t.token_hash),
  }),
);
export type ParentPairingToken = typeof parentPairingTokensTable.$inferSelect;

// ===========================================================================
// Stationery ordering
// ===========================================================================
//
// Super-admin owns the master catalog (`stationery_items`); each tenant can
// override `default_price_tsh` via `stationery_school_prices`. Procurement
// happens inside a `stationery_drives` window — only one open drive at a
// time per tenant (enforced by partial unique index). Inside the window,
// each student gets at most one `stationery_orders` row per drive (enforced
// by unique). The order has lines in `stationery_order_items`.
//
// Status machine for stationery_orders:
//   draft -> pending_parent_approval -> approved -> packed
//                                    \-> rejected
//
//   - draft: started by teacher in class, not yet sent to parent
//   - pending_parent_approval: parent gets push, can edit & approve
//   - approved: parent confirmed, total locked, included in compilation
//   - rejected: parent declined; archived but not in compilation
//   - packed: super-admin marked it as packed/shipped
//
// Compilation = SUM(qty) per item across all approved orders, grouped by
// tenant for per-school packing breakdown.
// ---------------------------------------------------------------------------

export const stationeryItemsTable = pgTable(
  "stationery_items",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    category: text("category").notNull().default("Other"),
    default_price_tsh: integer("default_price_tsh").notNull().default(0),
    unit: text("unit").notNull().default("each"), // "each" | "pack" | "ream"
    active: boolean("active").notNull().default(true),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    name_idx: uniqueIndex("stationery_items_name_idx").on(t.name),
  }),
);
export type StationeryItem = typeof stationeryItemsTable.$inferSelect;

export const stationerySchoolPricesTable = pgTable(
  "stationery_school_prices",
  {
    tenant_id: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    item_id: integer("item_id")
      .notNull()
      .references(() => stationeryItemsTable.id, { onDelete: "cascade" }),
    price_tsh: integer("price_tsh").notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.tenant_id, t.item_id] }) }),
);

export const stationeryDrivesTable = pgTable(
  "stationery_drives",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    opens_at: timestamp("opens_at").defaultNow().notNull(),
    closes_at: timestamp("closes_at").notNull(),
    // open | closed | invoiced
    status: text("status").notNull().default("open"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    open_idx: uniqueIndex("stationery_drives_open_idx")
      .on(t.status)
      .where(sql`status = 'open'`),
  }),
);
export type StationeryDrive = typeof stationeryDrivesTable.$inferSelect;

export const stationeryOrdersTable = pgTable(
  "stationery_orders",
  {
    id: serial("id").primaryKey(),
    drive_id: integer("drive_id")
      .notNull()
      .references(() => stationeryDrivesTable.id, { onDelete: "cascade" }),
    tenant_id: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    student_user_id: integer("student_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    student_code: text("student_code").notNull(),
    student_name: text("student_name").notNull(),
    class_id: integer("class_id").references(() => classesTable.id, {
      onDelete: "set null",
    }),
    class_name: text("class_name"),
    parent_user_id: integer("parent_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    // Who drafted it: "teacher" | "student_watch" | "parent"
    placed_by: text("placed_by").notNull().default("parent"),
    // draft | pending_parent_approval | approved | rejected | packed
    status: text("status").notNull().default("draft"),
    total_tsh: integer("total_tsh").notNull().default(0),
    notes: text("notes"),
    submitted_at: timestamp("submitted_at"),
    approved_at: timestamp("approved_at"),
    packed_at: timestamp("packed_at"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    drive_student_idx: uniqueIndex("stationery_orders_drive_student_idx").on(
      t.drive_id,
      t.student_user_id,
    ),
    tenant_idx: index("stationery_orders_tenant_idx").on(t.tenant_id, t.drive_id),
    status_idx: index("stationery_orders_status_idx").on(t.status, t.drive_id),
  }),
);
export type StationeryOrder = typeof stationeryOrdersTable.$inferSelect;

export const stationeryOrderItemsTable = pgTable(
  "stationery_order_items",
  {
    id: serial("id").primaryKey(),
    order_id: integer("order_id")
      .notNull()
      .references(() => stationeryOrdersTable.id, { onDelete: "cascade" }),
    item_id: integer("item_id")
      .notNull()
      .references(() => stationeryItemsTable.id, { onDelete: "restrict" }),
    item_name: text("item_name").notNull(), // snapshot for audit
    qty: integer("qty").notNull(),
    unit_price_tsh: integer("unit_price_tsh").notNull(),
    line_total_tsh: integer("line_total_tsh").notNull(),
  },
  (t) => ({
    order_item_idx: uniqueIndex("stationery_order_items_unique_idx").on(
      t.order_id,
      t.item_id,
    ),
  }),
);
export type StationeryOrderItem = typeof stationeryOrderItemsTable.$inferSelect;

// ===========================================================================
// MINI-APP STORE — developer accounts, mini-apps, installs, purchases.
// Apps are tiny JSON-defined experiences (flashcards, quizzes, readings,
// counters, timers) rendered by a built-in runtime on the watch. Devs pay
// for an account and get revenue share when students pay for their apps.
// ===========================================================================

export const developersTable = pgTable(
  "developers",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    display_name: text("display_name").notNull(),
    password_hash: text("password_hash").notNull(),
    bio: text("bio"),
    website: text("website"),
    // "none" | "indie" | "studio"
    plan: text("plan").notNull().default("none"),
    // "inactive" | "pending_payment" | "active" | "expired"
    plan_status: text("plan_status").notNull().default("inactive"),
    plan_expires_at: timestamp("plan_expires_at"),
    payout_method: text("payout_method"), // "mpesa" | "bank"
    payout_account: text("payout_account"),
    // Lifetime stats (denormalized for speed)
    total_published_apps: integer("total_published_apps").notNull().default(0),
    total_installs: integer("total_installs").notNull().default(0),
    total_earnings_tsh: integer("total_earnings_tsh").notNull().default(0),
    total_earnings_kp: integer("total_earnings_kp").notNull().default(0),
    unpaid_balance_tsh: integer("unpaid_balance_tsh").notNull().default(0),
    unpaid_balance_kp: integer("unpaid_balance_kp").notNull().default(0),
    banned: boolean("banned").notNull().default(false),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    email_idx: uniqueIndex("developers_email_idx").on(t.email),
  }),
);
export type Developer = typeof developersTable.$inferSelect;

/** Subscription + payout history for developers. */
export const developerPaymentsTable = pgTable("developer_payments", {
  id: serial("id").primaryKey(),
  developer_id: integer("developer_id")
    .notNull()
    .references(() => developersTable.id, { onDelete: "cascade" }),
  // "subscription" (dev pays us) | "payout" (we pay dev)
  kind: text("kind").notNull(),
  plan: text("plan"), // for subscriptions: "indie" | "studio"
  amount_tsh: integer("amount_tsh").notNull(),
  reference: text("reference"), // M-Pesa reference or transaction id
  // "pending" | "verified" | "rejected"
  status: text("status").notNull().default("pending"),
  notes: text("notes"),
  verified_by: integer("verified_by").references(() => usersTable.id),
  verified_at: timestamp("verified_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

export const miniAppsTable = pgTable(
  "mini_apps",
  {
    id: serial("id").primaryKey(),
    developer_id: integer("developer_id")
      .notNull()
      .references(() => developersTable.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon"), // single emoji or short string
    // "languages" | "math" | "science" | "history" | "wellness" | "fun" | "podcasts" | "other"
    category: text("category").notNull().default("other"),
    // "flashcards" | "quiz" | "reading" | "counter" | "timer"
    type: text("type").notNull(),
    // 0 = free
    price_kp: integer("price_kp").notNull().default(0),
    price_tsh: integer("price_tsh").notNull().default(0),
    // "draft" | "submitted" | "approved" | "rejected" | "removed"
    status: text("status").notNull().default("draft"),
    current_version_id: integer("current_version_id"),
    total_installs: integer("total_installs").notNull().default(0),
    total_completions: integer("total_completions").notNull().default(0),
    rating_sum: integer("rating_sum").notNull().default(0),
    rating_count: integer("rating_count").notNull().default(0),
    rejection_reason: text("rejection_reason"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    dev_slug_idx: uniqueIndex("mini_apps_dev_slug_idx").on(t.developer_id, t.slug),
    cat_status_idx: index("mini_apps_cat_status_idx").on(t.category, t.status),
  }),
);
export type MiniApp = typeof miniAppsTable.$inferSelect;

export const miniAppVersionsTable = pgTable(
  "mini_app_versions",
  {
    id: serial("id").primaryKey(),
    app_id: integer("app_id")
      .notNull()
      .references(() => miniAppsTable.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    manifest: jsonb("manifest").notNull(),
    // "submitted" | "approved" | "rejected"
    status: text("status").notNull().default("submitted"),
    reviewed_by: integer("reviewed_by").references(() => usersTable.id),
    reviewed_at: timestamp("reviewed_at"),
    review_notes: text("review_notes"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    app_version_idx: uniqueIndex("mini_app_versions_unique_idx").on(t.app_id, t.version),
  }),
);
export type MiniAppVersion = typeof miniAppVersionsTable.$inferSelect;

export const miniAppInstallsTable = pgTable(
  "mini_app_installs",
  {
    id: serial("id").primaryKey(),
    student_user_id: integer("student_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    app_id: integer("app_id")
      .notNull()
      .references(() => miniAppsTable.id, { onDelete: "cascade" }),
    version_id: integer("version_id")
      .notNull()
      .references(() => miniAppVersionsTable.id),
    paid: boolean("paid").notNull().default(false),
    installed_at: timestamp("installed_at").defaultNow().notNull(),
    uninstalled_at: timestamp("uninstalled_at"),
  },
  (t) => ({
    unique_idx: uniqueIndex("mini_app_installs_unique_idx").on(
      t.student_user_id,
      t.app_id,
    ),
  }),
);
export type MiniAppInstall = typeof miniAppInstallsTable.$inferSelect;

export const miniAppPurchasesTable = pgTable("mini_app_purchases", {
  id: serial("id").primaryKey(),
  student_user_id: integer("student_user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  app_id: integer("app_id")
    .notNull()
    .references(() => miniAppsTable.id, { onDelete: "cascade" }),
  developer_id: integer("developer_id")
    .notNull()
    .references(() => developersTable.id),
  price_kp: integer("price_kp").notNull().default(0),
  price_tsh: integer("price_tsh").notNull().default(0),
  dev_share_kp: integer("dev_share_kp").notNull().default(0),
  dev_share_tsh: integer("dev_share_tsh").notNull().default(0),
  platform_share_kp: integer("platform_share_kp").notNull().default(0),
  platform_share_tsh: integer("platform_share_tsh").notNull().default(0),
  paid_at: timestamp("paid_at").defaultNow().notNull(),
});
export type MiniAppPurchase = typeof miniAppPurchasesTable.$inferSelect;

export const miniAppReviewsTable = pgTable(
  "mini_app_reviews",
  {
    id: serial("id").primaryKey(),
    app_id: integer("app_id")
      .notNull()
      .references(() => miniAppsTable.id, { onDelete: "cascade" }),
    student_user_id: integer("student_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(), // 1-5
    comment: text("comment"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    one_per_student_idx: uniqueIndex("mini_app_reviews_unique_idx").on(
      t.app_id,
      t.student_user_id,
    ),
  }),
);
export type MiniAppReview = typeof miniAppReviewsTable.$inferSelect;

// =====================================================================
// Ad Exchange — self-serve advertiser portal + cross-surface ad serving
// (parent PWA banners, watch home tile, watch mini-app interstitials).
// =====================================================================

/**
 * One row per advertiser company. The `balance_tsh` is decremented on every
 * billed event (impression for CPM, click for CPC, period start for flat).
 * `status` lets super-admin freeze a misbehaving advertiser without deleting
 * their history.
 */
export const advertisersTable = pgTable(
  "advertisers",
  {
    id: serial("id").primaryKey(),
    company_name: text("company_name").notNull(),
    contact_email: text("contact_email").notNull(),
    password_hash: text("password_hash").notNull(),
    balance_tsh: integer("balance_tsh").default(0).notNull(),
    status: text("status").default("active").notNull(), // active|suspended
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    email_unique: uniqueIndex("advertisers_email_idx").on(t.contact_email),
  }),
);
export type Advertiser = typeof advertisersTable.$inferSelect;

/**
 * One row per campaign. `pricing_model` decides what `bid_amount_tsh` means:
 *   cpm  — TSh per 1000 impressions (auction floor)
 *   cpc  — TSh per click (auction floor)
 *   flat — TSh per `flat_period_days`, guaranteed placement during window
 *
 * `targeting` is free-form jsonb so we can evolve targeting (region, grade,
 * device, language) without schema churn.
 */
export const adCampaignsTable = pgTable(
  "ad_campaigns",
  {
    id: serial("id").primaryKey(),
    advertiser_id: integer("advertiser_id")
      .notNull()
      .references(() => advertisersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    pricing_model: text("pricing_model").notNull(), // cpm | cpc | flat
    bid_amount_tsh: integer("bid_amount_tsh").notNull(),
    daily_budget_tsh: integer("daily_budget_tsh").default(0).notNull(),
    total_budget_tsh: integer("total_budget_tsh").default(0).notNull(),
    spent_total_tsh: integer("spent_total_tsh").default(0).notNull(),
    spent_today_tsh: integer("spent_today_tsh").default(0).notNull(),
    spent_today_date: text("spent_today_date"), // ISO date for daily reset
    flat_period_days: integer("flat_period_days").default(7),
    placements: jsonb("placements").notNull(), // string[]
    targeting: jsonb("targeting"), // { age_min, age_max, region, grade, ... }
    starts_at: timestamp("starts_at").defaultNow().notNull(),
    ends_at: timestamp("ends_at"),
    status: text("status").default("draft").notNull(),
    // draft|active|paused|exhausted|ended|rejected
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    by_status_idx: index("ad_campaigns_status_idx").on(t.status),
    by_advertiser_idx: index("ad_campaigns_advertiser_idx").on(t.advertiser_id),
  }),
);
export type AdCampaign = typeof adCampaignsTable.$inferSelect;

/**
 * Creatives (the actual rendered units). One campaign can have multiple,
 * one per format (banner image, native title+body, watch tile, etc.).
 * `format` matches placement.allowed_formats so the engine picks the right
 * creative per slot.
 */
export const adCreativesTable = pgTable(
  "ad_creatives",
  {
    id: serial("id").primaryKey(),
    campaign_id: integer("campaign_id")
      .notNull()
      .references(() => adCampaignsTable.id, { onDelete: "cascade" }),
    format: text("format").notNull(),
    // banner|native|watch_tile|interstitial
    title: text("title").notNull(),
    body: text("body"),
    image_url: text("image_url"),
    cta_url: text("cta_url").notNull(),
    cta_label: text("cta_label").default("Learn more").notNull(),
    width: integer("width"),
    height: integer("height"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    by_campaign_idx: index("ad_creatives_campaign_idx").on(t.campaign_id),
  }),
);
export type AdCreative = typeof adCreativesTable.$inferSelect;

/**
 * Static catalog of ad slots the engine knows how to fill. Seeded at boot.
 * `floor_bid_tsh` is the minimum eCPM a campaign must beat to win the slot.
 */
export const adPlacementsTable = pgTable("ad_placements", {
  id: text("id").primaryKey(), // e.g. parent_app_home
  surface: text("surface").notNull(), // parent_app | watch | watch_miniapp
  description: text("description").notNull(),
  allowed_formats: jsonb("allowed_formats").notNull(), // string[]
  floor_bid_tsh: integer("floor_bid_tsh").default(0).notNull(),
  active: boolean("active").default(true).notNull(),
});
export type AdPlacement = typeof adPlacementsTable.$inferSelect;

/**
 * Every served ad creates an impression row. `charged_tsh` is non-zero only
 * for CPM and flat campaigns (clicks for CPC charge on the click event).
 * `user_id` is nullable since some surfaces (e.g. watch home) may serve
 * pre-login.
 */
export const adImpressionsTable = pgTable(
  "ad_impressions",
  {
    id: serial("id").primaryKey(),
    campaign_id: integer("campaign_id")
      .notNull()
      .references(() => adCampaignsTable.id, { onDelete: "cascade" }),
    creative_id: integer("creative_id")
      .notNull()
      .references(() => adCreativesTable.id, { onDelete: "cascade" }),
    placement_id: text("placement_id").notNull(),
    user_id: integer("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    served_at: timestamp("served_at").defaultNow().notNull(),
    confirmed: boolean("confirmed").default(false).notNull(),
    charged_tsh: integer("charged_tsh").default(0).notNull(),
  },
  (t) => ({
    by_campaign_idx: index("ad_impressions_campaign_idx").on(t.campaign_id),
    by_served_idx: index("ad_impressions_served_idx").on(t.served_at),
  }),
);
export type AdImpression = typeof adImpressionsTable.$inferSelect;

export const adClicksTable = pgTable(
  "ad_clicks",
  {
    id: serial("id").primaryKey(),
    impression_id: integer("impression_id")
      .notNull()
      .references(() => adImpressionsTable.id, { onDelete: "cascade" }),
    campaign_id: integer("campaign_id")
      .notNull()
      .references(() => adCampaignsTable.id, { onDelete: "cascade" }),
    clicked_at: timestamp("clicked_at").defaultNow().notNull(),
    charged_tsh: integer("charged_tsh").default(0).notNull(),
  },
  (t) => ({
    by_campaign_idx: index("ad_clicks_campaign_idx").on(t.campaign_id),
  }),
);
export type AdClick = typeof adClicksTable.$inferSelect;

/**
 * Append-only ledger for advertiser money movements. `delta_tsh` positive =
 * topup, negative = ad spend or refund.
 */
export const adLedgerTable = pgTable(
  "ad_ledger",
  {
    id: serial("id").primaryKey(),
    advertiser_id: integer("advertiser_id")
      .notNull()
      .references(() => advertisersTable.id, { onDelete: "cascade" }),
    delta_tsh: integer("delta_tsh").notNull(),
    balance_after: integer("balance_after").notNull(),
    reason: text("reason").notNull(),
    // topup|cpm_impression|cpc_click|flat_period|admin_adjust|refund
    ref_id: integer("ref_id"), // impression_id / click_id / payment id
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    by_advertiser_idx: index("ad_ledger_advertiser_idx").on(t.advertiser_id),
  }),
);
export type AdLedger = typeof adLedgerTable.$inferSelect;

/**
 * Per-user-per-campaign frequency cap counter. Resets daily via the
 * `bucket_date` partition key. Cheap upsert + read on serve.
 */
export const adFrequencyCapsTable = pgTable(
  "ad_frequency_caps",
  {
    user_id: integer("user_id").notNull(),
    campaign_id: integer("campaign_id")
      .notNull()
      .references(() => adCampaignsTable.id, { onDelete: "cascade" }),
    bucket_date: text("bucket_date").notNull(), // ISO date YYYY-MM-DD
    count: integer("count").default(0).notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.user_id, t.campaign_id, t.bucket_date],
    }),
  }),
);
export type AdFrequencyCap = typeof adFrequencyCapsTable.$inferSelect;
