import { Router } from "express";
import {
  TeacherLoginBody,
  ParentLoginBody,
  LoginBody,
} from "@workspace/api-zod";

const router = Router();

router.post("/v1/auth/login", (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { student_id, pin } = parsed.data;
  if (student_id === "TEST001" && pin === "1234") {
    res.json({
      access_token: "demo-student-token",
      token_type: "bearer",
      student_name: "John Doe",
      grade: "Form 1",
      wallet_balance: 5000,
    });
    return;
  }
  res.status(401).json({ error: "Invalid credentials" });
});

router.post("/v1/auth/teacher/login", (req, res) => {
  const parsed = TeacherLoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { email, password } = parsed.data;
  if (
    (email === "teacher@school.tz" || email === "admin@school.tz") &&
    (password === "teacher123" || password === "admin123")
  ) {
    res.json({
      access_token: "demo-teacher-token",
      token_type: "bearer",
      teacher_name: email.startsWith("admin") ? "Admin User" : "Ms. Sarah Kamau",
      school: "Dar es Salaam Secondary School",
      role: email.startsWith("admin") ? "admin" : "teacher",
    });
    return;
  }
  res.status(401).json({ error: "Invalid credentials" });
});

router.post("/v1/auth/parent/login", (req, res) => {
  const parsed = ParentLoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { phone, pin } = parsed.data;
  if (pin === "1234") {
    res.json({
      access_token: "demo-parent-token",
      token_type: "bearer",
      parent_name: "Grace Mwangi",
    });
    return;
  }
  res.status(401).json({ error: "Invalid phone or PIN" });
});

export default router;
