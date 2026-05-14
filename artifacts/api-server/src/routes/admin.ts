import { Router, type IRouter } from "express";
import { askAI, getAiHealth } from "../lib/ai-provider";
import { requireAuth } from "../lib/auth";
import {
  describeWatchHceSecret,
  rotateWatchHceSecret,
} from "../lib/watch-secret";

const router: IRouter = Router();

// AI diagnostics are auth-gated (teacher OR admin token). The legacy
// /v1/admin/stats endpoint stays open to preserve the school-server admin
// CLI workflow.
const adminAuth = requireAuth(["admin", "teacher"]);

// Rotating the HCE secret invalidates every existing watch APK for this
// school until they're rebuilt, so restrict to actual admins.
const adminOnly = requireAuth(["admin", "super_admin"]);

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

/**
 * GET /api/v1/admin/watch-hce-secret
 * Returns metadata about the current watch HCE secret WITHOUT revealing it.
 * Use the fingerprint to confirm a freshly-rotated value made it onto the
 * server before re-building APKs.
 */
router.get("/v1/admin/watch-hce-secret", adminOnly, async (_req, res) => {
  res.json(await describeWatchHceSecret());
});

/**
 * POST /api/v1/admin/watch-hce-secret/rotate
 * Generates a new 32-byte hex secret, stores it on the tenant row, and
 * returns the plaintext ONCE so the operator can pass it to the next watch
 * APK build via `-PWATCH_HCE_SECRET=...`. Existing watches continue to fail
 * /v1/print/pair with HTTP 401 ("bad_signature") until they're updated.
 */
router.post("/v1/admin/watch-hce-secret/rotate", adminOnly, async (_req, res) => {
  try {
    const { secret, tenant_id, rotated_at } = await rotateWatchHceSecret();
    res.json({
      secret,
      tenant_id,
      rotated_at: rotated_at.toISOString(),
      warning: "Store this value now — it is not retrievable again. Rebuild the watch APK with -PWATCH_HCE_SECRET=<value>.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "rotate_failed", detail: msg });
  }
});

export default router;
