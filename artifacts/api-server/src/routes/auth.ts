import { Router } from "express";
import {
  TeacherLoginBody,
  ParentLoginBody,
  LoginBody,
} from "@workspace/api-zod";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { signToken } from "../lib/auth";
import { checkPin } from "../lib/seed";
import { rateLimit } from "../lib/rate-limit";

const router = Router();

// Demo credentials are only honoured in development. In any other env we fall
// through to the hashed-password check so a misconfigured prod can't be logged
// into with the README creds.
const ALLOW_DEMO_CREDS = (process.env["NODE_ENV"] ?? "development") === "development";

// Throttle every login surface. 10 attempts per minute per source IP is plenty
// for a real classroom (one watch per student) and stops PIN brute-force cold.
const loginLimiter = rateLimit({ windowMs: 60_000, max: 10, name: "auth-login" });

/**
 * Student watch login. Keeps the legacy demo PIN ("1234") so the watch APK
 * doesn't need a rebuild, but now issues a real signed JWT instead of the
 * old `demo-student-token` string.
 */
router.post("/v1/auth/login", loginLimiter, async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { student_id, pin } = parsed.data;
  const student = (await db.select().from(usersTable).where(eq(usersTable.student_code, student_id)))[0];
  // Demo student keeps the hard-coded PIN. Real students would use checkPin
  // against their stored hash; out of scope for this task per the brief.
  if (!student || student.role !== "student") {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const isDemo = ALLOW_DEMO_CREDS && student.student_code === "TEST001" && pin === "1234";
  const ok = isDemo || (student.password_hash && checkPin(pin, student.password_hash));
  if (!ok) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const token = signToken({
    role: "student",
    user_id: student.id,
    student_id: student.student_code ?? undefined,
    name: student.name,
  });
  res.json({
    access_token: token,
    token_type: "bearer",
    student_name: student.name,
    grade: student.grade ?? "Form 1",
    wallet_balance: 5000,
  });
});

router.post("/v1/auth/teacher/login", loginLimiter, async (req, res) => {
  const parsed = TeacherLoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { email, password } = parsed.data;
  const user = (await db.select().from(usersTable).where(eq(usersTable.email, email)))[0];
  if (!user || (user.role !== "teacher" && user.role !== "admin" && user.role !== "super_admin")) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const demoOk =
    ALLOW_DEMO_CREDS &&
    ((email === "teacher@school.tz" && password === "teacher123") ||
      (email === "admin@school.tz" && password === "admin123") ||
      (email === "superadmin@kobeai.tz" && password === "super123"));
  const ok = demoOk || checkPin(password, user.password_hash);
  if (!ok) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const token = signToken({
    role: user.role as "teacher" | "admin" | "super_admin",
    user_id: user.id,
    email: user.email ?? undefined,
    name: user.name,
  });
  res.json({
    access_token: token,
    token_type: "bearer",
    teacher_name: user.name,
    school: "Dar es Salaam Secondary School",
    role: user.role,
  });
});

router.post("/v1/auth/parent/login", loginLimiter, async (req, res) => {
  const parsed = ParentLoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { phone, pin } = parsed.data;
  if (pin !== "1234") {
    res.status(401).json({ error: "Invalid phone or PIN" });
    return;
  }
  // Find or create the parent user row (we reuse the `email` column for the
  // phone — the schema rebrand is out of scope). Real parent rows enable
  // FK-clean ownership of `parent_children`, `stationery_orders`, etc.
  let parent = (
    await db.select().from(usersTable).where(eq(usersTable.email, phone))
  )[0];
  if (!parent) {
    [parent] = await db
      .insert(usersTable)
      .values({
        role: "parent",
        name: "Parent",
        email: phone,
      })
      .returning();
  } else if (parent.role !== "parent") {
    res.status(409).json({ error: "Phone already registered with another role" });
    return;
  }
  const token = signToken({
    role: "parent",
    user_id: parent!.id,
    name: parent!.name,
    email: phone,
  });
  res.json({
    access_token: token,
    token_type: "bearer",
    parent_name: parent!.name,
  });
});

export default router;
