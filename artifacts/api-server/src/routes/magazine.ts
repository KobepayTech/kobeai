import { Router } from "express";
import { requireAuth } from "../lib/auth";
import {
  ensureMagazineTables,
  generateAllEditions,
  generateSchoolEdition,
  generateStudentEdition,
  latestEditionForStudent,
  latestSchoolEdition,
} from "../lib/magazine";
import {
  db,
  parentChildrenTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

import { requirePremium } from "../lib/entitlements";
const router = Router();

const requireStaff = requireAuth(["teacher", "admin", "super_admin"]);
const requireParent = requireAuth(["parent"]);

/**
 * POST /v1/staff/magazine/generate
 * Body: { week_start?: "YYYY-MM-DD", student_code?: string }
 * With no body, regenerates the school edition + a fresh per-student edition
 * for every student. With `student_code`, only that student.
 */
router.post("/v1/staff/magazine/generate", requireStaff, async (req, res) => {
  await ensureMagazineTables();
  const body = req.body ?? {};
  const week =
    typeof body.week_start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.week_start)
      ? body.week_start
      : undefined;
  const studentCode = typeof body.student_code === "string" ? body.student_code.trim() : "";
  const editorId = req.auth?.user_id ?? null;

  if (studentCode) {
    const outcome = await generateStudentEdition(studentCode, week, editorId);
    if (!outcome) {
      res.status(404).json({ error: "student_not_found" });
      return;
    }
    res.json({ edition: outcome });
    return;
  }

  const outcome = await generateAllEditions(week, editorId);
  res.json(outcome);
});

/** POST /v1/staff/magazine/school/generate — school edition only, quick path. */
router.post("/v1/staff/magazine/school/generate", requireStaff, async (req, res) => {
  const editorId = req.auth?.user_id ?? null;
  const week =
    typeof req.body?.week_start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.week_start)
      ? req.body.week_start
      : undefined;
  const outcome = await generateSchoolEdition(week, editorId);
  res.json({ edition: outcome });
});

router.get("/v1/staff/magazine/school/latest", requireStaff, async (_req, res) => {
  const edition = await latestSchoolEdition();
  if (!edition) {
    res.status(404).json({ error: "no_school_edition_yet" });
    return;
  }
  res.json({ edition });
});

router.get("/v1/staff/magazine/student/:studentCode/latest", requireStaff, requirePremium("parent_report_plus"), async (req, res) => {
  const raw = req.params.studentCode;
  const code = typeof raw === "string" ? raw.trim() : "";
  if (!code) {
    res.status(400).json({ error: "student_code required" });
    return;
  }
  const edition = await latestEditionForStudent(code);
  if (!edition) {
    res.status(404).json({ error: "no_edition_yet" });
    return;
  }
  res.json({ edition });
});

/**
 * GET /v1/parent/child/:childId/magazine/latest
 * Parent-facing. Ownership-checked through parent_children so a parent can
 * only ever see their own child's magazine.
 */
router.get("/v1/parent/child/:childId/magazine/latest", requireParent, async (req, res) => {
  const parentId = Number(req.auth?.user_id);
  if (!Number.isFinite(parentId) || parentId <= 0) {
    res.status(401).json({ error: "no parent in token" });
    return;
  }

  // Reuse the same ownership model as the parent router — inline the query
  // here to avoid a cyclic import.
  const owned = await db
    .select({
      student_user_id: usersTable.id,
      student_code: usersTable.student_code,
    })
    .from(parentChildrenTable)
    .innerJoin(usersTable, eq(usersTable.id, parentChildrenTable.student_user_id))
    .where(eq(parentChildrenTable.parent_user_id, parentId));

  const raw = String(req.params.childId ?? "");
  const numeric = Number(raw);
  const legacyMap: Record<string, string> = { "1": "TEST001", "2": "TEST002" };
  const legacyCode = legacyMap[raw];
  const child = owned.find(
    (c) =>
      (Number.isFinite(numeric) && c.student_user_id === numeric) ||
      (legacyCode && c.student_code === legacyCode),
  );
  if (!child || !child.student_code) {
    res.status(404).json({ error: "child_not_found" });
    return;
  }

  const edition = await latestEditionForStudent(child.student_code);
  if (!edition) {
    // Generate on-demand for the first read.
    const created = await generateStudentEdition(child.student_code);
    if (!created) {
      res.status(404).json({ error: "no_edition_available" });
      return;
    }
    res.json({
      edition: {
        week_start: new Date().toISOString().slice(0, 10),
        content: created.content,
        generated_at: new Date().toISOString(),
      },
    });
    return;
  }
  res.json({ edition });
});

export default router;
