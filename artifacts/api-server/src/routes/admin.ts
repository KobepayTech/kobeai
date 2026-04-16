import { Router, type IRouter } from "express";

const router: IRouter = Router();

const startedAt = Date.now();

/**
 * GET /api/v1/admin/stats
 * Snapshot of system activity. Used by the school-server admin CLI:
 *   kobeai-admin stats
 *
 * Today this returns synthetic numbers that match the demo data the rest of
 * the API serves. Once the database schema is populated for a real pilot,
 * swap the body of each block for a real Drizzle count() query.
 */
router.get("/v1/admin/stats", (_req, res) => {
  const now = Date.now();
  const uptimeSeconds = Math.floor((now - startedAt) / 1000);

  res.json({
    generated_at: new Date(now).toISOString(),
    uptime_seconds: uptimeSeconds,
    ai: {
      provider: process.env["AI_PROVIDER"] ?? "canned",
      model: process.env["OLLAMA_MODEL"] ?? "mistral:7b",
    },
    students: {
      total: 248,
      active_today: 187,
      with_watches: 142,
    },
    teachers: {
      total: 18,
      active_today: 14,
    },
    quizzes: {
      total: 24,
      attempts_today: 96,
      average_score: 78,
    },
    ai_questions: {
      asked_today: 312,
      asked_total: 14_872,
    },
    wallet: {
      points_awarded_today: 6_240,
      points_in_circulation: 1_284_500,
      currency: "TSh",
    },
    devices: {
      watches_online: 138,
      watches_total: 142,
    },
  });
});

export default router;
