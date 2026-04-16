import { pgTable, text, serial, timestamp, integer, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";

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
