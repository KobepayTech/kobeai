import { Router } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  quizzesTable,
  quizQuestionsTable,
  quizAttemptsTable,
  classMembershipsTable,
  usersTable,
} from "@workspace/db";
import { SubmitQuizBody } from "@workspace/api-zod";
import { verifyToken } from "../lib/auth";
import type { Request, Response, NextFunction } from "express";

const router = Router();

/**
 * Best-effort token decode. Unlike requireAuth, this never rejects — it just
 * populates `req.auth` if a valid bearer is present so downstream handlers
 * can do per-student filtering (e.g. class-based quiz visibility, attempt
 * persistence). Used because /v1/quizzes is historically a public route but
 * the watch and dashboard now both send their tokens.
 */
function softAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? req.header("Authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    const principal = verifyToken(header.slice(7).trim());
    if (principal) req.auth = principal;
  }
  next();
}
router.use("/v1/quizzes", softAuth);

// ---------------------------------------------------------------------------
// Hardcoded fallback. We keep these so a freshly-seeded environment with no
// teacher-authored quizzes still has something for the watch / teacher
// dashboard to render. The first time a teacher creates a real quiz, the
// fallback disappears (the real list always wins when non-empty).
// ---------------------------------------------------------------------------
const FALLBACK_QUIZZES = [
  { id: "demo-1", title: "Mathematics Basics", subject: "Mathematics", questions_count: 5, points_possible: 50, duration_minutes: 15 },
  { id: "demo-2", title: "Science - Biology", subject: "Science", questions_count: 3, points_possible: 30, duration_minutes: 10 },
  { id: "demo-3", title: "Tanzania History", subject: "History", questions_count: 4, points_possible: 40, duration_minutes: 12 },
];
const FALLBACK_QUESTIONS: Record<string, { id: string; text: string; options: string[]; correct: string; points: number }[]> = {
  "demo-1": [
    { id: "q1", text: "What is 15 + 27?", options: ["A) 32", "B) 42", "C) 52", "D) 62"], correct: "B", points: 10 },
    { id: "q2", text: "What is 8 × 7?", options: ["A) 48", "B) 54", "C) 56", "D) 64"], correct: "C", points: 10 },
    { id: "q3", text: "What is the square root of 144?", options: ["A) 10", "B) 11", "C) 12", "D) 13"], correct: "C", points: 10 },
    { id: "q4", text: "What is 15% of 200?", options: ["A) 25", "B) 30", "C) 35", "D) 40"], correct: "B", points: 10 },
    { id: "q5", text: "What is 2³?", options: ["A) 6", "B) 8", "C) 9", "D) 16"], correct: "B", points: 10 },
  ],
  "demo-2": [
    { id: "q1", text: "What is the process by which plants make food?", options: ["A) Respiration", "B) Photosynthesis", "C) Digestion", "D) Osmosis"], correct: "B", points: 10 },
    { id: "q2", text: "How many chambers does a human heart have?", options: ["A) 2", "B) 3", "C) 4", "D) 5"], correct: "C", points: 10 },
    { id: "q3", text: "What is the basic unit of life?", options: ["A) Atom", "B) Molecule", "C) Cell", "D) Organ"], correct: "C", points: 10 },
  ],
  "demo-3": [
    { id: "q1", text: "When did Tanganyika gain independence?", options: ["A) 1960", "B) 1961", "C) 1963", "D) 1964"], correct: "B", points: 10 },
    { id: "q2", text: "Who was the first president of Tanzania?", options: ["A) Kikwete", "B) Mkapa", "C) Nyerere", "D) Mwinyi"], correct: "C", points: 10 },
    { id: "q3", text: "When did Tanganyika and Zanzibar unite?", options: ["A) 1962", "B) 1963", "C) 1964", "D) 1965"], correct: "C", points: 10 },
    { id: "q4", text: "What is Tanzania's capital city?", options: ["A) Dar es Salaam", "B) Arusha", "C) Mwanza", "D) Dodoma"], correct: "D", points: 10 },
  ],
};

// Whether `id` references a fallback quiz (string) vs a real DB row (number).
function isFallbackId(id: string): boolean {
  return id.startsWith("demo-") || !/^\d+$/.test(id);
}

/**
 * Loads a quiz + its questions from the DB or returns the hardcoded fallback.
 * Returns null if the id refers to a non-existent quiz.
 */
async function loadQuiz(id: string) {
  if (isFallbackId(id)) {
    const meta = FALLBACK_QUIZZES.find((q) => q.id === id);
    const qs = FALLBACK_QUESTIONS[id];
    if (!meta || !qs) return null;
    return {
      kind: "fallback" as const,
      meta,
      questions: qs.map((q) => ({
        id: q.id,
        text: q.text,
        options: q.options,
        correct_letter: q.correct,
        points: q.points,
      })),
    };
  }
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return null;
  const [quiz] = await db.select().from(quizzesTable).where(eq(quizzesTable.id, numericId)).limit(1);
  if (!quiz) return null;
  const questions = await db
    .select()
    .from(quizQuestionsTable)
    .where(eq(quizQuestionsTable.quiz_id, quiz.id))
    .orderBy(quizQuestionsTable.order_idx, quizQuestionsTable.id);
  const totalPoints = questions.reduce((s, q) => s + q.points, 0);
  return {
    kind: "db" as const,
    meta: {
      id: String(quiz.id),
      title: quiz.title,
      subject: quiz.subject,
      questions_count: questions.length,
      points_possible: totalPoints,
      duration_minutes: quiz.duration_minutes,
    },
    questions: questions.map((q) => ({
      id: String(q.id),
      text: q.text,
      options: q.options,
      correct_letter: q.correct_letter,
      points: q.points,
    })),
  };
}

/**
 * GET /v1/quizzes
 * Lists all quizzes available to the caller. Filters by class membership when
 * the caller is a student so they only see quizzes assigned to one of their
 * enrolled classes (plus globally-scoped quizzes with class_id = null).
 */
router.get("/v1/quizzes", async (req, res) => {
  // Try to identify the caller — the route is unauthed historically, but if a
  // bearer token is present we honor it for student class filtering.
  let studentClassIds: number[] | null = null;
  const auth = req.auth;
  if (auth?.role === "student" && auth.student_id) {
    const [studentRow] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.student_code, auth.student_id))
      .limit(1);
    if (studentRow) {
      const memberships = await db
        .select({ class_id: classMembershipsTable.class_id })
        .from(classMembershipsTable)
        .where(eq(classMembershipsTable.student_id, studentRow.id));
      studentClassIds = memberships.map((m) => m.class_id);
    }
  }

  // Aggregate question counts in a single query so we don't N+1 the listing.
  const counts = await db
    .select({
      quiz_id: quizQuestionsTable.quiz_id,
      questions_count: sql<number>`COUNT(*)::int`,
      points_possible: sql<number>`COALESCE(SUM(${quizQuestionsTable.points}), 0)::int`,
    })
    .from(quizQuestionsTable)
    .groupBy(quizQuestionsTable.quiz_id);
  const countMap = new Map(counts.map((c) => [c.quiz_id, c]));

  const dbQuizzes = await db.select().from(quizzesTable).orderBy(desc(quizzesTable.created_at));
  const visible = studentClassIds
    ? dbQuizzes.filter((q) => q.class_id == null || studentClassIds!.includes(q.class_id))
    : dbQuizzes;

  const formatted = visible
    .map((q) => {
      const c = countMap.get(q.id);
      return {
        id: String(q.id),
        title: q.title,
        subject: q.subject,
        questions_count: c?.questions_count ?? 0,
        points_possible: c?.points_possible ?? 0,
        duration_minutes: q.duration_minutes,
      };
    })
    // Hide empty quizzes from students — a teacher might be mid-authoring.
    .filter((q) => (auth?.role === "student" ? q.questions_count > 0 : true));

  // Append fallback quizzes when no real quizzes exist (or none are visible).
  if (formatted.length === 0) {
    res.json({ quizzes: FALLBACK_QUIZZES });
    return;
  }
  res.json({ quizzes: formatted });
});

router.get("/v1/quizzes/:quizId/start", async (req, res) => {
  const { quizId } = req.params;
  const loaded = await loadQuiz(quizId);
  if (!loaded) {
    res.status(404).json({ error: "Quiz not found" });
    return;
  }
  res.json({
    attempt_id: `attempt_${Date.now()}`,
    quiz_id: quizId,
    title: loaded.meta.title,
    subject: loaded.meta.subject,
    questions: loaded.questions.map(({ id, text, options, points }) => ({
      id,
      text,
      options,
      points,
    })),
    time_limit_minutes: loaded.meta.duration_minutes,
    total_points: loaded.meta.points_possible,
  });
});

router.post("/v1/quizzes/:quizId/submit", async (req, res) => {
  const { quizId } = req.params;
  const parsed = SubmitQuizBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const loaded = await loadQuiz(quizId);
  if (!loaded) {
    res.status(404).json({ error: "Quiz not found" });
    return;
  }
  const { answers } = parsed.data;
  let correct = 0;
  let pointsEarned = 0;
  loaded.questions.forEach((q) => {
    const ans = answers.find((a) => a.question_id === q.id);
    if (ans && ans.answer.startsWith(q.correct_letter)) {
      correct++;
      pointsEarned += q.points;
    }
  });
  const totalQuestions = loaded.questions.length;
  const score = totalQuestions === 0 ? 0 : Math.round((correct / totalQuestions) * 100);

  // Persist the attempt for leaderboard + teacher analytics, but only when we
  // have a real student token AND a real DB quiz id. Hardcoded fallback
  // quizzes don't have a quizzes.id row to FK to.
  const auth = req.auth;
  if (auth?.role === "student" && auth.student_id && loaded.kind === "db") {
    try {
      await db.insert(quizAttemptsTable).values({
        quiz_id: Number(quizId),
        student_code: auth.student_id,
        student_name: auth.name ?? auth.student_id,
        score,
        points_earned: pointsEarned,
        correct_answers: correct,
        total_questions: totalQuestions,
      });
    } catch {
      // Non-fatal — the student still gets their score response.
    }
  }

  res.json({
    score,
    total_points: loaded.meta.points_possible,
    points_earned: pointsEarned,
    correct_answers: correct,
    total_questions: totalQuestions,
    grade: score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D",
    message:
      score >= 80
        ? "Excellent work!"
        : score >= 60
          ? "Good job — keep practicing!"
          : "Keep trying — review and retake when ready.",
  });
});

export default router;
