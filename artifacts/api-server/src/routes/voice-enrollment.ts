import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";
import { requireKioskOrStaff } from "./classroom";
import { claimFromVoice, decideAttribution } from "../lib/attribution";
import {
  DEFAULT_MIN_MARGIN,
  DEFAULT_MIN_SCORE,
  MIN_SAMPLES,
  enroll,
  identify,
  recordAudit,
  rosterFor,
  sweepExpired,
  type Vector,
} from "../lib/voice-identity";

// ===========================================================================
// Voice enrolment and identification.
//
// No audio passes through this file. The classroom gateway turns a recording
// into an embedding using the K9 runtime's TitaNet engine and discards the
// audio; what arrives here is a vector. That is not an efficiency — it is the
// reason a school can say it does not keep recordings of its children.
//
// Everything that touches a profile is audited, including deletions, and
// especially deletions.
// ===========================================================================

const router = Router();
const staff = requireAuth(["teacher", "admin", "super_admin"]);
const admin = requireAuth(["admin", "super_admin"]);

/** Enrolment vectors are small; a whole class of them is not. */
const MAX_DIMS = 4096;
const MAX_SAMPLES = 12;
/** A year is long enough for a school year and short enough to be a real limit. */
const DEFAULT_RETENTION_DAYS = 400;
const MAX_RETENTION_DAYS = 1100;

function vector(value: unknown, dims?: number): Vector | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DIMS)
    return null;
  if (dims !== undefined && value.length !== dims) return null;
  const out: number[] = [];
  for (const entry of value) {
    const number = Number(entry);
    if (!Number.isFinite(number)) return null;
    out.push(number);
  }
  return out;
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

/**
 * POST /v1/voice/enroll
 *
 * Consent is a required field, not a checkbox someone remembers: without
 * `consent_reference` and `consent_by` there is no request, and the database
 * column is NOT NULL behind it so no other code path can get around it.
 */
router.post("/v1/voice/enroll", staff, async (req, res) => {
  const body = req.body ?? {};
  const studentCode = str(body.student_code, 100);
  const model = str(body.model, 100);
  const modelRevision = str(body.model_revision, 100);
  const consentReference = str(body.consent_reference, 200);
  const consentBy = str(body.consent_by, 200);
  if (!studentCode || !model || !modelRevision) {
    res
      .status(400)
      .json({ error: "student_code, model and model_revision are required" });
    return;
  }
  if (!consentReference || !consentBy) {
    res.status(400).json({
      error:
        "consent_reference and consent_by are required: a child's voice is biometric data and " +
        "enrolment must record who authorised it",
    });
    return;
  }
  const rawSamples = Array.isArray(body.samples) ? body.samples : [];
  if (rawSamples.length < MIN_SAMPLES || rawSamples.length > MAX_SAMPLES) {
    res.status(400).json({
      error: `between ${MIN_SAMPLES} and ${MAX_SAMPLES} samples required`,
      why: "a profile built from one utterance matches only that distance, mood and mic position",
    });
    return;
  }
  const first = vector(rawSamples[0]?.embedding);
  if (!first) {
    res
      .status(400)
      .json({ error: "each sample needs a numeric embedding array" });
    return;
  }
  const samples: { embedding: Vector; seconds?: number; prompt?: string }[] =
    [];
  for (let i = 0; i < rawSamples.length; i += 1) {
    const embedding = vector(rawSamples[i]?.embedding, first.length);
    if (!embedding) {
      res
        .status(400)
        .json({ error: `sample ${i} has a bad or mismatched embedding` });
      return;
    }
    const seconds = Number(rawSamples[i]?.seconds);
    samples.push({
      embedding,
      ...(Number.isFinite(seconds) ? { seconds: Math.round(seconds) } : {}),
      ...(str(rawSamples[i]?.prompt, 300)
        ? { prompt: str(rawSamples[i]?.prompt, 300)! }
        : {}),
    });
  }
  const retentionDays = Math.min(
    MAX_RETENTION_DAYS,
    Math.max(
      1,
      Math.round(Number(body.retention_days) || DEFAULT_RETENTION_DAYS),
    ),
  );

  try {
    const { rows } = await pool.query(
      `SELECT u.id, cm.class_id
         FROM users u
         LEFT JOIN class_memberships cm ON cm.student_id = u.id
        WHERE u.student_code = $1
        LIMIT 1`,
      [studentCode],
    );
    if (!rows.length) {
      res.status(404).json({ error: "student not found" });
      return;
    }
    const result = await enroll({
      studentId: rows[0].id as number,
      studentCode,
      classId: (rows[0].class_id as number | null) ?? null,
      samples,
      model,
      modelRevision,
      consentReference,
      consentBy,
      enrolledBy: req.auth?.user_id ?? null,
      retentionDays,
    });
    // The lowest agreement is the one worth showing: it is the sample that
    // least resembles the others, and usually means a prompt was misread, cut
    // short, or recorded while someone else was talking.
    res.status(201).json({
      profile_id: result.profileId,
      dims: result.dims,
      sample_count: result.sampleCount,
      replaced: result.replaced,
      weakest_sample_agreement: Number(result.agreement[0]?.toFixed(4) ?? 0),
      retention_days: retentionDays,
    });
  } catch (error) {
    logger.error({ error, studentCode }, "voice enrolment failed");
    res.status(500).json({ error: "could not enrol this voice" });
  }
});

/**
 * POST /v1/voice/identify
 *
 * Returns the decision and the evidence behind it. A refusal is a normal,
 * expected answer — the caller records the utterance at class level, which
 * `POST /v1/classroom/insights` already handles — so this is a 200 with
 * `student_code: null`, not an error.
 */
router.post("/v1/voice/identify", requireKioskOrStaff, async (req, res) => {
  const body = req.body ?? {};
  const embedding = vector(body.embedding);
  const classId = Number(body.class_id);
  const model = str(body.model, 100);
  if (!embedding || !Number.isFinite(classId) || !model) {
    res
      .status(400)
      .json({ error: "embedding, class_id and model are required" });
    return;
  }
  const minScore = Number.isFinite(Number(body.min_score))
    ? Number(body.min_score)
    : DEFAULT_MIN_SCORE;
  const minMargin = Number.isFinite(Number(body.min_margin))
    ? Number(body.min_margin)
    : DEFAULT_MIN_MARGIN;
  try {
    const roster = await rosterFor(classId, model);
    const decision = identify(embedding, roster, minScore, minMargin);
    // Gate 1 says who is probably speaking. Gate 2 says what may be done about
    // it — and the caller needs both, because they are allowed to address a
    // child K9 may not write about. See lib/attribution.ts.
    const attribution = decideAttribution(
      claimFromVoice(decision, body.corroborated === true),
      { voiceAttributionMeasured: process.env["VOICE_ATTRIBUTION_MEASURED"] === "true" },
    );
    res.json({
      student_code: decision.student_code,
      accepted: decision.accepted,
      attribution: {
        outcome: attribution.outcome,
        address_as: attribution.address_as,
        attribute_to: attribution.attribute_to,
        reason: attribution.reason,
      },
      score: decision.top ? Number(decision.top.score.toFixed(4)) : null,
      margin: Number(decision.margin.toFixed(4)),
      runner_up: decision.runner_up
        ? {
            student_code: decision.runner_up.student_code,
            score: Number(decision.runner_up.score.toFixed(4)),
          }
        : null,
      roster_size: roster.size,
      thresholds: { min_score: minScore, min_margin: minMargin },
    });
  } catch (error) {
    logger.error({ error, classId }, "voice identification failed");
    res.status(500).json({ error: "could not identify this speaker" });
  }
});

/** Who is enrolled, without ever handing back the biometric vectors. */
router.get("/v1/voice/profiles", staff, async (req, res) => {
  const classId = Number(req.query["class_id"]);
  const { rows } = await pool.query(
    `SELECT p.student_code, p.class_id, p.dims, p.sample_count, p.model, p.model_revision,
            p.active, p.expires_at, p.created_at, p.updated_at, u.name
       FROM voice_profiles p
       LEFT JOIN users u ON u.id = p.student_id
      WHERE ($1::int IS NULL OR p.class_id = $1)
      ORDER BY u.name NULLS LAST, p.student_code`,
    [Number.isFinite(classId) ? classId : null],
  );
  res.json({ profiles: rows });
});

/** Switch recognition off for one child without destroying the enrolment. */
router.post(
  "/v1/voice/profiles/:student_code/active",
  staff,
  async (req, res) => {
    const studentCode = String(req.params["student_code"]);
    const active = req.body?.active !== false;
    const { rowCount } = await pool.query(
      `UPDATE voice_profiles SET active = $2, updated_at = now() WHERE student_code = $1`,
      [studentCode, active],
    );
    if (!rowCount) {
      res.status(404).json({ error: "no voice profile for this student" });
      return;
    }
    await recordAudit(
      studentCode,
      active ? "reactivated" : "deactivated",
      req.auth?.user_id ?? null,
      req.auth?.role ?? null,
      null,
    );
    res.json({ student_code: studentCode, active });
  },
);

/**
 * DELETE /v1/voice/profiles/:student_code
 *
 * A real deletion, not a flag: the centroid and every sample vector go. The
 * audit row is written first and outlives them, because "we deleted it" is the
 * entry a parent is most entitled to be able to see.
 */
router.delete("/v1/voice/profiles/:student_code", admin, async (req, res) => {
  const studentCode = String(req.params["student_code"]);
  try {
    await recordAudit(
      studentCode,
      "deleted",
      req.auth?.user_id ?? null,
      req.auth?.role ?? null,
      typeof req.body?.reason === "string"
        ? req.body.reason.slice(0, 500)
        : null,
    );
    // Sample rows cascade from the profile.
    const { rowCount } = await pool.query(
      `DELETE FROM voice_profiles WHERE student_code = $1`,
      [studentCode],
    );
    res.json({ student_code: studentCode, deleted: rowCount ?? 0 });
  } catch (error) {
    logger.error({ error, studentCode }, "voice profile deletion failed");
    res.status(500).json({ error: "could not delete this voice profile" });
  }
});

/** The answer to "what did you do with my child's voice?". */
router.get(
  "/v1/voice/profiles/:student_code/audit",
  admin,
  async (req, res) => {
    const { rows } = await pool.query(
      `SELECT action, actor_role, detail, created_at
       FROM voice_audit
      WHERE student_code = $1
      ORDER BY created_at DESC
      LIMIT 500`,
      [String(req.params["student_code"])],
    );
    res.json({ student_code: req.params["student_code"], entries: rows });
  },
);

/** Enforce retention. Safe to call repeatedly; intended for the sync timer. */
router.post("/v1/voice/retention/sweep", admin, async (_req, res) => {
  try {
    res.json({ deleted: await sweepExpired() });
  } catch (error) {
    logger.error({ error }, "voice retention sweep failed");
    res.status(500).json({ error: "retention sweep failed" });
  }
});

export default router;
