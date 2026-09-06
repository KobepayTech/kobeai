import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import {
  ensureLearningProfileTables,
  getMergedProfile,
  mergeProfile,
  rollupAllStudents,
  rollupStudent,
  studentsWithBirthdayToday,
} from "../lib/learning-profile";

const router = Router();

const requireStaff = requireAuth(["teacher", "admin", "super_admin"]);

function cleanText(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function cleanStringArray(value: unknown, max = 12): string[] | null {
  if (!Array.isArray(value)) return null;
  const cleaned = value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0 && v.length <= 120)
    .slice(0, max);
  return cleaned;
}

function cleanBirthday(value: unknown): string | null | undefined {
  if (value === null) return null; // explicit clear
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Accept "MM-DD" or "YYYY-MM-DD"; normalize to "MM-DD".
  const iso = /^(\d{4}-)?(\d{2})-(\d{2})$/.exec(trimmed);
  if (!iso) return undefined;
  const month = Number(iso[2]);
  const day = Number(iso[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * GET /v1/staff/learning-profile/:studentCode
 * Merged view (override_* wins over computed_*). If no row exists yet, we
 * kick a rollup on demand so first views aren't empty.
 */
router.get(
  "/v1/staff/learning-profile/:studentCode",
  requireStaff,
  async (req, res) => {
    const studentCode = cleanText(req.params.studentCode, 100);
    if (!studentCode) {
      res.status(400).json({ error: "student_code required" });
      return;
    }
    const profile = await getMergedProfile(studentCode);
    if (!profile) {
      res.status(404).json({ error: "student_not_found" });
      return;
    }
    res.json({ profile });
  },
);

/**
 * PATCH /v1/staff/learning-profile/:studentCode
 * Teacher edit surface. Any field not provided is left untouched. Passing
 * an array (topics / achievements) sets the override; passing null clears
 * the override so the computed value shows through again.
 */
router.patch(
  "/v1/staff/learning-profile/:studentCode",
  requireStaff,
  async (req, res) => {
    const studentCode = cleanText(req.params.studentCode, 100);
    if (!studentCode) {
      res.status(400).json({ error: "student_code required" });
      return;
    }
    await ensureLearningProfileTables();

    const body = req.body ?? {};
    const sets: string[] = [];
    const values: unknown[] = [studentCode];

    const push = (col: string, value: unknown) => {
      values.push(value);
      sets.push(`${col} = $${values.length}`);
    };

    if ("birthday" in body) {
      const bd = cleanBirthday(body.birthday);
      if (bd === undefined) {
        res.status(400).json({ error: "birthday must be MM-DD or YYYY-MM-DD" });
        return;
      }
      push("birthday", bd);
    }
    if ("override_topics_strong" in body) {
      push(
        "override_topics_strong",
        body.override_topics_strong === null
          ? null
          : JSON.stringify(cleanStringArray(body.override_topics_strong) ?? []),
      );
    }
    if ("override_topics_weak" in body) {
      push(
        "override_topics_weak",
        body.override_topics_weak === null
          ? null
          : JSON.stringify(cleanStringArray(body.override_topics_weak) ?? []),
      );
    }
    if ("override_achievements" in body) {
      push(
        "override_achievements",
        body.override_achievements === null
          ? null
          : JSON.stringify(cleanStringArray(body.override_achievements) ?? []),
      );
    }
    if ("override_notes" in body) {
      push("override_notes", cleanText(body.override_notes, 2000));
    }

    if (sets.length === 0) {
      res.status(400).json({ error: "no editable fields provided" });
      return;
    }

    push("updated_by", req.auth?.user_id ?? null);
    sets.push(`updated_at = NOW()`);

    // Row must exist first — if none, seed via rollup then re-apply.
    const existing = await pool.query(
      `SELECT 1 FROM student_learning_profile WHERE student_code = $1 LIMIT 1`,
      [studentCode],
    );
    if (!existing.rows[0]) {
      const seeded = await rollupStudent(studentCode);
      if (!seeded) {
        res.status(404).json({ error: "student_not_found" });
        return;
      }
    }

    const updated = await pool.query(
      `UPDATE student_learning_profile
       SET ${sets.join(", ")}
       WHERE student_code = $1
       RETURNING *`,
      values,
    );
    if (!updated.rows[0]) {
      res.status(404).json({ error: "student_not_found" });
      return;
    }
    const withName = await pool.query(
      `SELECT lp.*, u.name AS student_name
       FROM student_learning_profile lp
       LEFT JOIN users u ON u.student_code = lp.student_code
       WHERE lp.student_code = $1
       LIMIT 1`,
      [studentCode],
    );
    res.json({ profile: mergeProfile(withName.rows[0] ?? updated.rows[0]) });
  },
);

/**
 * POST /v1/staff/learning-profile/rollup
 * Manually kick the rollup for one student (?student_code=) or every student.
 * Nightly scheduler runs this automatically once a day.
 */
router.post("/v1/staff/learning-profile/rollup", requireStaff, async (req, res) => {
  const studentCode = cleanText(req.body?.student_code ?? req.query["student_code"], 100);
  if (studentCode) {
    const profile = await rollupStudent(studentCode);
    if (!profile) {
      res.status(404).json({ error: "student_not_found" });
      return;
    }
    res.json({ profile });
    return;
  }
  const outcome = await rollupAllStudents();
  res.json(outcome);
});

/**
 * GET /v1/staff/learning-profile/birthdays/today
 * Feeds the K9 birthday-automation surface: which students should get a
 * classroom-TV celebration today.
 */
router.get("/v1/staff/learning-profile/birthdays/today", requireStaff, async (_req, res) => {
  const birthdays = await studentsWithBirthdayToday();
  res.json({ birthdays });
});

export default router;
