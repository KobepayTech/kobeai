import { pgTable, text, serial, timestamp, integer, uniqueIndex, primaryKey, boolean } from "drizzle-orm/pg-core";

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
  },
  (t) => ({ pk: primaryKey({ columns: [t.document_id, t.class_id] }) }),
);

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
