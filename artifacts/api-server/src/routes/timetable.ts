import { Router } from "express";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  classesTable,
  classMembershipsTable,
  timetablePeriodsTable,
  usersTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import type { Request } from "express";

/**
 * True if the caller is admin or owns the given class. Mirrors the helper in
 * routes/teacher.ts (kept inline here to avoid cross-file coupling).
 */
async function teacherOwnsClass(req: Request, classId: number): Promise<boolean> {
  if (req.auth?.role === "admin") return true;
  const cls = (await db.select().from(classesTable).where(eq(classesTable.id, classId)))[0];
  return !!cls && cls.teacher_id === req.auth?.user_id;
}

/**
 * Timetable router.
 *
 * - Admins/teachers manage the school-wide schedule via /v1/teacher/timetable
 *   (one row per class period, ISO weekday 1=Mon..7=Sun, time stored as
 *   minutes-from-midnight to keep TZ math out of the database).
 * - Students hit /v1/watch/timetable/today (full day) and
 *   /v1/watch/timetable/current (the period happening right now) — the watch
 *   polls the latter and vibrates when the subject changes.
 */
const router = Router();

const teacherAuth = requireAuth(["teacher", "admin"]);
const studentAuth = requireAuth(["student"]);

// ISO day of week: 1=Mon..7=Sun. JS Date.getDay() is 0=Sun..6=Sat — we
// rotate so Sun maps to 7.
function isoDayOfWeek(d: Date): number {
  const js = d.getDay();
  return js === 0 ? 7 : js;
}
function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function validatePeriodPayload(body: unknown): { ok: true; value: {
  class_id: number; day_of_week: number; start_minute: number; end_minute: number;
  subject: string; room?: string | null; teacher_name?: string | null;
} } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const class_id = Number(b.class_id);
  const day_of_week = Number(b.day_of_week);
  const start_minute = Number(b.start_minute);
  const end_minute = Number(b.end_minute);
  const subject = typeof b.subject === "string" ? b.subject.trim() : "";
  if (!Number.isInteger(class_id) || class_id <= 0) return { ok: false, error: "class_id required" };
  if (!Number.isInteger(day_of_week) || day_of_week < 1 || day_of_week > 7) return { ok: false, error: "day_of_week must be 1..7 (ISO)" };
  if (!Number.isInteger(start_minute) || start_minute < 0 || start_minute > 1439) return { ok: false, error: "start_minute must be 0..1439" };
  if (!Number.isInteger(end_minute) || end_minute <= start_minute || end_minute > 1440) return { ok: false, error: "end_minute must be > start_minute and <= 1440" };
  if (!subject) return { ok: false, error: "subject required" };
  return {
    ok: true,
    value: {
      class_id, day_of_week, start_minute, end_minute, subject,
      room: typeof b.room === "string" && b.room.trim() ? b.room.trim() : null,
      teacher_name: typeof b.teacher_name === "string" && b.teacher_name.trim() ? b.teacher_name.trim() : null,
    },
  };
}

// -------- Teacher / admin CRUD --------

/** Returns the set of class IDs the caller is allowed to manage. */
async function authorizedClassIds(req: Request): Promise<number[]> {
  if (req.auth?.role === "admin") {
    const rows = await db.select({ id: classesTable.id }).from(classesTable);
    return rows.map((r) => r.id);
  }
  const rows = await db.select({ id: classesTable.id }).from(classesTable).where(eq(classesTable.teacher_id, req.auth!.user_id));
  return rows.map((r) => r.id);
}

router.get("/v1/teacher/timetable", teacherAuth, async (req, res) => {
  const allowed = await authorizedClassIds(req);
  if (allowed.length === 0) {
    res.json({ periods: [] });
    return;
  }
  const classIdParam = req.query.class_id;
  let rows;
  if (classIdParam !== undefined) {
    const classId = Number(classIdParam);
    if (!Number.isInteger(classId)) {
      res.status(400).json({ error: "class_id must be a number" });
      return;
    }
    if (!allowed.includes(classId)) {
      res.status(403).json({ error: "not authorized for this class" });
      return;
    }
    rows = await db
      .select()
      .from(timetablePeriodsTable)
      .where(eq(timetablePeriodsTable.class_id, classId))
      .orderBy(asc(timetablePeriodsTable.day_of_week), asc(timetablePeriodsTable.start_minute));
  } else {
    // Filter to allowed classes only — admin gets all because allowed is full list.
    const all = await db
      .select()
      .from(timetablePeriodsTable)
      .orderBy(asc(timetablePeriodsTable.class_id), asc(timetablePeriodsTable.day_of_week), asc(timetablePeriodsTable.start_minute));
    rows = all.filter((p) => allowed.includes(p.class_id));
  }
  res.json({ periods: rows });
});

router.post("/v1/teacher/timetable", teacherAuth, async (req, res) => {
  const parsed = validatePeriodPayload(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (!(await teacherOwnsClass(req, parsed.value.class_id))) {
    res.status(403).json({ error: "not authorized for this class" });
    return;
  }
  const [row] = await db.insert(timetablePeriodsTable).values(parsed.value).returning();
  res.status(201).json({ period: row });
});

router.put("/v1/teacher/timetable/:id", teacherAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const parsed = validatePeriodPayload(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  // Caller must own both the existing class AND the target class id (in case
  // a period is being moved between classes).
  const [existing] = await db.select().from(timetablePeriodsTable).where(eq(timetablePeriodsTable.id, id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "period not found" });
    return;
  }
  if (!(await teacherOwnsClass(req, existing.class_id)) || !(await teacherOwnsClass(req, parsed.value.class_id))) {
    res.status(403).json({ error: "not authorized for this class" });
    return;
  }
  const [row] = await db
    .update(timetablePeriodsTable)
    .set(parsed.value)
    .where(eq(timetablePeriodsTable.id, id))
    .returning();
  res.json({ period: row });
});

router.delete("/v1/teacher/timetable/:id", teacherAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const [existing] = await db.select().from(timetablePeriodsTable).where(eq(timetablePeriodsTable.id, id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "period not found" });
    return;
  }
  if (!(await teacherOwnsClass(req, existing.class_id))) {
    res.status(403).json({ error: "not authorized for this class" });
    return;
  }
  await db.delete(timetablePeriodsTable).where(eq(timetablePeriodsTable.id, id));
  res.json({ deleted: id });
});

// -------- Watch / student-facing --------

/** Resolve the calling student's class IDs. */
async function callerClassIds(studentCode: string): Promise<number[]> {
  const [me] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.student_code, studentCode)).limit(1);
  if (!me) return [];
  const rows = await db.select({ class_id: classMembershipsTable.class_id }).from(classMembershipsTable).where(eq(classMembershipsTable.student_id, me.id));
  return rows.map((r) => r.class_id);
}

router.get("/v1/watch/timetable/today", studentAuth, async (req, res) => {
  const classIds = await callerClassIds(req.auth!.student_id!);
  if (classIds.length === 0) {
    res.json({ day_of_week: isoDayOfWeek(new Date()), periods: [] });
    return;
  }
  const today = isoDayOfWeek(new Date());
  // Drizzle doesn't have a clean inArray + and chain that types nicely here,
  // so fetch per-class then merge — there's typically only 1 class per student.
  const periods: typeof timetablePeriodsTable.$inferSelect[] = [];
  for (const classId of classIds) {
    const rows = await db
      .select()
      .from(timetablePeriodsTable)
      .where(and(eq(timetablePeriodsTable.class_id, classId), eq(timetablePeriodsTable.day_of_week, today)))
      .orderBy(asc(timetablePeriodsTable.start_minute));
    periods.push(...rows);
  }
  periods.sort((a, b) => a.start_minute - b.start_minute);
  res.json({ day_of_week: today, periods });
});

router.get("/v1/watch/timetable/current", studentAuth, async (req, res) => {
  const classIds = await callerClassIds(req.auth!.student_id!);
  if (classIds.length === 0) {
    res.json({ current: null, next: null });
    return;
  }
  const now = new Date();
  const today = isoDayOfWeek(now);
  const minute = minutesOfDay(now);
  // Pull today's periods for this student's classes.
  const todayPeriods: typeof timetablePeriodsTable.$inferSelect[] = [];
  for (const classId of classIds) {
    const rows = await db
      .select()
      .from(timetablePeriodsTable)
      .where(and(eq(timetablePeriodsTable.class_id, classId), eq(timetablePeriodsTable.day_of_week, today)));
    todayPeriods.push(...rows);
  }
  todayPeriods.sort((a, b) => a.start_minute - b.start_minute);
  const current = todayPeriods.find((p) => minute >= p.start_minute && minute < p.end_minute) ?? null;
  const next = todayPeriods.find((p) => p.start_minute > minute) ?? null;
  res.json({
    current: current
      ? {
          id: current.id,
          subject: current.subject,
          room: current.room,
          teacher_name: current.teacher_name,
          start_minute: current.start_minute,
          end_minute: current.end_minute,
          minutes_remaining: Math.max(0, current.end_minute - minute),
        }
      : null,
    next: next
      ? {
          id: next.id,
          subject: next.subject,
          room: next.room,
          start_minute: next.start_minute,
          end_minute: next.end_minute,
          minutes_until: Math.max(0, next.start_minute - minute),
        }
      : null,
    server_minute: minute,
  });
});

export default router;
