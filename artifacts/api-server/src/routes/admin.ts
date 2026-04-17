import { Router, type IRouter } from "express";
import { askAI, getAiHealth } from "../lib/ai-provider";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

// AI diagnostics are auth-gated (teacher OR admin token). The legacy
// /v1/admin/stats endpoint stays open to preserve the school-server admin
// CLI workflow.
const adminAuth = requireAuth(["admin", "teacher"]);

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

/**
 * GET /api/v1/admin/ai/health
 * Snapshot of the on-prem Ollama service: is it up, is the configured model
 * installed, what models are available. Used by the school-server "School AI"
 * admin page.
 */
router.get("/v1/admin/ai/health", adminAuth, async (_req, res) => {
  const health = await getAiHealth();
  res.json(health);
});

/**
 * POST /api/v1/admin/ai/test
 * Run a single prompt through the same askAI() path the watch uses, so an
 * admin can sanity-check the offline LLM without needing a watch on hand.
 *
 * Body: { question: string, system?: string }
 */
router.post("/v1/admin/ai/test", adminAuth, async (req, res) => {
  const question =
    typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question) {
    res.status(400).json({ error: "question is required" });
    return;
  }
  const system =
    typeof req.body?.system === "string" && req.body.system.trim()
      ? req.body.system.trim()
      : undefined;

  const startedAt = Date.now();
  const result = await askAI(question, system);
  res.json({
    ...result,
    latency_ms: Date.now() - startedAt,
  });
});

export default router;
