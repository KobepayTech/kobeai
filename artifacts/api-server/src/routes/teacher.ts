import { Router } from "express";
import { db, usersTable, classesTable, classMembershipsTable, documentsTable, documentAssignmentsTable } from "@workspace/db";
import { and, eq, inArray, or } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import { ObjectStorageService } from "../lib/objectStorage";

const router = Router();

// All teacher endpoints require a teacher or admin token.
router.use("/v1/teacher", requireAuth(["teacher", "admin"]));

// ---------------------------------------------------------------------------
// Demo dashboard data — kept as fixtures, but now gated behind auth.
// ---------------------------------------------------------------------------

const ACTIVITY = [
  { id: "1", student_name: "Fatuma Ali",   action: "Completed Science Quiz",        points: 25, timestamp: new Date(Date.now() - 3600000 * 1).toISOString() },
  { id: "2", student_name: "Tumaini Shija", action: "Asked AI about photosynthesis", points: 10, timestamp: new Date(Date.now() - 3600000 * 2).toISOString() },
  { id: "3", student_name: "Neema Kibwe",   action: "Daily attendance check-in",     points: 20, timestamp: new Date(Date.now() - 3600000 * 3).toISOString() },
  { id: "4", student_name: "Amina Hassan",  action: "Completed Math Quiz",           points: 30, timestamp: new Date(Date.now() - 3600000 * 4).toISOString() },
  { id: "5", student_name: "Brian Mwenda",  action: "Asked AI about Tanzania history", points: 10, timestamp: new Date(Date.now() - 3600000 * 5).toISOString() },
];

router.get("/v1/teacher/dashboard/stats", (_req, res) => {
  res.json({
    total_students: 1247,
    active_today: 1103,
    total_points: 458920,
    avg_performance: 78.5,
    questions_today: 3421,
    online_watches: 1103,
    recent_activity: ACTIVITY,
  });
});

router.get("/v1/teacher/students", async (req, res) => {
  const { grade, search } = req.query;
  const rows = await db.select().from(usersTable).where(eq(usersTable.role, "student"));
  let students = rows.map((s, i) => ({
    id: String(s.id),
    student_id: s.student_code ?? `S${s.id}`,
    name: s.name,
    grade: s.grade ?? "Form 1",
    points: 1000 + i * 100,
    status: "active",
    last_active: new Date().toISOString(),
  }));
  if (typeof grade === "string") students = students.filter((s) => s.grade === grade);
  if (typeof search === "string") {
    const q = search.toLowerCase();
    students = students.filter((s) => s.name.toLowerCase().includes(q) || s.student_id.toLowerCase().includes(q));
  }
  res.json({ students, total: students.length });
});

router.get("/v1/teacher/attendance", async (_req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const rows = await db.select().from(usersTable).where(eq(usersTable.role, "student"));
  const records = rows.slice(0, 10).map((s, i) => ({
    id: String(i + 1),
    student_id: s.student_code ?? `S${s.id}`,
    student_name: s.name,
    grade: s.grade ?? "Form 1",
    check_in_time: new Date(Date.now() - 3600000 * (i + 1)).toISOString(),
    status: "present",
    points_earned: 20,
  }));
  res.json({
    records,
    date: today,
    total_present: records.length,
    total_absent: 0,
    total_students: rows.length,
  });
});

router.get("/v1/teacher/leaderboard", async (_req, res) => {
  const rows = await db.select().from(usersTable).where(eq(usersTable.role, "student"));
  const sorted = rows
    .map((s, i) => ({
      rank: i + 1,
      student_id: s.student_code ?? `S${s.id}`,
      name: s.name,
      grade: s.grade ?? "Form 1",
      points: 2500 - i * 100,
      badge: i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : undefined,
    }))
    .slice(0, 10);
  res.json({ entries: sorted, period: "This Week" });
});

// ---------------------------------------------------------------------------
// Class + document management (the new pieces this task requires)
// ---------------------------------------------------------------------------

/**
 * Returns true if the authenticated principal owns the class (or is admin).
 * Used to scope mutations to the teacher's own classes.
 */
async function teacherOwnsClass(req: Express.Request, classId: number): Promise<boolean> {
  if (req.auth?.role === "admin") return true;
  const cls = (await db.select().from(classesTable).where(eq(classesTable.id, classId)))[0];
  return !!cls && cls.teacher_id === req.auth?.user_id;
}

async function teacherOwnsDocument(req: Express.Request, docId: number): Promise<boolean> {
  if (req.auth?.role === "admin") return true;
  const doc = (await db.select().from(documentsTable).where(eq(documentsTable.id, docId)))[0];
  return !!doc && doc.uploaded_by === req.auth?.user_id;
}

router.get("/v1/teacher/classes", async (req, res) => {
  // Admins see everything; teachers see only their own classes.
  const rows = req.auth?.role === "admin"
    ? await db.select().from(classesTable)
    : await db.select().from(classesTable).where(eq(classesTable.teacher_id, req.auth!.user_id));
  res.json({ classes: rows });
});

router.post("/v1/teacher/classes", async (req, res) => {
  const { name, grade } = req.body ?? {};
  if (typeof name !== "string" || typeof grade !== "string") {
    res.status(400).json({ error: "name and grade required" });
    return;
  }
  const [cls] = await db.insert(classesTable).values({
    name, grade, teacher_id: req.auth!.user_id,
  }).returning();
  res.status(201).json(cls);
});

router.post("/v1/teacher/classes/:classId/enroll", async (req, res) => {
  const classId = Number(req.params.classId);
  const { student_code } = req.body ?? {};
  if (!Number.isFinite(classId) || typeof student_code !== "string") {
    res.status(400).json({ error: "classId and student_code required" });
    return;
  }
  if (!(await teacherOwnsClass(req, classId))) {
    res.status(403).json({ error: "class not owned by this teacher" });
    return;
  }
  const student = (await db.select().from(usersTable).where(eq(usersTable.student_code, student_code)))[0];
  if (!student) {
    res.status(404).json({ error: "student not found" });
    return;
  }
  // Idempotent enrol.
  const existing = (await db.select().from(classMembershipsTable).where(
    and(eq(classMembershipsTable.class_id, classId), eq(classMembershipsTable.student_id, student.id)),
  ))[0];
  if (!existing) {
    await db.insert(classMembershipsTable).values({ class_id: classId, student_id: student.id });
  }
  res.json({ ok: true, class_id: classId, student_id: student.id });
});

const objStore = new ObjectStorageService();

/**
 * Step 1 of upload: get a presigned URL the teacher's browser PUTs the PDF
 * bytes to directly. The browser then calls POST /v1/teacher/documents with
 * the returned `object_path` to register the upload.
 */
router.post("/v1/teacher/documents/upload-url", async (_req, res) => {
  const uploadURL = await objStore.getObjectEntityUploadURL();
  res.json({ upload_url: uploadURL });
});

/**
 * Step 2 of upload: register the uploaded PDF as a document and (optionally)
 * assign it to one or more classes.
 *
 * Body: { name, subject?, pages?, size_bytes?, content_type?, object_path, class_ids?: number[] }
 */
router.post("/v1/teacher/documents", async (req, res) => {
  const { name, subject, pages, size_bytes, content_type, object_path, class_ids } = req.body ?? {};
  if (typeof name !== "string" || typeof object_path !== "string") {
    res.status(400).json({ error: "name and object_path required" });
    return;
  }
  const normalized = objStore.normalizeObjectEntityPath(object_path);
  const [doc] = await db.insert(documentsTable).values({
    name,
    subject: typeof subject === "string" ? subject : "General",
    pages: Number.isFinite(pages) ? Number(pages) : 1,
    size_bytes: Number.isFinite(size_bytes) ? Number(size_bytes) : 0,
    content_type: typeof content_type === "string" ? content_type : "application/pdf",
    object_path: normalized,
    uploaded_by: req.auth!.user_id,
  }).returning();

  if (Array.isArray(class_ids) && class_ids.length > 0) {
    const requested = class_ids.filter((c) => Number.isFinite(c)).map((c) => Number(c));
    // Only assign to classes the teacher actually owns (admin sees all).
    const ownedChecks = await Promise.all(requested.map((id) => teacherOwnsClass(req, id)));
    const owned = requested.filter((_, i) => ownedChecks[i]);
    if (owned.length > 0) {
      await db.insert(documentAssignmentsTable).values(
        owned.map((classId) => ({ document_id: doc.id, class_id: classId })),
      ).onConflictDoNothing();
    }
  }
  res.status(201).json({ document: doc });
});

router.post("/v1/teacher/documents/:docId/assign", async (req, res) => {
  const docId = Number(req.params.docId);
  const { class_id } = req.body ?? {};
  if (!Number.isFinite(docId) || !Number.isFinite(class_id)) {
    res.status(400).json({ error: "docId and class_id required" });
    return;
  }
  if (!(await teacherOwnsDocument(req, docId))) {
    res.status(403).json({ error: "document not owned by this teacher" });
    return;
  }
  if (!(await teacherOwnsClass(req, Number(class_id)))) {
    res.status(403).json({ error: "class not owned by this teacher" });
    return;
  }
  await db.insert(documentAssignmentsTable).values({
    document_id: docId, class_id: Number(class_id),
  }).onConflictDoNothing();
  res.json({ ok: true });
});

router.get("/v1/teacher/documents", async (req, res) => {
  // Admins see everything; teachers see only documents they uploaded.
  const rows = req.auth?.role === "admin"
    ? await db.select().from(documentsTable)
    : await db.select().from(documentsTable).where(eq(documentsTable.uploaded_by, req.auth!.user_id));
  res.json({ documents: rows });
});

export default router;
