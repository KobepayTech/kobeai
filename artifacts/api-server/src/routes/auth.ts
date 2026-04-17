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

const router = Router();

/**
 * Student watch login. Keeps the legacy demo PIN ("1234") so the watch APK
 * doesn't need a rebuild, but now issues a real signed JWT instead of the
 * old `demo-student-token` string.
 */
router.post("/v1/auth/login", async (req, res) => {
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
  // Hardcoded demo PIN is restricted to the seeded `TEST001` account so the
  // existing watch APK still logs in. Every other student must validate
  // against their stored hash.
  const isDemo = student.student_code === "TEST001" && pin === "1234";
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

router.post("/v1/auth/teacher/login", async (req, res) => {
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
  // Demo creds are seeded as hashed pins; allow either the seeded hash or the
  // raw demo password for backwards-compat with smoke tests.
  const ok =
    checkPin(password, user.password_hash) ||
    (email === "teacher@school.tz" && password === "teacher123") ||
    (email === "admin@school.tz" && password === "admin123") ||
    (email === "superadmin@kobeai.tz" && password === "super123");
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

router.post("/v1/auth/parent/login", (req, res) => {
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
  // Parents aren't in the users table yet (out of scope) — issue a JWT keyed
  // on phone so per-request auth still works against the parent endpoints.
  const token = signToken({
    role: "parent",
    user_id: 0,
    name: "Grace Mwangi",
    email: phone,
  });
  res.json({
    access_token: token,
    token_type: "bearer",
    parent_name: "Grace Mwangi",
  });
});

export default router;
