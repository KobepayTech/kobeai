import { Router } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, subscriptionCacheTable, studentSettingsTable, quizAttemptsTable, quizzesTable, classMembershipsTable, usersTable } from "@workspace/db";
import { AskQuestionBody } from "@workspace/api-zod";
import { askAI } from "../lib/ai-provider";
import { requireAuth } from "../lib/auth";
import { requireActiveSubscription } from "../lib/central-sync";
import { recordAiQuery } from "../lib/usage-counter";
import { drainPendingGrants } from "../lib/kp";
import { rateLimit } from "../lib/rate-limit";

const router = Router();

router.use("/v1/watch", requireAuth(["student"]));

/**
 * GET /v1/watch/subscription
 * Returns the calling student's own subscription status from the local
 * subscription_cache. The watch uses this to show a "Renew soon" banner
 * when expiry is within 7 days, and to show the parent's phone number so
 * the student can ask their parent to pay.
 */
router.get("/v1/watch/subscription", async (req, res) => {
  const studentCode = req.auth?.student_id;
  if (!studentCode) {
    res.status(401).json({ error: "no student in token" });
    return;
  }
  // Liveness hook for the KP economy: every watch polls /subscription
  // frequently, so this is the cheapest place to guarantee that any
  // membership grants parked while the student was unprovisioned get
  // delivered without waiting for the student to discover the market.
  // Fire-and-forget — never block the subscription read on KP work.
  drainPendingGrants(studentCode).catch((err) =>
    console.error("[watch/subscription] drain failed", err),
  );
  const row = (
    await db
      .select()
      .from(subscriptionCacheTable)
      .where(eq(subscriptionCacheTable.student_code, studentCode))
      .limit(1)
  )[0];
  if (!row) {
    res.json({
      has_subscription: false,
      status: "none",
      plan: null,
      expires_at: null,
      days_until_expiry: null,
      monthly_price_tsh: 0,
      parent_phone: null,
      severity: "info",
      message: "No subscription on file. Ask your parent to subscribe.",
    });
    return;
  }
  const now = Date.now();
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : null;
  const days = exp == null ? null : Math.ceil((exp - now) / 86400000);
  let severity: "ok" | "info" | "warning" | "urgent" = "ok";
  let message = `${row.plan} active`;
  if (row.status === "expired" || (days != null && days < 0)) {
    severity = "urgent";
    message = "Subscription expired. Ask your parent to renew.";
  } else if (days != null && days <= 1) {
    severity = "urgent";
    message = `Expires in ${days <= 0 ? "less than 1 day" : "1 day"}`;
  } else if (days != null && days <= 3) {
    severity = "warning";
    message = `Expires in ${days} days`;
  } else if (days != null && days <= 7) {
    severity = "info";
    message = `Renews in ${days} days`;
  }
  res.json({
    has_subscription: true,
    status: row.status,
    plan: row.plan,
    expires_at: row.expires_at,
    days_until_expiry: days,
    monthly_price_tsh: row.monthly_price_tsh,
    parent_phone: maskPhone(row.parent_phone),
    severity,
    message,
  });
});

/**
 * Mask all but the last 2 digits of a phone number. The watch is shared in
 * classrooms; we don't want a glance at a peer's screen to leak the parent's
 * full number. Returns null if the input is empty.
 */
function maskPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length <= 2) return raw;
  const tail = digits.slice(-2);
  return `${"•".repeat(Math.max(3, digits.length - 2))} ${tail}`;
}

// Premium endpoints — gated by per-student subscription. The middleware always
// sets `x-subscription-status` so the watch app can show a banner; it only
// hard-blocks (HTTP 402) when ENFORCE_SUBSCRIPTIONS=true.
const subGate = requireActiveSubscription();

// Per-student throttle for /watch/ask. The Ollama tutor takes seconds and a
// rapid-fire student would hog the on-prem GPU; cap at 30 questions/min.
const askLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  name: "watch-ask",
  keyGenerator: (req) => req.auth?.student_id ?? req.ip ?? "unknown",
});

router.post("/v1/watch/ask", subGate, askLimiter, async (req, res) => {
  const parsed = AskQuestionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { question } = parsed.data;

  recordAiQuery();
  const { answer, model } = await askAI(question);

  res.json({
    answer,
    points_earned: 10,
    new_balance: 5010,
    follow_up_suggestions: [
      "Can you explain more?",
      "Give me a practice question",
      "How does this relate to real life?",
    ],
    conversation_id: `conv_${Date.now()}`,
    model_used: model,
  });
});

router.post("/v1/watch/attendance/checkin", subGate, (_req, res) => {
  res.json({
    success: true,
    message: "Checked in successfully! +20 points added.",
    points_earned: 20,
    check_in_time: new Date().toISOString(),
    already_checked_in: false,
    new_balance: 5020,
  });
});

/**
 * GET /v1/watch/settings
 * Returns the watch device toggles for the calling student. Defaults to
 * audio_enabled=true, keyboard_enabled=true when no row exists, so the watch
 * never has to special-case "no settings yet". The watch calls this on app
 * launch + on resume and mirrors the result into local DataStore.
 */
router.get("/v1/watch/settings", async (req, res) => {
  const studentCode = req.auth?.student_id;
  if (!studentCode) {
    res.status(401).json({ error: "no student in token" });
    return;
  }
  const row = (
    await db
      .select()
      .from(studentSettingsTable)
      .where(eq(studentSettingsTable.student_code, studentCode))
      .limit(1)
  )[0];
  res.json({
    audio_enabled: row?.audio_enabled ?? true,
    keyboard_enabled: row?.keyboard_enabled ?? true,
  });
});

/**
 * GET /v1/watch/leaderboard
 * Per-class leaderboard for the calling student. Aggregates each classmate's
 * BEST score across every quiz they've attempted so the watch can show a
 * compact "you rank Nth in your class" summary. Returns at most 20 rows.
 *
 * If the student isn't enrolled in any class, returns a global leaderboard
 * across all attempts. The caller's own row is always flagged with `is_me`.
 */
router.get("/v1/watch/leaderboard", async (req, res) => {
  const studentCode = req.auth?.student_id;
  if (!studentCode) {
    res.status(401).json({ error: "no student in token" });
    return;
  }
  // Resolve the calling student's enrolled classes — if any, scope the board
  // to classmates only.
  const [me] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.student_code, studentCode))
    .limit(1);
  let classmateCodes: string[] | null = null;
  if (me) {
    const myClassIds = (
      await db
        .select({ class_id: classMembershipsTable.class_id })
        .from(classMembershipsTable)
        .where(eq(classMembershipsTable.student_id, me.id))
    ).map((r) => r.class_id);
    if (myClassIds.length > 0) {
      const rows = await db
        .select({ student_code: usersTable.student_code })
        .from(usersTable)
        .innerJoin(classMembershipsTable, eq(classMembershipsTable.student_id, usersTable.id))
        .where(and(inArray(classMembershipsTable.class_id, myClassIds), eq(usersTable.role, "student")));
      classmateCodes = rows.map((r) => r.student_code).filter((c): c is string => !!c);
      // Make sure the caller is included even if not in a membership row.
      if (!classmateCodes.includes(studentCode)) classmateCodes.push(studentCode);
    }
  }

  // SUM of best-per-quiz for each student is fairer than total cumulative
  // points (which would reward grinding the same quiz over and over).
  const bestPerQuiz = db
    .select({
      student_code: quizAttemptsTable.student_code,
      student_name: sql<string>`MAX(${quizAttemptsTable.student_name})`.as("student_name"),
      quiz_id: quizAttemptsTable.quiz_id,
      best_points: sql<number>`MAX(${quizAttemptsTable.points_earned})::int`.as("best_points"),
      best_score: sql<number>`MAX(${quizAttemptsTable.score})::int`.as("best_score"),
    })
    .from(quizAttemptsTable)
    .groupBy(quizAttemptsTable.student_code, quizAttemptsTable.quiz_id)
    .as("best_per_quiz");

  let query = db
    .select({
      student_code: bestPerQuiz.student_code,
      student_name: sql<string>`MAX(${bestPerQuiz.student_name})`,
      total_points: sql<number>`SUM(${bestPerQuiz.best_points})::int`,
      avg_score: sql<number>`ROUND(AVG(${bestPerQuiz.best_score}))::int`,
      quizzes_taken: sql<number>`COUNT(*)::int`,
    })
    .from(bestPerQuiz)
    .groupBy(bestPerQuiz.student_code)
    .orderBy(sql`SUM(${bestPerQuiz.best_points}) DESC`)
    .limit(20)
    .$dynamic();
  if (classmateCodes && classmateCodes.length > 0) {
    query = query.where(inArray(bestPerQuiz.student_code, classmateCodes));
  }
  const rows = await query;

  res.json({
    leaderboard: rows.map((r, i) => ({
      rank: i + 1,
      student_code: r.student_code,
      student_name: r.student_name,
      total_points: r.total_points,
      avg_score: r.avg_score,
      quizzes_taken: r.quizzes_taken,
      is_me: r.student_code === studentCode,
    })),
    scope: classmateCodes && classmateCodes.length > 0 ? "class" : "global",
  });
});

export default router;
