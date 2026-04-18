import { Router } from "express";
import { and, desc, eq, ne } from "drizzle-orm";
import {
  db,
  classesTable,
  classMembershipsTable,
  examSessionsTable,
  usersTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import type { Request } from "express";

/** Caller (teacher) owns the class, or is admin. */
async function teacherOwnsClass(req: Request, classId: number): Promise<boolean> {
  if (req.auth?.role === "admin") return true;
  const cls = (await db.select().from(classesTable).where(eq(classesTable.id, classId)))[0];
  return !!cls && cls.teacher_id === req.auth?.user_id;
}

/**
 * Exam supervisor router.
 *
 * Lifecycle: scheduled --start--> active <--pause/resume--> paused
 *            (active|paused) --add-time--> shifts ends_at / remaining_seconds
 *            (any) --finish--> finished
 *
 * One open exam per class is enforced by a partial unique index.
 *
 * Server-of-truth model:
 *   - When `active`,  `ends_at` is the wall-clock deadline. Watch shows
 *     (ends_at - now) as the countdown. Adding seconds moves ends_at forward.
 *   - When `paused`,  `remaining_seconds` is the captured remainder. Adding
 *     seconds while paused increases remaining_seconds. Resuming sets
 *     ends_at = now + remaining_seconds.
 *   - When time hits zero we don't auto-finish — the supervisor decides when
 *     to end (so a 5-minute grace is possible).
 */
const router = Router();

const teacherAuth = requireAuth(["teacher", "admin"]);
const studentAuth = requireAuth(["student"]);

function computeRemainingSeconds(
  exam: typeof examSessionsTable.$inferSelect,
): number {
  if (exam.status === "active" && exam.ends_at) {
    return Math.max(0, Math.floor((exam.ends_at.getTime() - Date.now()) / 1000));
  }
  if ((exam.status === "paused" || exam.status === "scheduled") && exam.remaining_seconds != null) {
    return Math.max(0, exam.remaining_seconds);
  }
  return 0;
}

function shape(exam: typeof examSessionsTable.$inferSelect) {
  return {
    id: exam.id,
    class_id: exam.class_id,
    title: exam.title,
    status: exam.status,
    initial_seconds: exam.initial_seconds,
    seconds_added: exam.seconds_added,
    remaining_seconds: computeRemainingSeconds(exam),
    ends_at: exam.ends_at?.toISOString() ?? null,
    started_at: exam.started_at?.toISOString() ?? null,
    finished_at: exam.finished_at?.toISOString() ?? null,
    supervisor_user_id: exam.supervisor_user_id,
  };
}

// -------- Supervisor (teacher/admin) --------

/** Class IDs the caller may control. */
async function authorizedClassIds(req: Request): Promise<number[]> {
  if (req.auth?.role === "admin") {
    const rows = await db.select({ id: classesTable.id }).from(classesTable);
    return rows.map((r) => r.id);
  }
  const rows = await db.select({ id: classesTable.id }).from(classesTable).where(eq(classesTable.teacher_id, req.auth!.user_id));
  return rows.map((r) => r.id);
}

router.get("/v1/teacher/exams", teacherAuth, async (req, res) => {
  const allowed = await authorizedClassIds(req);
  if (allowed.length === 0) {
    res.json({ exams: [] });
    return;
  }
  const classIdParam = req.query.class_id;
  if (classIdParam !== undefined) {
    const classId = Number(classIdParam);
    if (!allowed.includes(classId)) {
      res.status(403).json({ error: "not authorized for this class" });
      return;
    }
    const rows = await db.select().from(examSessionsTable).where(eq(examSessionsTable.class_id, classId)).orderBy(desc(examSessionsTable.created_at));
    res.json({ exams: rows.map(shape) });
    return;
  }
  const all = await db.select().from(examSessionsTable).orderBy(desc(examSessionsTable.created_at));
  res.json({ exams: all.filter((e) => allowed.includes(e.class_id)).map(shape) });
});

router.post("/v1/teacher/exams", teacherAuth, async (req, res) => {
  const { class_id, title, duration_minutes } = req.body ?? {};
  const classId = Number(class_id);
  const minutes = Number(duration_minutes);
  if (!Number.isInteger(classId) || classId <= 0) {
    res.status(400).json({ error: "class_id required" });
    return;
  }
  if (typeof title !== "string" || !title.trim()) {
    res.status(400).json({ error: "title required" });
    return;
  }
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 600) {
    res.status(400).json({ error: "duration_minutes must be 1..600" });
    return;
  }
  if (!(await teacherOwnsClass(req, classId))) {
    res.status(403).json({ error: "not authorized for this class" });
    return;
  }
  // Reject if the class already has a non-finished exam (mirrors the unique
  // index — friendlier 409 instead of a raw constraint error).
  const existing = await db
    .select()
    .from(examSessionsTable)
    .where(and(eq(examSessionsTable.class_id, classId), ne(examSessionsTable.status, "finished")))
    .limit(1);
  if (existing.length > 0) {
    res.status(409).json({ error: "class already has an open exam", exam: shape(existing[0]!) });
    return;
  }
  const seconds = Math.floor(minutes * 60);
  try {
    const [row] = await db
      .insert(examSessionsTable)
      .values({
        class_id: classId,
        title: title.trim(),
        supervisor_user_id: req.auth!.user_id,
        initial_seconds: seconds,
        remaining_seconds: seconds,
        status: "scheduled",
      })
      .returning();
    res.status(201).json({ exam: shape(row!) });
  } catch (e: unknown) {
    // Concurrent create lost the race against the partial unique index.
    const msg = e instanceof Error ? e.message : String(e);
    if (/exam_class_one_open_idx|unique/i.test(msg)) {
      const [conflict] = await db
        .select()
        .from(examSessionsTable)
        .where(and(eq(examSessionsTable.class_id, classId), ne(examSessionsTable.status, "finished")))
        .limit(1);
      res.status(409).json({ error: "class already has an open exam", exam: conflict ? shape(conflict) : null });
      return;
    }
    throw e;
  }
});

/**
 * Loads an exam, enforces caller ownership of its class. Returns null + sends
 * the appropriate 403/404 response when the caller isn't allowed.
 */
async function loadExamForControl(
  id: number,
  req: Request,
  res: import("express").Response,
): Promise<typeof examSessionsTable.$inferSelect | null> {
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "invalid id" });
    return null;
  }
  const [exam] = await db.select().from(examSessionsTable).where(eq(examSessionsTable.id, id)).limit(1);
  if (!exam) {
    res.status(404).json({ error: "exam not found" });
    return null;
  }
  if (!(await teacherOwnsClass(req, exam.class_id))) {
    res.status(403).json({ error: "not authorized for this class" });
    return null;
  }
  return exam;
}

router.post("/v1/teacher/exams/:id/start", teacherAuth, async (req, res) => {
  const id = Number(req.params.id);
  const exam = await loadExamForControl(id, req, res);
  if (!exam) return;
  if (exam.status === "active") {
    res.json({ exam: shape(exam) });
    return;
  }
  if (exam.status === "finished") {
    res.status(409).json({ error: "exam already finished" });
    return;
  }
  const remaining = exam.remaining_seconds ?? exam.initial_seconds;
  const endsAt = new Date(Date.now() + remaining * 1000);
  // Atomic CAS: only flip if status is still scheduled or paused — guards
  // against two supervisors hitting Start at once.
  const [updated] = await db
    .update(examSessionsTable)
    .set({ status: "active", ends_at: endsAt, remaining_seconds: null, started_at: exam.started_at ?? new Date() })
    .where(and(eq(examSessionsTable.id, id), eq(examSessionsTable.status, exam.status)))
    .returning();
  if (!updated) {
    const [fresh] = await db.select().from(examSessionsTable).where(eq(examSessionsTable.id, id)).limit(1);
    res.status(409).json({ error: "exam state changed; refresh", exam: fresh ? shape(fresh) : null });
    return;
  }
  res.json({ exam: shape(updated) });
});

router.post("/v1/teacher/exams/:id/pause", teacherAuth, async (req, res) => {
  const id = Number(req.params.id);
  const exam = await loadExamForControl(id, req, res);
  if (!exam) return;
  if (exam.status !== "active") {
    res.status(409).json({ error: "only active exams can be paused" });
    return;
  }
  const remaining = computeRemainingSeconds(exam);
  const [updated] = await db
    .update(examSessionsTable)
    .set({ status: "paused", remaining_seconds: remaining, ends_at: null })
    .where(and(eq(examSessionsTable.id, id), eq(examSessionsTable.status, "active")))
    .returning();
  if (!updated) {
    res.status(409).json({ error: "exam state changed; refresh" });
    return;
  }
  res.json({ exam: shape(updated) });
});

router.post("/v1/teacher/exams/:id/resume", teacherAuth, async (req, res) => {
  const id = Number(req.params.id);
  const exam = await loadExamForControl(id, req, res);
  if (!exam) return;
  if (exam.status !== "paused") {
    res.status(409).json({ error: "only paused exams can be resumed" });
    return;
  }
  const remaining = exam.remaining_seconds ?? 0;
  const endsAt = new Date(Date.now() + remaining * 1000);
  const [updated] = await db
    .update(examSessionsTable)
    .set({ status: "active", ends_at: endsAt, remaining_seconds: null })
    .where(and(eq(examSessionsTable.id, id), eq(examSessionsTable.status, "paused")))
    .returning();
  if (!updated) {
    res.status(409).json({ error: "exam state changed; refresh" });
    return;
  }
  res.json({ exam: shape(updated) });
});

router.post("/v1/teacher/exams/:id/add-time", teacherAuth, async (req, res) => {
  const id = Number(req.params.id);
  const seconds = Math.floor(Number(req.body?.seconds));
  if (!Number.isFinite(seconds) || seconds === 0 || Math.abs(seconds) > 60 * 60) {
    res.status(400).json({ error: "seconds must be a non-zero integer in [-3600, 3600]" });
    return;
  }
  const exam = await loadExamForControl(id, req, res);
  if (!exam) return;
  if (exam.status === "finished") {
    res.status(409).json({ error: "exam already finished" });
    return;
  }
  const set: Partial<typeof examSessionsTable.$inferInsert> = {
    seconds_added: exam.seconds_added + seconds,
  };
  if (exam.status === "active" && exam.ends_at) {
    set.ends_at = new Date(exam.ends_at.getTime() + seconds * 1000);
  } else {
    const remaining = Math.max(0, (exam.remaining_seconds ?? exam.initial_seconds) + seconds);
    set.remaining_seconds = remaining;
  }
  // CAS on (id, status, seconds_added) so concurrent +time calls are
  // serialized: each one sees the previous total and increments from it.
  const [updated] = await db
    .update(examSessionsTable)
    .set(set)
    .where(and(
      eq(examSessionsTable.id, id),
      eq(examSessionsTable.status, exam.status),
      eq(examSessionsTable.seconds_added, exam.seconds_added),
    ))
    .returning();
  if (!updated) {
    res.status(409).json({ error: "exam state changed; please retry" });
    return;
  }
  res.json({ exam: shape(updated) });
});

router.post("/v1/teacher/exams/:id/finish", teacherAuth, async (req, res) => {
  const id = Number(req.params.id);
  const exam = await loadExamForControl(id, req, res);
  if (!exam) return;
  const [updated] = await db
    .update(examSessionsTable)
    .set({ status: "finished", finished_at: new Date(), ends_at: null, remaining_seconds: 0 })
    .where(and(eq(examSessionsTable.id, id), ne(examSessionsTable.status, "finished")))
    .returning();
  if (!updated) {
    // Already finished — return the current row idempotently.
    res.json({ exam: shape(exam) });
    return;
  }
  res.json({ exam: shape(updated) });
});

// -------- Student watch --------

/**
 * Returns the active or paused exam for the caller's class, if any.
 * Watch app uses this to switch into fullscreen countdown mode.
 */
router.get("/v1/watch/exam/active", studentAuth, async (req, res) => {
  const studentCode = req.auth!.student_id!;
  const [me] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.student_code, studentCode)).limit(1);
  if (!me) {
    res.json({ active: false });
    return;
  }
  const memberships = await db.select({ class_id: classMembershipsTable.class_id }).from(classMembershipsTable).where(eq(classMembershipsTable.student_id, me.id));
  if (memberships.length === 0) {
    res.json({ active: false });
    return;
  }
  // Find the most recent non-finished exam in any of the student's classes.
  for (const m of memberships) {
    const [exam] = await db
      .select()
      .from(examSessionsTable)
      .where(and(eq(examSessionsTable.class_id, m.class_id), ne(examSessionsTable.status, "finished")))
      .orderBy(desc(examSessionsTable.created_at))
      .limit(1);
    if (exam && (exam.status === "active" || exam.status === "paused")) {
      res.json({ active: true, exam: shape(exam) });
      return;
    }
  }
  res.json({ active: false });
});

export default router;
