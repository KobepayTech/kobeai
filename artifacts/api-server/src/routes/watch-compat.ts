import { Router } from "express";

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

router.post("/v1/watch/login", (req, res) => {
  const { student_id, pin } = req.body ?? {};
  if (typeof student_id !== "string" || typeof pin !== "string") {
    res.status(400).json({ success: false, error: "student_id and pin are required" });
    return;
  }
  const fixture = STUDENT_FIXTURES[student_id];
  if (!fixture || pin !== "1234") {
    res.status(401).json({ success: false, error: "Invalid credentials" });
    return;
  }
  res.json({
    success: true,
    token: `watch-${student_id}-${Date.now()}`,
    student_name: fixture.name,
    grade: fixture.grade,
    wallet_balance: fixture.balance,
    pending_quizzes: fixture.pendingQuizzes,
  });
});

router.post("/v1/watch/ask", (req, res, next) => {
  req.url = "/v1/watch/ask";
  next();
});

router.get("/v1/watch/quizzes", (_req, res) => {
  res.json({
    quizzes: [
      { id: "1", title: "Mathematics Basics", subject: "Mathematics", questions_count: 5, points_possible: 50, duration_minutes: 15 },
      { id: "2", title: "Science - Biology", subject: "Science", questions_count: 3, points_possible: 30, duration_minutes: 10 },
      { id: "3", title: "Tanzania History", subject: "History", questions_count: 4, points_possible: 40, duration_minutes: 12 },
      { id: "4", title: "English Grammar", subject: "English", questions_count: 6, points_possible: 60, duration_minutes: 20 },
      { id: "5", title: "Kiswahili Vocabulary", subject: "Kiswahili", questions_count: 5, points_possible: 50, duration_minutes: 15 },
    ],
  });
});

const QUIZ_QUESTIONS: Record<string, { id: string; text: string; options: string[]; correct: string; points: number }[]> = {
  "1": [
    { id: "q1", text: "What is 15 + 27?", options: ["A) 32", "B) 42", "C) 52", "D) 62"], correct: "B", points: 10 },
    { id: "q2", text: "What is 8 x 7?", options: ["A) 48", "B) 54", "C) 56", "D) 64"], correct: "C", points: 10 },
    { id: "q3", text: "Square root of 144?", options: ["A) 10", "B) 11", "C) 12", "D) 13"], correct: "C", points: 10 },
    { id: "q4", text: "What is 15% of 200?", options: ["A) 25", "B) 30", "C) 35", "D) 40"], correct: "B", points: 10 },
    { id: "q5", text: "What is 2^3?", options: ["A) 6", "B) 8", "C) 9", "D) 16"], correct: "B", points: 10 },
  ],
  "2": [
    { id: "q1", text: "Process plants use to make food?", options: ["A) Respiration", "B) Photosynthesis", "C) Digestion", "D) Osmosis"], correct: "B", points: 10 },
    { id: "q2", text: "Chambers in a human heart?", options: ["A) 2", "B) 3", "C) 4", "D) 5"], correct: "C", points: 10 },
    { id: "q3", text: "Basic unit of life?", options: ["A) Atom", "B) Molecule", "C) Cell", "D) Organ"], correct: "C", points: 10 },
  ],
};

router.get("/v1/watch/quiz/:quizId/start", (req, res) => {
  const quizId = req.params.quizId;
  const questions = QUIZ_QUESTIONS[quizId] ?? QUIZ_QUESTIONS["1"];
  const quizMeta: Record<string, { title: string; subject: string; duration: number }> = {
    "1": { title: "Mathematics Basics", subject: "Mathematics", duration: 15 },
    "2": { title: "Science - Biology", subject: "Science", duration: 10 },
    "3": { title: "Tanzania History", subject: "History", duration: 12 },
    "4": { title: "English Grammar", subject: "English", duration: 20 },
    "5": { title: "Kiswahili Vocabulary", subject: "Kiswahili", duration: 15 },
  };
  const meta = quizMeta[quizId] ?? quizMeta["1"];
  res.json({
    attempt_id: `attempt_${Date.now()}`,
    quiz_id: quizId,
    title: meta.title,
    questions: questions.map(({ id, text, options, points }) => ({ id, text, options, points })),
    time_limit_minutes: meta.duration,
    total_points: questions.reduce((s, q) => s + q.points, 0),
  });
});

router.post("/v1/watch/quiz/:quizId/submit", (req, res) => {
  const quizId = req.params.quizId;
  const questions = QUIZ_QUESTIONS[quizId] ?? QUIZ_QUESTIONS["1"];
  const answers = (req.body?.answers ?? {}) as Record<string, string>;
  let correct = 0;
  let pointsEarned = 0;
  for (const q of questions) {
    const ans = answers[q.id];
    if (ans && ans.startsWith(q.correct)) {
      correct++;
      pointsEarned += q.points;
    }
  }
  const score = Math.round((correct / questions.length) * 100);
  res.json({
    score,
    points_earned: pointsEarned,
    new_balance: 5000 + pointsEarned,
    feedback: score >= 80 ? "Excellent work!" : score >= 60 ? "Good effort!" : "Keep practicing!",
  });
});

router.get("/v1/watch/wallet", (_req, res) => {
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

router.post("/v1/watch/sync", (_req, res) => {
  res.json({ new_quizzes: [], wallet_balance: 5000 });
});

router.post("/v1/watch/heartbeat", (_req, res) => {
  res.json({ success: true });
});

export default router;
