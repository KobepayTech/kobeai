import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { NECTA_A_LEVEL, NECTA_O_LEVEL, SCORE_METHODS, type ScoreMethod } from "../lib/grading";
import {
  ResultsError,
  announceResult,
  classroomScoreboard,
  computeClassResults,
  createExam,
  createTerm,
  examResultSheet,
  getExam,
  getResultsSettings,
  listExams,
  listGradingSchemes,
  listTerms,
  recordExamResult,
  removeExamResult,
  resolveTermId,
  saveGradingScheme,
  setCurrentTerm,
  studentReportCard,
  updateExam,
  updateResultsSettings,
} from "../lib/results";
import { onResult } from "../lib/results-events";
import { requireKioskOrStaff } from "./classroom";

// Results: exams, live marks, report cards and scoreboards.
//   staff   — teachers mark and see full class results
//   admin   — terms, grading schemes and the school's results settings
//   parents — their own child's report card, including positions, never other children's scores
//   kiosk   — the classroom TV scoreboard, limited by the school's tv_scoreboard setting

const router = Router();
const staff = requireAuth(["teacher", "admin", "super_admin"]);
const admin = requireAuth(["admin", "super_admin"]);
const parent = requireAuth(["parent"]);

type Handler = (req: Request, res: Response) => Promise<void>;
const handle =
  (fn: Handler) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ResultsError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      if ((err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "that already exists" });
        return;
      }
      throw err;
    }
  };

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function requireId(value: unknown, name: string): number {
  const id = positiveInt(value);
  if (id === null) throw new ResultsError(400, `invalid ${name}`);
  return id;
}

function methodParam(value: unknown): ScoreMethod | undefined {
  if (value === undefined || value === "") return undefined;
  if (!SCORE_METHODS.includes(value as ScoreMethod)) {
    throw new ResultsError(400, `method must be one of: ${SCORE_METHODS.join(", ")}`);
  }
  return value as ScoreMethod;
}

// -- settings, grading schemes, terms ---------------------------------------

router.get(
  "/v1/results/settings",
  staff,
  handle(async (_req, res) => {
    res.json({ settings: await getResultsSettings(), schemes: await listGradingSchemes(), methods: SCORE_METHODS });
  }),
);

router.put(
  "/v1/results/settings",
  admin,
  handle(async (req, res) => {
    res.json({ settings: await updateResultsSettings(req.body ?? {}) });
  }),
);

router.get(
  "/v1/results/grading-schemes",
  staff,
  handle(async (_req, res) => {
    res.json({ schemes: await listGradingSchemes(), necta: { o_level: NECTA_O_LEVEL, a_level: NECTA_A_LEVEL } });
  }),
);

router.post(
  "/v1/results/grading-schemes",
  admin,
  handle(async (req, res) => {
    res.status(201).json({ scheme: await saveGradingScheme(null, req.body ?? {}) });
  }),
);

router.put(
  "/v1/results/grading-schemes/:id",
  admin,
  handle(async (req, res) => {
    res.json({ scheme: await saveGradingScheme(requireId(req.params.id, "scheme id"), req.body ?? {}) });
  }),
);

router.get(
  "/v1/results/terms",
  staff,
  handle(async (_req, res) => {
    res.json({ terms: await listTerms() });
  }),
);

router.post(
  "/v1/results/terms",
  admin,
  handle(async (req, res) => {
    res.status(201).json({ term: await createTerm(req.body ?? {}) });
  }),
);

router.post(
  "/v1/results/terms/:id/current",
  admin,
  handle(async (req, res) => {
    res.json({ term: await setCurrentTerm(requireId(req.params.id, "term id")) });
  }),
);

// -- exams and marks ---------------------------------------------------------

router.get(
  "/v1/results/exams",
  staff,
  handle(async (req, res) => {
    const status = req.query["status"] === "open" || req.query["status"] === "closed" ? String(req.query["status"]) : null;
    res.json({
      exams: await listExams({ classId: positiveInt(req.query["class_id"]), termId: positiveInt(req.query["term_id"]), status }),
    });
  }),
);

router.post(
  "/v1/results/exams",
  staff,
  handle(async (req, res) => {
    res.status(201).json({ exam: await createExam(req.body ?? {}, req.auth?.user_id ?? null) });
  }),
);

router.patch(
  "/v1/results/exams/:id",
  staff,
  handle(async (req, res) => {
    res.json({ exam: await updateExam(requireId(req.params.id, "exam id"), req.body ?? {}) });
  }),
);

router.get(
  "/v1/results/exams/:id/results",
  staff,
  handle(async (req, res) => {
    res.json(await examResultSheet(requireId(req.params.id, "exam id")));
  }),
);

router.put(
  "/v1/results/exams/:id/results/:studentId",
  staff,
  handle(async (req, res) => {
    const examId = requireId(req.params.id, "exam id");
    const studentId = requireId(req.params.studentId, "student id");
    const marks = Number(req.body?.marks);
    const recorded = await recordExamResult(pool, {
      examId,
      studentId,
      marks,
      source: "dashboard",
      recordedBy: req.auth?.user_id ?? null,
    });
    const { rows } = await pool.query(`SELECT name, student_code FROM users WHERE id = $1`, [studentId]);
    announceResult(recorded.exam, { id: studentId, name: rows[0]?.name ?? null, student_code: rows[0]?.student_code ?? null }, {
      marks: recorded.result.marks,
      percent: recorded.result.percent,
    });
    res.json({ result: recorded.result });
  }),
);

router.delete(
  "/v1/results/exams/:id/results/:studentId",
  staff,
  handle(async (req, res) => {
    const studentId = requireId(req.params.studentId, "student id");
    const exam = await removeExamResult(requireId(req.params.id, "exam id"), studentId);
    const { rows } = await pool.query(`SELECT name, student_code FROM users WHERE id = $1`, [studentId]);
    announceResult(exam, { id: studentId, name: rows[0]?.name ?? null, student_code: rows[0]?.student_code ?? null }, null);
    res.json({ removed: true });
  }),
);

// -- scoreboards and report cards -------------------------------------------

router.get(
  "/v1/results/scoreboard",
  staff,
  handle(async (req, res) => {
    const classId = requireId(req.query["class_id"], "class_id");
    const termId = await resolveTermId(req.query["term_id"]);
    res.json(await computeClassResults(classId, termId, methodParam(req.query["method"])));
  }),
);

router.get(
  "/v1/results/report-card/:studentId",
  staff,
  handle(async (req, res) => {
    const termId = await resolveTermId(req.query["term_id"]);
    res.json(await studentReportCard(requireId(req.params.studentId, "student id"), termId, methodParam(req.query["method"])));
  }),
);

/**
 * GET /v1/results/stream?class_id=
 * Server-sent events for live scoreboards: `result` events as marks are
 * recorded or removed. Dashboards read it with fetch() so the bearer token
 * stays in a header rather than the URL.
 */
router.get("/v1/results/stream", staff, (req: Request, res: Response) => {
  const classId = positiveInt(req.query["class_id"]);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(`event: ready\ndata: ${JSON.stringify({ class_id: classId })}\n\n`);
  const stop = onResult((event) => {
    if (classId !== null && event.class_id !== classId) return;
    res.write(`event: result\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    stop();
    clearInterval(ping);
  });
});

router.get(
  "/v1/parent/child/:childId/report-card",
  parent,
  handle(async (req, res) => {
    const childId = requireId(req.params.childId, "child id");
    const { rows } = await pool.query(`SELECT 1 FROM parent_children WHERE parent_user_id = $1 AND student_user_id = $2`, [
      req.auth?.user_id ?? 0,
      childId,
    ]);
    if (!rows[0]) throw new ResultsError(404, "child not found");
    const termId = await resolveTermId(req.query["term_id"]);
    res.json({ ...(await studentReportCard(childId, termId)), terms: await listTerms() });
  }),
);

router.get(
  "/v1/classroom/scoreboard",
  requireKioskOrStaff,
  handle(async (req, res) => {
    const classId = requireId(req.query["class_id"], "class_id");
    const termId = await resolveTermId(req.query["term_id"]);
    res.json(await classroomScoreboard(classId, termId));
  }),
);

router.get(
  "/v1/results/exams/:id",
  staff,
  handle(async (req, res) => {
    const exam = await getExam(requireId(req.params.id, "exam id"));
    if (!exam) throw new ResultsError(404, "exam not found");
    res.json({ exam });
  }),
);

export default router;
