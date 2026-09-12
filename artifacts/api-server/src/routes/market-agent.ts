import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, marketAgentRunsTable, marketQuestionsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";
import {
  kpPayoutStats,
  loadAgentSettings,
  planMarket,
  readFloor,
  runMarketAgent,
  saveAgentSettings,
} from "../lib/market-agent";

// Operator console for the question-market agent. Everything here is
// super-admin only: the agent decides what students are asked and what the
// school pays them in KP, so a per-school admin must not be able to retune it.
const router = Router();
router.use("/central/v1/admin/market-agent", requireAuth(["super_admin"]));

/**
 * GET /central/v1/admin/market-agent
 * Everything the console needs in one call: settings, what the agent would do
 * if it ran right now, the KP it has been paying out, and the last 20 cycles.
 */
router.get("/central/v1/admin/market-agent", async (_req, res) => {
  const settings = await loadAgentSettings();
  const floor = await readFloor();
  const [runs, payouts] = await Promise.all([
    db.select().from(marketAgentRunsTable).orderBy(desc(marketAgentRunsTable.started_at)).limit(20),
    kpPayoutStats(),
  ]);
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(marketQuestionsTable)
    .where(eq(marketQuestionsTable.review_status, "pending"));

  res.json({
    settings,
    floor: {
      total_open: floor.totalOpen,
      by_subject: Object.fromEntries(floor.open),
      won_24h: Object.fromEntries(floor.won24h),
      roster_subjects: floor.rosterSubjects,
      weak_topics: floor.weakTopics.slice(0, 20),
    },
    // A dry run: exactly the plan the next cycle would execute.
    next_plan: planMarket(settings, floor),
    payouts,
    pending_review: pending?.n ?? 0,
    runs,
  });
});

const NUMERIC_FIELDS = [
  "floor_per_subject",
  "max_open_questions",
  "cycle_minutes",
  "stale_hours",
  "reward_min",
  "reward_max",
] as const;

/** PATCH /central/v1/admin/market-agent — retune the agent. */
router.patch("/central/v1/admin/market-agent", async (req, res) => {
  const patch: Record<string, unknown> = {};
  for (const field of NUMERIC_FIELDS) {
    if (req.body?.[field] === undefined) continue;
    const n = Number(req.body[field]);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
      res.status(400).json({ error: `${field} must be a non-negative integer` });
      return;
    }
    patch[field] = n;
  }
  for (const flag of ["enabled", "human_review"] as const) {
    if (req.body?.[flag] === undefined) continue;
    if (typeof req.body[flag] !== "boolean") {
      res.status(400).json({ error: `${flag} must be a boolean` });
      return;
    }
    patch[flag] = req.body[flag];
  }
  if (req.body?.subjects !== undefined) {
    if (
      !Array.isArray(req.body.subjects) ||
      !req.body.subjects.every((s: unknown) => typeof s === "string" && s.trim())
    ) {
      res.status(400).json({ error: "subjects must be an array of non-empty strings" });
      return;
    }
    patch["subjects"] = [...new Set((req.body.subjects as string[]).map((s) => s.trim()))];
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "no fields to update" });
    return;
  }

  const merged = { ...(await loadAgentSettings()), ...patch } as {
    reward_min: number;
    reward_max: number;
  };
  if (merged.reward_min > merged.reward_max) {
    res.status(400).json({ error: "reward_min must be <= reward_max" });
    return;
  }

  const settings = await saveAgentSettings(patch);
  logger.info({ patch }, "market agent retuned");
  res.json({ settings });
});

/**
 * POST /central/v1/admin/market-agent/run
 * Run one cycle now. 409 while a cycle is already in flight — cycles are
 * never concurrent, or two of them race to fill the same floor.
 */
router.post("/central/v1/admin/market-agent/run", async (_req, res) => {
  try {
    const summary = await runMarketAgent("manual");
    res.json({ run: summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("already running")) {
      res.status(409).json({ error: "a cycle is already running" });
      return;
    }
    logger.error({ err }, "manual market agent run failed");
    res.status(500).json({ error: message });
  }
});

/**
 * GET /central/v1/admin/market-agent/review
 * The drafts waiting for a human, when the agent runs in human_review mode.
 */
router.get("/central/v1/admin/market-agent/review", async (_req, res) => {
  const questions = await db
    .select()
    .from(marketQuestionsTable)
    .where(eq(marketQuestionsTable.review_status, "pending"))
    .orderBy(desc(marketQuestionsTable.created_at))
    .limit(100);
  res.json({ questions });
});

/**
 * POST /central/v1/admin/market-agent/review/:id
 * Body: { decision: "approve" | "reject" }
 * Approving puts the question on the floor; rejecting takes it out of play
 * but keeps the row, so the agent's hit rate stays measurable.
 */
router.post("/central/v1/admin/market-agent/review/:id", async (req, res) => {
  const id = Number(req.params.id);
  const decision = String(req.body?.decision ?? "");
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "bad id" });
    return;
  }
  if (decision !== "approve" && decision !== "reject") {
    res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
    return;
  }
  const [updated] = await db
    .update(marketQuestionsTable)
    .set(
      decision === "approve"
        ? { review_status: "approved", released_at: new Date() }
        : { review_status: "rejected", status: "expired" },
    )
    .where(and(eq(marketQuestionsTable.id, id), eq(marketQuestionsTable.review_status, "pending")))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "no pending question with that id" });
    return;
  }
  res.json({ question: updated });
});

export default router;
