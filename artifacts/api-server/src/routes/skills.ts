import { Router } from "express";
import { requireAuth } from "../lib/auth";
import { entitlementFor, lockedPayload, requirePremium } from "../lib/entitlements";
import { logger } from "../lib/logger";
import { ERROR_LABELS, ERROR_TYPES } from "../lib/skill-taxonomy";
import {
  STRONG_THRESHOLD,
  WEAK_THRESHOLD,
  reindexAll,
  schoolSkillGaps,
  skillCohort,
  skillTaxonomy,
  baselineSubjectMarks,
  studentSkillProfile,
  teacherAgreement,
  unmappedQuestions,
} from "../lib/skill-engine";

// ===========================================================================
// Skill profiles.
//
// Everything here is read-only apart from the reindex. Skills are written by
// one path only — a teacher marking a paper (routes/teacher-lens.ts →
// lib/skill-engine.ts) — because the value of the profile rests entirely on
// it being the teacher's own judgement, recorded, and nothing else.
// ===========================================================================

const router = Router();
const staff = requireAuth(["teacher", "admin", "super_admin"]);
const admin = requireAuth(["admin", "super_admin"]);

/** GET /v1/skills — the taxonomy, plus the error vocabulary the UI renders. */
router.get("/v1/skills", staff, async (_req, res) => {
  const skills = await skillTaxonomy();
  res.json({
    skills,
    error_types: ERROR_TYPES.map((code) => ({ code, label: ERROR_LABELS[code] })),
    thresholds: { weak: WEAK_THRESHOLD, strong: STRONG_THRESHOLD },
  });
});

/**
 * GET /v1/skills/students/:studentCode — one student's profile.
 *
 * Not "62% in Chemistry" but "strong on atomic structure, weak on balancing
 * equations and the mole concept, and here is what to do next".
 */
router.get("/v1/skills/students/:studentCode", staff, async (req, res) => {
  const code = String(req.params.studentCode);
  const entitlement = await entitlementFor(code);

  // An unsubscribed student is NOT a blank page. The school's own marks stay
  // visible — they are the school's record of its own pupil — and what the
  // subscription adds is the answer to *why* that mark. Showing the two side
  // by side at the moment a teacher is looking at the child is the only
  // honest place to make the case for paying.
  if (!entitlement.entitled) {
    res.status(200).json({
      ...lockedPayload("skill_profile", entitlement),
      baseline: { subjects: await baselineSubjectMarks(code) },
    });
    return;
  }

  const profile = await studentSkillProfile(code);
  if (!profile) return void res.status(404).json({ error: "no such student" });
  res.json({ ...profile, entitled: true, entitlement });
});

/** GET /v1/student/skills — the same profile, for the student's own screen. */
router.get(
  "/v1/student/skills",
  requireAuth(["student"]),
  requirePremium("skill_profile"),
  async (req, res) => {
    const code = req.auth?.student_id;
    if (!code) return void res.status(401).json({ error: "no student" });
    const profile = await studentSkillProfile(code);
    if (!profile) return void res.status(404).json({ error: "no profile yet" });
    res.json({ ...profile, entitled: true });
  },
);

/**
 * GET /v1/skills/gaps?form_level=Form%203&subject=Mathematics
 * The head teacher's view: which skills is a whole form failing, ranked by
 * how much of the form is below half. This is what turns a pile of marking
 * into a remedial lesson somebody can timetable.
 */
router.get("/v1/skills/gaps", staff, async (req, res) => {
  const formLevel = String(req.query["form_level"] ?? "").trim() || null;
  const subject = String(req.query["subject"] ?? "").trim() || null;
  const gaps = await schoolSkillGaps({ formLevel, subject });
  res.json({ gaps, form_level: formLevel, subject, threshold: WEAK_THRESHOLD });
});

/** GET /v1/skills/:id/cohort — who in this form is where on one skill. */
router.get("/v1/skills/:id/cohort", staff, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "bad id" });
  const formLevel = String(req.query["form_level"] ?? "").trim() || null;
  res.json({ students: await skillCohort(id, formLevel) });
});

/**
 * GET /v1/skills/agreement — how often K9's reading matched the teacher's
 * mark. The teacher always wins; this says how far apart they were.
 */
router.get("/v1/skills/agreement", staff, async (_req, res) => {
  res.json(await teacherAgreement());
});

/**
 * GET /v1/skills/unmapped — questions the mapper could not place.
 * The taxonomy's own to-do list: a question nobody can attribute is a skill
 * missing from the curriculum file, not a student problem.
 */
router.get("/v1/skills/unmapped", staff, async (_req, res) => {
  res.json({ questions: await unmappedQuestions() });
});

/**
 * POST /v1/skills/reindex — rebuild every profile from the marked papers.
 * Mastery is a cache over `skill_observations`; this is the button that
 * proves it. Worth running after the taxonomy gains new skills, so old papers
 * are re-attributed to them.
 */
router.post("/v1/skills/reindex", admin, async (_req, res) => {
  try {
    const result = await reindexAll();
    logger.info(result, "skill profiles reindexed");
    res.json(result);
  } catch (err) {
    logger.error({ err }, "skill reindex failed");
    res.status(500).json({ error: "Reindex failed." });
  }
});

export default router;
