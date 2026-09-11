import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { pool } from "@workspace/db";
import { verifyToken } from "../lib/auth";
import { askAI } from "../lib/ai-provider";
import { rateLimit } from "../lib/rate-limit";

const router = Router();

// The classroom kiosk authenticates with the same shared secret used for
// birthday-celebration claims. Staff JWT works too so an admin browser can
// hit the same endpoints for testing.
function requireKioskOrStaff(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env["CLASSROOM_KIOSK_SECRET"];
  const provided = req.header("x-classroom-kiosk-secret");
  if (secret && provided) {
    const a = Buffer.from(secret);
    const b = Buffer.from(provided);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      next();
      return;
    }
  }
  const header = req.header("authorization") ?? req.header("Authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) {
    const principal = verifyToken(header.slice(7).trim());
    if (principal && ["teacher", "admin", "super_admin"].includes(principal.role)) {
      req.auth = principal;
      next();
      return;
    }
  }
  res.status(401).json({ error: "classroom_auth_required" });
}

function text(value: unknown, max = 800): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

const askLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  name: "classroom-ask",
  keyGenerator: (req) =>
    (req.header("x-classroom-kiosk-id") ?? req.ip ?? "unknown-kiosk").toString(),
});

/**
 * POST /v1/classroom/ask
 * Teacher-triggered AI question from the classroom kiosk. Body:
 *   { question: string, subject?: string, class_id?: number, kiosk_id?: string }
 * The rate-limit key is the kiosk id so one classroom can't exhaust the
 * whole school's AI budget.
 */
router.post("/v1/classroom/ask", askLimiter, requireKioskOrStaff, async (req, res) => {
  const question = text(req.body?.question, 800);
  if (!question) {
    res.status(400).json({ error: "question required (<=800 chars)" });
    return;
  }
  const subject = text(req.body?.subject, 200);
  const systemOverride = subject
    ? `You are KobeAI, a friendly tutor for Tanzanian school students. The current lesson is ${subject}. Keep answers under 120 words, use Tanzanian examples where relevant.`
    : undefined;
  const result = await askAI(question, systemOverride);
  res.json(result);
});

/**
 * GET /v1/classroom/context
 * The kiosk asks "what's happening right now?" and gets back a rendered
 * summary it can display. Uses whatever timetable / presence data is
 * available; degrades gracefully when tables are empty.
 * Query: kiosk_id (optional — a future room-mapping lets us pick the
 * class this TV belongs to; today it's a hint used for logging).
 */
router.get("/v1/classroom/context", requireKioskOrStaff, async (req, res) => {
  const kioskId = text(req.query["kiosk_id"], 100) ?? text(req.header("x-classroom-kiosk-id"), 100);
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

  // Best-effort: the timetable route already has its own filters — hit it
  // directly against pooled sql to avoid a cyclic import.
  let periods: Array<{
    period_id: number;
    class_id: number | null;
    class_name: string | null;
    subject: string;
    room: string | null;
    start_minute: number;
    end_minute: number;
  }> = [];
  try {
    const rows = await pool.query(
      `SELECT tp.id AS period_id, tp.class_id, c.name AS class_name,
              tp.subject, tp.room, tp.start_minute, tp.end_minute
       FROM timetable_periods tp
       LEFT JOIN classes c ON c.id = tp.class_id
       WHERE tp.day_of_week = EXTRACT(ISODOW FROM NOW())::int
       ORDER BY tp.start_minute
       LIMIT 20`,
    );
    periods = rows.rows;
  } catch {
    // No timetable table yet — return empty context, not an error.
  }

  const current = periods.find(
    (p) => p.start_minute <= nowMinutes && p.end_minute > nowMinutes,
  );
  const upcoming = periods.filter((p) => p.start_minute > nowMinutes).slice(0, 6);

  res.json({
    kiosk_id: kioskId,
    now_minute: nowMinutes,
    current_period: current ?? null,
    upcoming_periods: upcoming,
  });
});

/**
 * GET /v1/classroom/live/mismatches
 * Kiosk-friendly alias of /v1/presence/live/mismatches — same shape, but
 * authenticated via CLASSROOM_KIOSK_SECRET so the TV client doesn't need
 * a staff JWT. Deliberately mirrors, not delegates, so we don't leak the
 * full staff surface to a kiosk credential.
 */
router.get("/v1/classroom/live/mismatches", requireKioskOrStaff, async (req, res) => {
  const since = Math.max(1, Math.min(720, Number(req.query["since_minutes"] ?? 30)));
  try {
    const rows = await pool.query(
      `SELECT p.student_code, u.name AS student_name,
              p.zone_name, p.zone_type,
              ez.name AS expected_zone_name, p.expected_zone_type,
              p.mismatch_status, p.seen_at
       FROM current_student_presence p
       LEFT JOIN users u ON u.student_code = p.student_code
       LEFT JOIN campus_zones ez ON ez.id = p.expected_zone_id
       WHERE p.seen_at >= NOW() - ($1::text || ' minutes')::interval
         AND p.mismatch_status IN ('wrong_location', 'configuration_missing')
       ORDER BY p.seen_at DESC
       LIMIT 20`,
      [since],
    );
    res.json({ mismatches: rows.rows, since_minutes: since });
  } catch {
    // current_student_presence not initialised yet on a brand-new deploy —
    // return an empty list rather than 500 so the kiosk keeps rendering.
    res.json({ mismatches: [], since_minutes: since });
  }
});

export default router;
