import { Router } from "express";
import { requireAuth, signToken } from "../lib/auth";
import { db, usersTable, quizzesTable, quizQuestionsTable, quizAttemptsTable, classMembershipsTable } from "@workspace/db";
import { desc, eq, inArray, sql } from "drizzle-orm";

const auth = requireAuth(["student"]);

/**
 * Compatibility router for the KobeAI Wear OS watch app.
 *
 * The watch client (watch-app/) calls a stable `/api/v1/watch/...` URL prefix.
 * This router maps those paths onto the core REST endpoints already implemented
 * in auth.ts / quizzes.ts / wallet.ts, reshaping requests/responses where the
 * watch's expected JSON differs from the canonical API.
 *
 * The Express app mounts the main router at `/api`, so paths here use `/v1/...`.
 */

const router = Router();

const STUDENT_FIXTURES: Record<string, { name: string; grade: string; balance: number; pendingQuizzes: number }> = {
  TEST001: { name: "John Doe", grade: "Form 1", balance: 5000, pendingQuizzes: 3 },
};

router.post("/v1/watch/login", async (req, res) => {
  const { student_id, pin } = req.body ?? {};
  if (typeof student_id !== "string" || typeof pin !== "string") {
    res.status(400).json({ success: false, error: "student_id and pin are required" });
    return;
  }
  // Demo PIN gate is intentionally narrow: only the seeded TEST001 fixture
  // can use the hardcoded `1234`; other accounts must go through the proper
  // /v1/auth/login endpoint that validates against the stored hash.
  const fixture = STUDENT_FIXTURES[student_id];
  if (!fixture || student_id !== "TEST001" || pin !== "1234") {
    res.status(401).json({ success: false, error: "Invalid credentials" });
    return;
  }
  // Look up the seeded student row so the JWT carries a real user_id and
  // student_code that downstream `requireAuth(["student"])` middleware accepts.
  const row = (await db.select().from(usersTable).where(eq(usersTable.student_code, student_id)))[0];
  if (!row || row.role !== "student") {
    res.status(401).json({ success: false, error: "Invalid credentials" });
    return;
  }
  const token = signToken({
    role: "student",
    user_id: row.id,
    student_id: row.student_code ?? student_id,
    name: row.name,
  });
  res.json({
    success: true,
    token,
    student_name: fixture.name,
    grade: fixture.grade,
    wallet_balance: fixture.balance,
    pending_quizzes: fixture.pendingQuizzes,
  });
});

router.post("/v1/watch/ask", auth, (req, res, next) => {
  req.url = "/v1/watch/ask";
  next();
});

// ---------------------------------------------------------------------------
// Quiz endpoints — DB-backed. Reads from quizzesTable and persists every
// submission to quizAttemptsTable so the watch leaderboard is real.
//
// FALLBACK: when the DB has no quizzes at all (fresh install), we still
// return a small hardcoded set so the watch demo works out of the box. IDs
// for fallback quizzes start with "demo-"; submissions against them are NOT
// persisted (no FK target).
// ---------------------------------------------------------------------------

const FALLBACK_QUIZZES = [
  { id: "demo-1", title: "Mathematics Basics", subject: "Mathematics", questions_count: 5, points_possible: 50, duration_minutes: 15 },
  { id: "demo-2", title: "Science - Biology", subject: "Science", questions_count: 3, points_possible: 30, duration_minutes: 10 },
];
const FALLBACK_QUESTIONS: Record<string, { id: string; text: string; options: string[]; correct: string; points: number }[]> = {
  "demo-1": [
    { id: "q1", text: "What is 15 + 27?", options: ["A) 32", "B) 42", "C) 52", "D) 62"], correct: "B", points: 10 },
    { id: "q2", text: "What is 8 x 7?", options: ["A) 48", "B) 54", "C) 56", "D) 64"], correct: "C", points: 10 },
    { id: "q3", text: "Square root of 144?", options: ["A) 10", "B) 11", "C) 12", "D) 13"], correct: "C", points: 10 },
    { id: "q4", text: "What is 15% of 200?", options: ["A) 25", "B) 30", "C) 35", "D) 40"], correct: "B", points: 10 },
    { id: "q5", text: "What is 2^3?", options: ["A) 6", "B) 8", "C) 9", "D) 16"], correct: "B", points: 10 },
  ],
  "demo-2": [
    { id: "q1", text: "Process plants use to make food?", options: ["A) Respiration", "B) Photosynthesis", "C) Digestion", "D) Osmosis"], correct: "B", points: 10 },
    { id: "q2", text: "Chambers in a human heart?", options: ["A) 2", "B) 3", "C) 4", "D) 5"], correct: "C", points: 10 },
    { id: "q3", text: "Basic unit of life?", options: ["A) Atom", "B) Molecule", "C) Cell", "D) Organ"], correct: "C", points: 10 },
  ],
};

/**
 * Look up which class IDs the calling student belongs to. Returns [] if the
 * student row isn't found or has no memberships. Used both to filter the quiz
 * list and to authorize per-quiz start/submit access below.
 */
async function getCallerClassIds(studentCode: string): Promise<number[]> {
  const [me] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.student_code, studentCode)).limit(1);
  if (!me) return [];
  const rows = await db.select({ class_id: classMembershipsTable.class_id }).from(classMembershipsTable).where(eq(classMembershipsTable.student_id, me.id));
  return rows.map((r) => r.class_id);
}

router.get("/v1/watch/quizzes", auth, async (req, res) => {
  const studentCode = req.auth!.student_id!;
  const all = await db.select().from(quizzesTable).orderBy(desc(quizzesTable.created_at));
  // Fallback ONLY when the DB has no quizzes at all (fresh install). If a
  // teacher has authored quizzes but none target this student's classes, we
  // intentionally return an empty list rather than mixing demo content in.
  if (all.length === 0) {
    res.json({ quizzes: FALLBACK_QUIZZES });
    return;
  }
  const classIds = await getCallerClassIds(studentCode);
  const visible = all.filter((q) => q.class_id == null || classIds.includes(q.class_id));
  if (visible.length === 0) {
    res.json({ quizzes: [] });
    return;
  }
  const counts = await db
    .select({
      quiz_id: quizQuestionsTable.quiz_id,
      questions_count: sql<number>`COUNT(*)::int`,
      points_possible: sql<number>`COALESCE(SUM(${quizQuestionsTable.points}), 0)::int`,
    })
    .from(quizQuestionsTable)
    .where(inArray(quizQuestionsTable.quiz_id, visible.map((q) => q.id)))
    .groupBy(quizQuestionsTable.quiz_id);
  const map = new Map(counts.map((c) => [c.quiz_id, c]));
  res.json({
    quizzes: visible
      .map((q) => ({
        id: String(q.id),
        title: q.title,
        subject: q.subject,
        questions_count: map.get(q.id)?.questions_count ?? 0,
        points_possible: map.get(q.id)?.points_possible ?? 0,
        duration_minutes: q.duration_minutes,
      }))
      // Hide quizzes a teacher hasn't finished authoring yet.
      .filter((q) => q.questions_count > 0),
  });
});

router.get("/v1/watch/quiz/:quizId/start", auth, async (req, res) => {
  const quizId = String(req.params.quizId);
  if (quizId.startsWith("demo-")) {
    const meta = FALLBACK_QUIZZES.find((q) => q.id === quizId);
    const qs = FALLBACK_QUESTIONS[quizId];
    if (!meta || !qs) {
      res.status(404).json({ error: "quiz not found" });
      return;
    }
    res.json({
      attempt_id: `attempt_${Date.now()}`,
      quiz_id: quizId,
      title: meta.title,
      questions: qs.map(({ id, text, options, points }) => ({ id, text, options, points })),
      time_limit_minutes: meta.duration_minutes,
      total_points: qs.reduce((s, q) => s + q.points, 0),
    });
    return;
  }
  const numeric = Number(quizId);
  if (!Number.isFinite(numeric)) {
    res.status(400).json({ error: "invalid quiz id" });
    return;
  }
  const [quiz] = await db.select().from(quizzesTable).where(eq(quizzesTable.id, numeric)).limit(1);
  if (!quiz) {
    res.status(404).json({ error: "quiz not found" });
    return;
  }
  // Authorize: a class-scoped quiz must match one of the caller's classes.
  // Globally-scoped quizzes (class_id IS NULL) are accessible to any student.
  if (quiz.class_id != null) {
    const classIds = await getCallerClassIds(req.auth!.student_id!);
    if (!classIds.includes(quiz.class_id)) {
      res.status(403).json({ error: "not enrolled in this quiz's class" });
      return;
    }
  }
  const questions = await db
    .select()
    .from(quizQuestionsTable)
    .where(eq(quizQuestionsTable.quiz_id, quiz.id))
    .orderBy(quizQuestionsTable.order_idx, quizQuestionsTable.id);
  res.json({
    attempt_id: `attempt_${Date.now()}`,
    quiz_id: quizId,
    title: quiz.title,
    questions: questions.map((q) => ({
      id: String(q.id),
      text: q.text,
      options: q.options,
      points: q.points,
    })),
    time_limit_minutes: quiz.duration_minutes,
    total_points: questions.reduce((s, q) => s + q.points, 0),
  });
});

router.post("/v1/watch/quiz/:quizId/submit", auth, async (req, res) => {
  const quizId = String(req.params.quizId);
  const answers = (req.body?.answers ?? {}) as Record<string, string>;
  // Resolve the question set + correct answers either from fallback or DB.
  let questions: { id: string; correct: string; points: number }[] = [];
  let isDb = false;
  if (quizId.startsWith("demo-")) {
    const qs = FALLBACK_QUESTIONS[quizId];
    if (!qs) {
      res.status(404).json({ error: "quiz not found" });
      return;
    }
    questions = qs.map((q) => ({ id: q.id, correct: q.correct, points: q.points }));
  } else {
    const numeric = Number(quizId);
    if (!Number.isFinite(numeric)) {
      res.status(400).json({ error: "invalid quiz id" });
      return;
    }
    const [quiz] = await db.select().from(quizzesTable).where(eq(quizzesTable.id, numeric)).limit(1);
    if (!quiz) {
      res.status(404).json({ error: "quiz not found" });
      return;
    }
    // Same class authorization as /start — block submissions to quizzes the
    // student isn't enrolled in (prevents IDOR / leaderboard pollution).
    if (quiz.class_id != null) {
      const classIds = await getCallerClassIds(req.auth!.student_id!);
      if (!classIds.includes(quiz.class_id)) {
        res.status(403).json({ error: "not enrolled in this quiz's class" });
        return;
      }
    }
    const rows = await db.select().from(quizQuestionsTable).where(eq(quizQuestionsTable.quiz_id, numeric)).orderBy(quizQuestionsTable.order_idx);
    if (rows.length === 0) {
      res.status(404).json({ error: "quiz not found" });
      return;
    }
    isDb = true;
    questions = rows.map((q) => ({ id: String(q.id), correct: q.correct_letter, points: q.points }));
  }
  let correct = 0;
  let pointsEarned = 0;
  for (const q of questions) {
    const ans = answers[q.id];
    if (ans && ans.startsWith(q.correct)) {
      correct++;
      pointsEarned += q.points;
    }
  }
  const total = questions.length;
  const score = total === 0 ? 0 : Math.round((correct / total) * 100);

  // Persist real attempts so the leaderboard reflects what students actually did.
  if (isDb) {
    try {
      await db.insert(quizAttemptsTable).values({
        quiz_id: Number(quizId),
        student_code: req.auth!.student_id!,
        student_name: req.auth!.name ?? req.auth!.student_id!,
        score,
        points_earned: pointsEarned,
        correct_answers: correct,
        total_questions: total,
      });
    } catch {
      // Non-fatal — student still gets their score.
    }
  }

  res.json({
    score,
    points_earned: pointsEarned,
    new_balance: 5000 + pointsEarned,
    feedback: score >= 80 ? "Excellent work!" : score >= 60 ? "Good effort!" : "Keep practicing!",
  });
});

router.get("/v1/watch/wallet", auth, (_req, res) => {
  res.json({
    balance: 5000,
    total_earned: 15000,
    level: 3,
    recent_transactions: [
      { amount: 20, type: "attendance", description: "Daily check-in", created_at: new Date(Date.now() - 3600000).toISOString() },
      { amount: 10, type: "ai_question", description: "Asked about photosynthesis", created_at: new Date(Date.now() - 7200000).toISOString() },
      { amount: 25, type: "quiz", description: "Math quiz complete", created_at: new Date(Date.now() - 10800000).toISOString() },
    ],
  });
});

router.post("/v1/watch/sync", auth, (_req, res) => {
  res.json({ new_quizzes: [], wallet_balance: 5000 });
});

router.post("/v1/watch/heartbeat", auth, (_req, res) => {
  res.json({ success: true });
});

export default router;
