import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth, verifyToken } from "../lib/auth";
import { logger } from "../lib/logger";
import { classSkillDemand, ingestClassroomQuestion } from "../lib/skill-engine";
import {
  IDENTITY_SOURCES,
  decideAttribution,
  type IdentitySource,
} from "../lib/attribution";

const router = Router();

/**
 * Whether this school has run measure_speaker_id.py on its own classrooms and
 * chosen to let voice alone write to a child's permanent profile.
 *
 * Off unless explicitly set. Until then a confident voice match still answers
 * the child as themselves; it just writes the evidence at class level.
 */
const VOICE_ATTRIBUTION_MEASURED =
  process.env["VOICE_ATTRIBUTION_MEASURED"] === "true";

// Ingestion is called by the classroom kiosk / voice gateway with a shared
// secret. Teachers can also read/write via a staff JWT.
const CLASSROOM_KIOSK_SECRET_ENV = "CLASSROOM_KIOSK_SECRET";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** student_code to users.id, or null — an unknown code is not an error here. */
async function studentIdFor(studentCode: string | null): Promise<number | null> {
  if (!studentCode) return null;
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE student_code = $1 LIMIT 1`,
    [studentCode],
  );
  return rows.length ? (rows[0].id as number) : null;
}

function bearer(req: Request): string | null {
  const header = req.header("authorization") ?? req.header("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

function requireKioskOrStaff(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env[CLASSROOM_KIOSK_SECRET_ENV];
  const provided = req.header("x-classroom-kiosk-secret");
  if (secret && provided && safeEqual(secret, provided)) {
    next();
    return;
  }
  const token = bearer(req);
  if (token) {
    const principal = verifyToken(token);
    if (principal && ["teacher", "admin", "super_admin"].includes(principal.role)) {
      req.auth = principal;
      next();
      return;
    }
  }
  res.status(401).json({ error: "classroom_auth_required" });
}

const requireStaff = requireAuth(["teacher", "admin", "super_admin"]);

const ALLOWED_TYPES = new Set(["question", "answer", "misunderstanding", "theme"]);

function text(value: unknown, max = 800): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function confidenceOrNull(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return Math.round(n * 100);
}

/**
 * POST /v1/classroom/insights
 * Body: {
 *   class_id?: number,
 *   subject?: string,
 *   period_id?: number,
 *   source_kiosk?: string,
 *   insights: [{
 *     insight_type: 'question' | 'answer' | 'misunderstanding' | 'theme',
 *     text: string,
 *     student_code?: string,
 *     attribution_confidence?: number (0..1)
 *   }, ...]
 * }
 *
 * Ingests a batch. class_id/subject/period_id on the envelope apply as
 * defaults to every insight in the batch that doesn't override them.
 */
router.post("/v1/classroom/insights", requireKioskOrStaff, async (req, res) => {
  const body = req.body ?? {};
  const rawInsights = Array.isArray(body.insights) ? body.insights : null;
  if (!rawInsights || rawInsights.length === 0) {
    res.status(400).json({ error: "insights array required" });
    return;
  }
  if (rawInsights.length > 100) {
    res.status(413).json({ error: "insights batch too large (max 100)" });
    return;
  }
  const envelopeClassId =
    Number.isFinite(Number(body.class_id)) ? Number(body.class_id) : null;
  const envelopeSubject = text(body.subject, 200);
  const envelopePeriodId =
    Number.isFinite(Number(body.period_id)) ? Number(body.period_id) : null;
  const kiosk = text(body.source_kiosk, 200);

  const inserted: number[] = [];
  const skipped: { index: number; reason: string }[] = [];
  const questions: {
    insightId: number;
    studentCode: string | null;
    subject: string | null;
    classId: number | null;
    periodId: number | null;
    attribution: number | null;
    text: string;
  }[] = [];
  for (let i = 0; i < rawInsights.length; i += 1) {
    const item = rawInsights[i] ?? {};
    const insightType = text(item.insight_type, 40);
    if (!insightType || !ALLOWED_TYPES.has(insightType)) {
      skipped.push({ index: i, reason: "invalid insight_type" });
      continue;
    }
    const insightText = text(item.text, 800);
    if (!insightText) {
      skipped.push({ index: i, reason: "missing or too long text" });
      continue;
    }
    const classId = Number.isFinite(Number(item.class_id))
      ? Number(item.class_id)
      : envelopeClassId;
    const subject = text(item.subject, 200) ?? envelopeSubject;
    const periodId = Number.isFinite(Number(item.period_id))
      ? Number(item.period_id)
      : envelopePeriodId;
    const rawStudentCode = text(item.student_code, 100);
    const attribution = confidenceOrNull(item.attribution_confidence);
    // Gate 2. This row is permanent learning evidence, so it takes the
    // attribution decision, not the identity one: a caller may be confident
    // enough to answer a child by name and still not confident enough to write
    // to their record. See lib/attribution.ts. An unstated source is treated as
    // a shared microphone, which is the conservative reading.
    const rawSource = text(item.identity_source, 40) ?? text(body.identity_source, 40);
    const source: IdentitySource =
      rawSource && (IDENTITY_SOURCES as readonly string[]).includes(rawSource)
        ? (rawSource as IdentitySource)
        : "voice";
    const decision = decideAttribution(
      { student_code: rawStudentCode, source, confidence: attribution },
      { voiceAttributionMeasured: VOICE_ATTRIBUTION_MEASURED },
    );
    const studentCode = decision.attribute_to;

    const result = await pool.query(
      `INSERT INTO classroom_discussion_insights (
         class_id, student_code, subject, period_id,
         insight_type, text, attribution_confidence, source_kiosk
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        classId,
        studentCode,
        subject,
        periodId,
        insightType,
        insightText,
        attribution,
        kiosk,
      ],
    );
    const insightId = Number(result.rows[0].id);
    inserted.push(insightId);
    // A question also goes onto the syllabus, so the teacher's summary can name
    // the topic the class is stuck on rather than just count questions. This
    // never reaches a mastery score — see lib/skill-engine.ts. It runs for
    // unattributed questions too: "eleven children asked about negative
    // multiplication" needs nobody to be named.
    if (insightType === "question") {
      questions.push({ insightId, studentCode, subject, classId, periodId, attribution, text: insightText });
    }
  }

  // Mapping consults the brain when keywords fail, so it runs after the
  // insights are safely stored rather than holding the kiosk's request open.
  // A question that fails to map is still recorded as an insight.
  if (questions.length > 0) {
    void Promise.all(
      questions.map(async (q) => {
        try {
          await ingestClassroomQuestion({
            studentId: await studentIdFor(q.studentCode),
            classId: q.classId,
            subject: q.subject,
            periodId: q.periodId,
            questionText: q.text,
            attributionConfidence: q.attribution,
            insightId: q.insightId,
          });
        } catch (error) {
          logger.warn({ error, insight_id: q.insightId }, "could not map classroom question to a skill");
        }
      }),
    );
  }

  if (inserted.length > 0) {
    logger.info(
      { class_id: envelopeClassId, subject: envelopeSubject, inserted: inserted.length, skipped: skipped.length },
      "classroom insights ingested",
    );
  }
  res.status(201).json({ inserted, skipped });
});

/**
 * GET /v1/staff/classroom-insights
 * Query: class_id?, subject?, student_code?, since_hours? (default 24), limit? (default 100)
 * Returns recent insights, most recent first.
 */
router.get("/v1/staff/classroom-insights", requireStaff, async (req, res) => {
  const classId = req.query["class_id"] ? Number(req.query["class_id"]) : null;
  const subject = text(req.query["subject"], 200);
  const studentCode = text(req.query["student_code"], 100);
  const sinceHours = Math.max(1, Math.min(720, Number(req.query["since_hours"] ?? 24)));
  const limit = Math.max(1, Math.min(500, Number(req.query["limit"] ?? 100)));

  const filters: string[] = [`i.captured_at >= NOW() - ($1::text || ' hours')::interval`];
  const values: unknown[] = [sinceHours];
  if (classId != null && Number.isFinite(classId)) {
    values.push(classId);
    filters.push(`i.class_id = $${values.length}`);
  }
  if (subject) {
    values.push(subject);
    filters.push(`i.subject = $${values.length}`);
  }
  if (studentCode) {
    values.push(studentCode);
    filters.push(`i.student_code = $${values.length}`);
  }
  values.push(limit);

  const rows = await pool.query(
    `SELECT i.id, i.class_id, c.name AS class_name,
            i.student_code, u.name AS student_name,
            i.subject, i.period_id, i.insight_type, i.text,
            i.attribution_confidence, i.source_kiosk, i.captured_at
     FROM classroom_discussion_insights i
     LEFT JOIN classes c ON c.id = i.class_id
     LEFT JOIN users u ON u.student_code = i.student_code
     WHERE ${filters.join(" AND ")}
     ORDER BY i.captured_at DESC
     LIMIT $${values.length}`,
    values,
  );

  res.json({ insights: rows.rows });
});

/**
 * GET /v1/staff/classroom-insights/summary
 * Returns aggregate counts by class + subject + insight_type over the
 * window — for a teacher scanning "what did today look like".
 */
router.get("/v1/staff/classroom-insights/summary", requireStaff, async (req, res) => {
  const sinceHours = Math.max(1, Math.min(720, Number(req.query["since_hours"] ?? 24)));
  const rows = await pool.query(
    `SELECT c.name AS class_name, i.subject, i.insight_type,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE i.student_code IS NOT NULL)::int AS student_attributed
     FROM classroom_discussion_insights i
     LEFT JOIN classes c ON c.id = i.class_id
     WHERE i.captured_at >= NOW() - ($1::text || ' hours')::interval
     GROUP BY c.name, i.subject, i.insight_type
     ORDER BY total DESC
     LIMIT 200`,
    [sinceHours],
  );
  res.json({ rows: rows.rows });
});

/**
 * GET /v1/staff/classroom-insights/demand
 * Query: class_id (required), since_days? (default 7), limit? (default 10)
 *
 * What the class asked about, placed on the syllabus. This is the end-of-lesson
 * line a teacher can act on — "11 students asked about negative multiplication"
 * — and it works whether or not any of them were identified, because the count
 * that matters is how many different children, not who.
 */
router.get("/v1/staff/classroom-insights/demand", requireStaff, async (req, res) => {
  const classId = Number(req.query["class_id"]);
  if (!Number.isFinite(classId)) {
    res.status(400).json({ error: "class_id required" });
    return;
  }
  const sinceDays = Math.min(90, Math.max(1, Number(req.query["since_days"]) || 7));
  const limit = Math.min(50, Math.max(1, Number(req.query["limit"]) || 10));
  try {
    res.json({
      class_id: classId,
      since_days: sinceDays,
      demand: await classSkillDemand(classId, sinceDays, limit),
    });
  } catch (error) {
    logger.error({ error, class_id: classId }, "classroom demand query failed");
    res.status(500).json({ error: "could not read classroom demand" });
  }
});

export default router;
