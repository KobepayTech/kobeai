import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";
import { requireKioskOrStaff } from "./classroom";
import {
  CONVERSATION_WINDOW_MS,
  MODES,
  admit,
  isForKobe,
  routeUtterance,
  stripWake,
  type Conversation,
  type Mode,
} from "../lib/classroom-agents";
import {
  MAX_SPEECH_MS,
  cardsFor,
  isRepeat,
  nextToSpeak,
  positionOf,
  staleItems,
  type QueueItem,
} from "../lib/answer-queue";

// ===========================================================================
// The classroom loop: an utterance in, a place in the queue out.
//
// The gateway on the classroom PC does VAD, diarization and transcription
// against services/k9-runtime/server.py, optionally asks
// POST /v1/voice/identify who spoke, and posts each turn here. This decides
// whether KobeAI was addressed, which subject teacher answers, and when the
// room's single loudspeaker is free to say it.
// ===========================================================================

const router = Router();
const staff = requireAuth(["teacher", "admin", "super_admin"]);

/**
 * Open conversations, in memory and per process.
 *
 * Deliberately not in Postgres. A conversation lives thirty seconds; writing it
 * to disk would cost a round trip on the hottest path in the system to protect
 * state whose correct behaviour on restart is to be forgotten. A teacher whose
 * server restarts mid-lesson says "Kobe" again, which is what they would do
 * anyway.
 */
const conversations = new Map<number, Conversation>();

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

type SessionRow = {
  id: number;
  class_id: number;
  subject: string | null;
  mode: string;
  muted_until: Date | null;
};

/** The live session for a class, started on first use. */
async function liveSession(classId: number, periodId: number | null, subject: string | null) {
  const existing = await pool.query<SessionRow>(
    `SELECT id, class_id, subject, mode, muted_until
       FROM classroom_sessions WHERE class_id = $1 AND ended_at IS NULL LIMIT 1`,
    [classId],
  );
  if (existing.rows.length) return existing.rows[0]!;
  const created = await pool.query<SessionRow>(
    `INSERT INTO classroom_sessions (class_id, period_id, subject)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING id, class_id, subject, mode, muted_until`,
    [classId, periodId, subject],
  );
  if (created.rows.length) return created.rows[0]!;
  // Lost the race with another kiosk in the same room; take theirs.
  const raced = await pool.query<SessionRow>(
    `SELECT id, class_id, subject, mode, muted_until
       FROM classroom_sessions WHERE class_id = $1 AND ended_at IS NULL LIMIT 1`,
    [classId],
  );
  return raced.rows[0] ?? null;
}

async function queueOf(sessionId: number): Promise<QueueItem[]> {
  // `served` is counted here rather than stored: it is how many of this
  // speaker's questions the loudspeaker has already delivered this session, and
  // a column holding that drifts the moment one row is updated and its siblings
  // are not. Counting it makes the round-robin impossible to get out of step.
  const { rows } = await pool.query(
    `SELECT q.id, q.speaker, q.student_code, q.subject, q.transcript, q.status,
            EXTRACT(EPOCH FROM q.created_at) * 1000 AS created_ms,
            (SELECT COUNT(*)::int
               FROM classroom_answer_queue done
              WHERE done.session_id = q.session_id
                AND done.speaker = q.speaker
                AND done.status = 'spoken') AS served
       FROM classroom_answer_queue q
      WHERE q.session_id = $1 AND q.status IN ('queued','answering')
      ORDER BY q.created_at`,
    [sessionId],
  );
  return rows.map((r) => ({
    id: r.id as number,
    speaker: r.speaker as string,
    student_code: (r.student_code as string | null) ?? null,
    subject: (r.subject as string | null) ?? null,
    transcript: r.transcript as string,
    status: r.status as string,
    served: r.served as number,
    created_at: Number(r.created_ms),
  }));
}

/**
 * POST /v1/classroom/utterance
 *
 * One diarized turn. Returns what KobeAI decided and why — including when it
 * decided to do nothing, because "not addressed" is the most common and most
 * important outcome in a room where forty children are talking.
 */
router.post("/v1/classroom/utterance", requireKioskOrStaff, async (req, res) => {
  const body = req.body ?? {};
  const classId = Number(body.class_id);
  const speaker = text(body.speaker, 100);
  const transcript = text(body.transcript, 800);
  if (!Number.isFinite(classId) || !speaker || !transcript) {
    res.status(400).json({ error: "class_id, speaker and transcript are required" });
    return;
  }
  const fromTeacher = body.from_teacher === true;
  const studentCode = text(body.student_code, 100);
  const confidence = Number.isFinite(Number(body.attribution_confidence))
    ? Math.round(Number(body.attribution_confidence))
    : null;

  try {
    const session = await liveSession(
      classId,
      Number.isFinite(Number(body.period_id)) ? Number(body.period_id) : null,
      text(body.subject, 200),
    );
    if (!session) {
      res.status(500).json({ error: "could not open a classroom session" });
      return;
    }

    const open = conversations.get(classId) ?? null;
    const invocation = isForKobe(transcript, speaker, open);
    if (!invocation.invoked) {
      // Not an error and not silence: the gateway still sends the line to
      // /v1/classroom/insights, where it becomes class-level learning evidence.
      res.json({ invoked: false, reason: invocation.reason, session_id: session.id });
      return;
    }

    const question = stripWake(transcript);
    const routing = routeUtterance({
      transcript,
      timetableSubject: session.subject,
      openConversationSubject: open?.speaker === speaker ? open.subject : null,
    });
    const mode = (MODES as readonly string[]).includes(session.mode)
      ? (session.mode as Mode)
      : "listen";
    const decision = admit({
      mode,
      fromTeacher,
      mutedUntil: session.muted_until ? session.muted_until.getTime() : null,
    });

    const queue = await queueOf(session.id);
    if (isRepeat(queue, speaker, question)) {
      res.json({
        invoked: true,
        queued: false,
        reason: "already_queued",
        session_id: session.id,
      });
      return;
    }

    // The conversation stays open on the speaker label, so a follow-up works
    // whether or not anyone was identified.
    conversations.set(classId, {
      speaker,
      subject: routing.subject,
      expiresAt: Date.now() + CONVERSATION_WINDOW_MS,
    });

    const { rows } = await pool.query(
      `INSERT INTO classroom_answer_queue
         (session_id, class_id, speaker, student_code, attribution_confidence,
          subject, routed_by, voice, transcript, answer_aloud)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        session.id,
        classId,
        speaker,
        studentCode,
        confidence,
        routing.subject,
        routing.source,
        routing.voice,
        question,
        decision.answerAloud,
      ],
    );
    const id = rows[0]!.id as number;
    res.status(201).json({
      invoked: true,
      queued: true,
      id,
      session_id: session.id,
      subject: routing.subject,
      routed_by: routing.source,
      voice: routing.voice,
      style: routing.style,
      answer_aloud: decision.answerAloud,
      mode_reason: decision.reason,
      position: positionOf([...(await queueOf(session.id))], id),
    });
  } catch (error) {
    logger.error({ error, classId }, "classroom utterance failed");
    res.status(500).json({ error: "could not handle this utterance" });
  }
});

/**
 * GET /v1/classroom/queue?class_id=
 *
 * What the TV renders and what the speaker should say next. Also sweeps items
 * that have aged out — they stop interrupting, they do not vanish from screen.
 */
router.get("/v1/classroom/queue", requireKioskOrStaff, async (req, res) => {
  const classId = Number(req.query["class_id"]);
  if (!Number.isFinite(classId)) {
    res.status(400).json({ error: "class_id required" });
    return;
  }
  try {
    const { rows: sessions } = await pool.query<SessionRow & { class_name: string | null }>(
      `SELECT s.id, s.class_id, s.subject, s.mode, s.muted_until, c.name AS class_name
         FROM classroom_sessions s
         LEFT JOIN classes c ON c.id = s.class_id
        WHERE s.class_id = $1 AND s.ended_at IS NULL LIMIT 1`,
      [classId],
    );
    const session = sessions[0];
    if (!session) {
      res.json({ session: null, cards: [], speaking: null, next: null });
      return;
    }
    const queue = await queueOf(session.id);
    const stale = staleItems(queue);
    if (stale.length) {
      await pool.query(
        `UPDATE classroom_answer_queue SET status = 'shown'
          WHERE id = ANY($1::int[]) AND status = 'queued'`,
        [stale.map((i) => i.id)],
      );
    }
    const fresh = stale.length ? await queueOf(session.id) : queue;
    const speaking = fresh.find((i) => i.status === "answering") ?? null;
    const decision = nextToSpeak(fresh, speaking);
    res.json({
      session: { id: session.id, mode: session.mode, subject: session.subject },
      cards: cardsFor(fresh, session.class_name ?? null),
      speaking: speaking?.id ?? null,
      next: decision.action === "speak" ? decision.item.id : null,
      next_reason: decision.action,
      max_speech_ms: MAX_SPEECH_MS,
    });
  } catch (error) {
    logger.error({ error, classId }, "classroom queue read failed");
    res.status(500).json({ error: "could not read the classroom queue" });
  }
});

/**
 * POST /v1/classroom/queue/:id/status
 *
 * The kiosk reports what the loudspeaker actually did. Claiming the speaker is
 * a conditional update, so two kiosks in one room cannot both start talking.
 */
router.post("/v1/classroom/queue/:id/status", requireKioskOrStaff, async (req, res) => {
  const id = Number(req.params["id"]);
  const status = text(req.body?.status, 20);
  if (!Number.isFinite(id) || !status || !["answering", "spoken", "shown"].includes(status)) {
    res.status(400).json({ error: "status must be answering, spoken or shown" });
    return;
  }
  try {
    if (status === "answering") {
      const { rowCount } = await pool.query(
        `UPDATE classroom_answer_queue SET status = 'answering'
          WHERE id = $1 AND status = 'queued'
            AND NOT EXISTS (
              SELECT 1 FROM classroom_answer_queue other
               WHERE other.session_id = classroom_answer_queue.session_id
                 AND other.status = 'answering')`,
        [id],
      );
      if (!rowCount) {
        res.status(409).json({ error: "the loudspeaker is already in use" });
        return;
      }
      res.json({ id, status });
      return;
    }
    const answer = text(req.body?.answer, 4000);
    await pool.query(
      `UPDATE classroom_answer_queue
          SET status = $2,
              spoken_at = CASE WHEN $2 = 'spoken' THEN now() ELSE spoken_at END,
              answer = COALESCE($3, answer)
        WHERE id = $1`,
      [id, status, answer],
    );
    res.json({ id, status });
  } catch (error) {
    logger.error({ error, id }, "queue status update failed");
    res.status(500).json({ error: "could not update this queue item" });
  }
});

/**
 * POST /v1/classroom/session
 * Teacher control: the mode, and mute. §9 — KobeAI never competes with them.
 */
router.post("/v1/classroom/session", staff, async (req, res) => {
  const classId = Number(req.body?.class_id);
  if (!Number.isFinite(classId)) {
    res.status(400).json({ error: "class_id required" });
    return;
  }
  const mode = text(req.body?.mode, 30);
  if (mode && !(MODES as readonly string[]).includes(mode)) {
    res.status(400).json({ error: `mode must be one of ${MODES.join(", ")}` });
    return;
  }
  const muteMinutes = Number(req.body?.mute_minutes);
  try {
    const session = await liveSession(classId, null, text(req.body?.subject, 200));
    if (!session) {
      res.status(500).json({ error: "could not open a classroom session" });
      return;
    }
    const { rows } = await pool.query(
      `UPDATE classroom_sessions
          SET mode = COALESCE($2, mode),
              muted_until = CASE
                WHEN $3::numeric IS NULL THEN muted_until
                WHEN $3 <= 0 THEN NULL
                ELSE now() + ($3 || ' minutes')::interval END
        WHERE id = $1
        RETURNING id, mode, muted_until, subject`,
      [session.id, mode, Number.isFinite(muteMinutes) ? String(muteMinutes) : null],
    );
    // A mode change ends any conversation mid-flight: a follow-up aimed at the
    // old mode should not slip through under the new one.
    conversations.delete(classId);
    res.json(rows[0]);
  } catch (error) {
    logger.error({ error, classId }, "classroom session update failed");
    res.status(500).json({ error: "could not update this classroom session" });
  }
});

export default router;
