import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import { db, parentChildrenTable, subscriptionCacheTable, usersTable } from "@workspace/db";
import { pool } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { askAI } from "../lib/ai-provider";

const router = Router();
let tablesReady: Promise<void> | null = null;
async function ensureMiniK9Tables() {
  if (!tablesReady) tablesReady = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS school_calendar_events (
        id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT,
        event_type TEXT NOT NULL DEFAULT 'school', starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ, location TEXT, audience TEXT NOT NULL DEFAULT 'all',
        student_code TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS school_calendar_events_start_idx ON school_calendar_events(starts_at);
      CREATE INDEX IF NOT EXISTS school_calendar_events_student_idx ON school_calendar_events(student_code, starts_at);
      CREATE TABLE IF NOT EXISTS parent_ai_call_requests (
        id BIGSERIAL PRIMARY KEY, parent_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        student_code TEXT, phone TEXT NOT NULL, reason TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'queued', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        scheduled_for TIMESTAMPTZ, completed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS parent_ai_call_requests_parent_idx ON parent_ai_call_requests(parent_user_id, created_at DESC);
    `);
  })();
  await tablesReady;
}

async function ownedStudentCodes(parentId: number) {
  const rows = await db.select({ code: usersTable.student_code })
    .from(parentChildrenTable).innerJoin(usersTable, eq(usersTable.id, parentChildrenTable.student_user_id))
    .where(eq(parentChildrenTable.parent_user_id, parentId));
  return rows.map(r => r.code).filter((v): v is string => !!v);
}
async function childContext(parentId: number) {
  const codes = await ownedStudentCodes(parentId);
  if (!codes.length) return [];
  return db.select({
    student_code: subscriptionCacheTable.student_code, student_name: subscriptionCacheTable.student_name,
    plan: subscriptionCacheTable.plan, status: subscriptionCacheTable.status, expires_at: subscriptionCacheTable.expires_at,
  }).from(subscriptionCacheTable).where(inArray(subscriptionCacheTable.student_code, codes));
}

router.get("/v1/parent/k9/overview", requireAuth(["parent"]), async (req, res) => {
  await ensureMiniK9Tables();
  const parentId = Number(req.auth?.user_id);
  if (!parentId) return res.status(401).json({ error: "no parent in token" });
  const children = await childContext(parentId);
  const result = await pool.query(
    `SELECT id,title,description,event_type,starts_at,ends_at,location,audience,student_code
     FROM school_calendar_events WHERE starts_at >= now()
     AND (audience='all' OR audience='boarding' OR student_code = ANY($1::text[]))
     ORDER BY starts_at ASC LIMIT 20`, [children.map(c => c.student_code)]);
  res.json({ assistant_name: "Mini K9", children, upcoming: result.rows, boarding_mode: true,
    capabilities: ["school_calendar","smart_notifications","learning_summary","parent_questions","revision_recommendations","optional_ai_calls"] });
});

router.get("/v1/parent/k9/calendar", requireAuth(["parent"]), async (req, res) => {
  await ensureMiniK9Tables();
  const parentId = Number(req.auth?.user_id);
  if (!parentId) return res.status(401).json({ error: "no parent in token" });
  const codes = await ownedStudentCodes(parentId);
  const result = await pool.query(
    `SELECT id,title,description,event_type,starts_at,ends_at,location,audience,student_code
     FROM school_calendar_events WHERE starts_at >= now()
     AND (audience='all' OR audience='boarding' OR student_code = ANY($1::text[]))
     ORDER BY starts_at ASC LIMIT 100`, [codes]);
  res.json({ events: result.rows });
});

router.post("/v1/parent/k9/chat", requireAuth(["parent"]), async (req, res) => {
  const parentId = Number(req.auth?.user_id);
  if (!parentId) return res.status(401).json({ error: "no parent in token" });
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message || message.length > 1000) return res.status(400).json({ error: "message required (max 1000 characters)" });
  const children = await childContext(parentId);
  const calendar = await pool.query(
    `SELECT title,event_type,starts_at,ends_at,location,student_code FROM school_calendar_events
     WHERE starts_at >= now() - interval '7 days' AND (audience='all' OR audience='boarding' OR student_code = ANY($1::text[]))
     ORDER BY starts_at ASC LIMIT 30`, [children.map(c => c.student_code)]);
  const system = "You are Mini K9, the parent-facing assistant for a Tanzanian boarding school. " +
    "Help parents understand school schedules and their child's learning. Use only supplied school context for school-specific facts. " +
    "Do not invent attendance, grades, incidents, medical information, discipline, or safety events. If context lacks an answer, tell the parent to contact the school. " +
    "Be concise, warm, and use English or Swahili matching the parent. Context: " + JSON.stringify({ children, calendar: calendar.rows });
  const result = await askAI(message, system);
  res.json({ answer: result.answer, model: result.model, provider: result.provider });
});

router.post("/v1/parent/k9/call", requireAuth(["parent"]), async (req, res) => {
  await ensureMiniK9Tables();
  const parentId = Number(req.auth?.user_id);
  if (!parentId) return res.status(401).json({ error: "no parent in token" });
  const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const studentCode = typeof req.body?.student_code === "string" ? req.body.student_code.trim() : null;
  if (!phone || !reason) return res.status(400).json({ error: "phone and reason are required" });
  const children = await childContext(parentId);
  const selected = studentCode ? children.find(c => c.student_code === studentCode) : children[0];
  if (studentCode && !selected) return res.status(403).json({ error: "child is not linked to this parent" });
  if (!selected || selected.plan !== "premium" || !["active","trial","grace"].includes(selected.status))
    return res.status(402).json({ error: "AI voice calls require an active K9 Premium subscription" });
  const inserted = await pool.query(
    `INSERT INTO parent_ai_call_requests (parent_user_id,student_code,phone,reason,payload)
     VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id,status,created_at`,
    [parentId, selected.student_code, phone, reason, JSON.stringify({ source: "mini-k9", requested_by: "parent" })]);
  res.status(202).json({ ok: true, call: inserted.rows[0],
    message: "Mini K9 call request queued. Phone delivery requires the configured KobeVoice telephony gateway." });
});

// School staff publish events. Parents only read events through the routes above.
router.post("/v1/parent/k9/calendar", requireAuth(["teacher","admin","super_admin"]), async (req, res) => {
  await ensureMiniK9Tables();
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const startsAt = typeof req.body?.starts_at === "string" ? req.body.starts_at : "";
  if (!title || !startsAt) return res.status(400).json({ error: "title and starts_at are required" });
  const result = await pool.query(
    `INSERT INTO school_calendar_events
      (title,description,event_type,starts_at,ends_at,location,audience,student_code,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [title, typeof req.body?.description === "string" ? req.body.description : null,
      typeof req.body?.event_type === "string" ? req.body.event_type : "school", startsAt,
      typeof req.body?.ends_at === "string" ? req.body.ends_at : null,
      typeof req.body?.location === "string" ? req.body.location : null,
      typeof req.body?.audience === "string" ? req.body.audience : "all",
      typeof req.body?.student_code === "string" ? req.body.student_code : null, Number(req.auth?.user_id) || null]);
  res.status(201).json({ event: result.rows[0] });
});
export default router;
