import { Router } from "express";
import { SubmitQuizBody } from "@workspace/api-zod";

const router = Router();

const QUIZZES = [
  { id: "1", title: "Mathematics Basics", subject: "Mathematics", questions_count: 5, points_possible: 50, duration_minutes: 15 },
  { id: "2", title: "Science - Biology", subject: "Science", questions_count: 3, points_possible: 30, duration_minutes: 10 },
  { id: "3", title: "Tanzania History", subject: "History", questions_count: 4, points_possible: 40, duration_minutes: 12 },
  { id: "4", title: "English Grammar", subject: "English", questions_count: 6, points_possible: 60, duration_minutes: 20 },
  { id: "5", title: "Kiswahili Vocabulary", subject: "Kiswahili", questions_count: 5, points_possible: 50, duration_minutes: 15 },
];

const QUIZ_QUESTIONS: Record<string, { id: string; text: string; options: string[]; correct: string; points: number }[]> = {
  "1": [
    { id: "q1", text: "What is 15 + 27?", options: ["A) 32", "B) 42", "C) 52", "D) 62"], correct: "B", points: 10 },
    { id: "q2", text: "What is 8 × 7?", options: ["A) 48", "B) 54", "C) 56", "D) 64"], correct: "C", points: 10 },
    { id: "q3", text: "What is the square root of 144?", options: ["A) 10", "B) 11", "C) 12", "D) 13"], correct: "C", points: 10 },
    { id: "q4", text: "What is 15% of 200?", options: ["A) 25", "B) 30", "C) 35", "D) 40"], correct: "B", points: 10 },
    { id: "q5", text: "What is 2³?", options: ["A) 6", "B) 8", "C) 9", "D) 16"], correct: "B", points: 10 },
  ],
  "2": [
    { id: "q1", text: "What is the process by which plants make food?", options: ["A) Respiration", "B) Photosynthesis", "C) Digestion", "D) Osmosis"], correct: "B", points: 10 },
    { id: "q2", text: "How many chambers does a human heart have?", options: ["A) 2", "B) 3", "C) 4", "D) 5"], correct: "C", points: 10 },
    { id: "q3", text: "What is the basic unit of life?", options: ["A) Atom", "B) Molecule", "C) Cell", "D) Organ"], correct: "C", points: 10 },
  ],
};

router.get("/v1/quizzes", (_req, res) => {
  res.json({ quizzes: QUIZZES });
});

router.get("/v1/quizzes/:quizId/start", (req, res) => {
  const { quizId } = req.params;
  const quiz = QUIZZES.find((q) => q.id === quizId);
  if (!quiz) {
    res.status(404).json({ error: "Quiz not found" });
    return;
  }
  const questions = (QUIZ_QUESTIONS[quizId] || QUIZ_QUESTIONS["1"]).map(
    ({ id, text, options, points }) => ({ id, text, options, points })
  );
  res.json({
    attempt_id: `attempt_${Date.now()}`,
    quiz_id: quizId,
    title: quiz.title,
    subject: quiz.subject,
    questions,
    time_limit_minutes: quiz.duration_minutes,
    total_points: quiz.points_possible,
  });
});

router.post("/v1/quizzes/:quizId/submit", (req, res) => {
  const { quizId } = req.params;
  const parsed = SubmitQuizBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const quiz = QUIZZES.find((q) => q.id === quizId);
  const questions = QUIZ_QUESTIONS[quizId] || QUIZ_QUESTIONS["1"];
  const { answers } = parsed.data;
  let correct = 0;
  let pointsEarned = 0;
  answers.forEach((ans) => {
    const q = questions.find((q) => q.id === ans.question_id);
    if (q && ans.answer.startsWith(q.correct)) {
      correct++;
      pointsEarned += q.points;
    }
  });
  const totalPoints = quiz?.points_possible ?? questions.reduce((s, q) => s + q.points, 0);
  const score = Math.round((correct / questions.length) * 100);
  res.json({
    score,
    total_points: totalPoints,
    points_earned: pointsEarned,
    correct_answers: correct,
    total_questions: questions.length,
    message: score >= 80 ? "Excellent work!" : score >= 60 ? "Good effort!" : "Keep practicing!",
  });
});

export default router;
