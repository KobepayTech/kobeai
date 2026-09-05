import { randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { askAI, getAiHealth } from "../lib/ai-provider";
import { verifyToken, type Principal } from "../lib/auth";
import { logger } from "../lib/logger";
import { rateLimit } from "../lib/rate-limit";
import { recordAiQuery } from "../lib/usage-counter";

const router = Router();

const SESSION_TTL_MS = Math.max(
  5 * 60_000,
  Number(process.env["VOICE_SESSION_TTL_MS"] ?? 2 * 60 * 60_000),
);

const ALLOWED_CHANNELS = new Set([
  "watch",
  "classroom",
  "phone",
  "reception",
  "teacher",
  "browser",
]);

const DIRECT_USER_ROLES = new Set<Principal["role"]>([
  "student",
  "teacher",
  "admin",
  "parent",
  "super_admin",
]);

type VoiceChannel =
  | "watch"
  | "classroom"
  | "phone"
  | "reception"
  | "teacher"
  | "browser";

type ToolResultEvent = {
  at: string;
  tool_name: string;
  success: boolean;
  summary: string | null;
};

type VoiceSession = {
  id: string;
  channel: VoiceChannel;
  tenant_id: string | null;
  language: string;
  actor_user_id: number | null;
  actor_role: Principal["role"] | null;
  student_code: string | null;
  class_id: string | null;
  room_id: string | null;
  created_at: string;
  last_activity_at: string;
  expires_at: number;
  ended_at: string | null;
  turn_count: number;
  tool_results: ToolResultEvent[];
};

const sessions = new Map<string, VoiceSession>();
let sessionWrites = 0;

function safeText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function optionalText(value: unknown, max: number): string | null {
  if (value == null || value === "") return null;
  return safeText(value, max);
}

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerPrincipal(req: Request): Principal | null {
  const header = req.header("authorization") ?? req.header("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  return verifyToken(header.slice(7).trim());
}

/**
 * Voice requests can be authenticated in either of two ways:
 *
 * 1. KobeVoice service-to-service calls use x-kobevoice-secret. An optional
 *    bearer token may also be forwarded so the session carries the real user.
 * 2. First-party KobeAI clients may call the gateway directly with a normal
 *    KobeAI bearer token.
 *
 * The shared secret is never given to watches, browsers, students or parents.
 */
function requireVoiceAuth(req: Request, res: Response, next: NextFunction): void {
  const configuredSecret = process.env["KOBEVOICE_SHARED_SECRET"];
  const suppliedSecret = req.header("x-kobevoice-secret");
  const principal = bearerPrincipal(req);

  if (
    configuredSecret &&
    suppliedSecret &&
    secureEqual(configuredSecret, suppliedSecret)
  ) {
    if (principal) req.auth = principal;
    next();
    return;
  }

  if (principal && DIRECT_USER_ROLES.has(principal.role)) {
    req.auth = principal;
    next();
    return;
  }

  res.status(401).json({
    error: "voice_auth_required",
    message:
      "Use a KobeAI bearer token or the configured x-kobevoice-secret service credential.",
  });
}

function touch(session: VoiceSession): void {
  session.last_activity_at = new Date().toISOString();
  session.expires_at = Date.now() + SESSION_TTL_MS;
}

function sweepSessions(now = Date.now()): void {
  for (const [id, session] of sessions) {
    if (session.expires_at <= now || session.ended_at) sessions.delete(id);
  }
}

function loadSession(req: Request, res: Response): VoiceSession | null {
  const id =
    optionalText(req.body?.session_id, 100) ??
    optionalText(req.params?.id, 100);
  if (!id) {
    res.status(400).json({ error: "session_id_required" });
    return null;
  }

  const session = sessions.get(id);
  if (!session || session.expires_at <= Date.now() || session.ended_at) {
    if (session) sessions.delete(id);
    res.status(404).json({ error: "voice_session_not_found" });
    return null;
  }
  return session;
}

function channelSystemPrompt(session: VoiceSession): string {
  const languageRule =
    session.language.toLowerCase().startsWith("sw")
      ? "Reply in natural Kiswahili unless the speaker clearly switches language."
      : "Reply in the same language as the speaker; support English and Kiswahili naturally.";

  const channelRule: Record<VoiceChannel, string> = {
    watch:
      "You are speaking to a student through a watch or earbuds. Keep the reply short, clear, age-appropriate and easy to understand when spoken aloud.",
    classroom:
      "You are assisting a classroom. Address the class clearly, avoid assuming which student spoke unless identity was explicitly supplied, and keep spoken answers concise.",
    phone:
      "You are speaking on a phone call. Use short conversational sentences and never claim a school record was changed unless a connected tool confirms it.",
    reception:
      "You are assisting school reception. Be concise, do not invent school-specific facts, and offer human transfer when the request requires staff judgment or data you do not have.",
    teacher:
      "You are assisting an authenticated teacher. You may help plan or explain actions, but never claim attendance, grades, payments, messages or records were changed unless a connected tool confirms success.",
    browser:
      "You are a spoken KobeAI assistant in a first-party browser client. Keep responses concise and suitable for text-to-speech.",
  };

  return [
    "You are KobeAI, the school AI assistant for Tanzanian schools.",
    channelRule[session.channel],
    languageRule,
    "Do not invent private student, parent, payment, attendance, grade, timetable or school-record facts.",
    "If a request needs an external action or protected record, say what needs to be done and wait for the connected KobeAI tool layer to confirm it.",
    "Never reveal infrastructure secrets, service credentials or another user's private information.",
    "Prefer answers that can be comfortably spoken aloud in under about 30 seconds unless more detail is requested.",
  ].join(" ");
}

function requiresHumanApproval(transcript: string): boolean {
  return /\b(delete|remove account|expel|suspend|disciplin|pay|payment|refund|transfer money|publish|send to everyone|broadcast|change grade|edit grade|medical|emergency)\b/i.test(
    transcript,
  );
}

function requestsHumanTransfer(transcript: string): boolean {
  return /\b(speak|talk|connect|transfer)\b.{0,24}\b(human|person|staff|teacher|administrator|receptionist|agent)\b/i.test(
    transcript,
  );
}

const voiceTurnLimiter = rateLimit({
  windowMs: 60_000,
  max: Math.max(1, Number(process.env["VOICE_MAX_TURNS_PER_MINUTE"] ?? 60)),
  name: "voice-turn",
  keyGenerator: (req) =>
    safeText(req.body?.session_id, 100) ?? req.ip ?? "unknown",
});

router.use("/v1/voice", requireVoiceAuth);

/**
 * POST /v1/voice/session
 * Start a short-lived voice session. The session deliberately stores only
 * routing/context metadata; raw audio is not accepted or retained here.
 */
router.post("/v1/voice/session", (req, res) => {
  const rawChannel = safeText(req.body?.channel, 32)?.toLowerCase();
  if (!rawChannel || !ALLOWED_CHANNELS.has(rawChannel)) {
    res.status(400).json({
      error: "invalid_channel",
      allowed: [...ALLOWED_CHANNELS],
    });
    return;
  }

  const principal = req.auth ?? null;
  const now = new Date();
  const id = `voice_${randomUUID()}`;
  const requestedStudentCode = optionalText(req.body?.student_code, 100);

  const session: VoiceSession = {
    id,
    channel: rawChannel as VoiceChannel,
    tenant_id: optionalText(req.body?.tenant_id, 100),
    language: optionalText(req.body?.language, 16) ?? "auto",
    actor_user_id: principal?.user_id ?? null,
    actor_role: principal?.role ?? null,
    student_code:
      principal?.role === "student"
        ? principal.student_id ?? null
        : requestedStudentCode,
    class_id: optionalText(req.body?.class_id, 100),
    room_id: optionalText(req.body?.room_id, 100),
    created_at: now.toISOString(),
    last_activity_at: now.toISOString(),
    expires_at: now.getTime() + SESSION_TTL_MS,
    ended_at: null,
    turn_count: 0,
    tool_results: [],
  };

  sessions.set(id, session);
  sessionWrites += 1;
  if (sessionWrites % 256 === 0) sweepSessions();

  res.status(201).json({
    session_id: session.id,
    channel: session.channel,
    language: session.language,
    expires_at: new Date(session.expires_at).toISOString(),
  });
});

/**
 * POST /v1/voice/turn
 * KobeVoice sends the STT transcript here. KobeAI remains the reasoning/router
 * authority; this endpoint intentionally accepts text, not audio.
 */
router.post("/v1/voice/turn", voiceTurnLimiter, async (req, res) => {
  const session = loadSession(req, res);
  if (!session) return;

  const transcript = safeText(req.body?.transcript, 4_000);
  if (!transcript) {
    res.status(400).json({ error: "valid_transcript_required" });
    return;
  }

  const requestedLanguage = optionalText(req.body?.language, 16);
  if (requestedLanguage) session.language = requestedLanguage;
  touch(session);

  const traceId = optionalText(req.body?.trace_id, 120) ?? `trace_${randomUUID()}`;
  const startedAt = Date.now();

  try {
    recordAiQuery();
    const result = await askAI(transcript, channelSystemPrompt(session));
    session.turn_count += 1;
    touch(session);

    const approvalRequired = requiresHumanApproval(transcript);
    const transferRequested = requestsHumanTransfer(transcript);

    res.json({
      session_id: session.id,
      trace_id: traceId,
      answer: result.answer,
      language: session.language,
      action: null,
      requires_human_approval: approvalRequired,
      transfer_to_human: transferRequested,
      model: result.model,
      provider: result.provider,
      latency_ms: Date.now() - startedAt,
    });
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        session_id: session.id,
        trace_id: traceId,
      },
      "voice turn failed",
    );
    res.status(502).json({
      error: "voice_ai_failed",
      session_id: session.id,
      trace_id: traceId,
    });
  }
});

/**
 * POST /v1/voice/tool-result
 * Tool execution remains outside the voice transport. The orchestrator can
 * report a scoped result here so the voice session has a minimal audit trail.
 */
router.post("/v1/voice/tool-result", (req, res) => {
  const session = loadSession(req, res);
  if (!session) return;

  const toolName = safeText(req.body?.tool_name, 120);
  if (!toolName || typeof req.body?.success !== "boolean") {
    res.status(400).json({ error: "tool_name_and_success_required" });
    return;
  }

  const event: ToolResultEvent = {
    at: new Date().toISOString(),
    tool_name: toolName,
    success: req.body.success,
    summary: optionalText(req.body?.summary, 1_000),
  };
  session.tool_results.push(event);
  if (session.tool_results.length > 20) session.tool_results.shift();
  touch(session);

  logger.info(
    {
      session_id: session.id,
      tool_name: event.tool_name,
      success: event.success,
    },
    "voice tool result",
  );

  res.json({ accepted: true, session_id: session.id });
});

/** POST /v1/voice/session/:id/end */
router.post("/v1/voice/session/:id/end", (req, res) => {
  const session = loadSession(req, res);
  if (!session) return;

  session.ended_at = new Date().toISOString();
  const summary = {
    session_id: session.id,
    ended_at: session.ended_at,
    turn_count: session.turn_count,
    tool_result_count: session.tool_results.length,
  };
  sessions.delete(session.id);
  res.json(summary);
});

/**
 * GET /v1/voice/health
 * Authenticated operational status for KobeVoice/admin diagnostics.
 */
router.get("/v1/voice/health", async (_req, res) => {
  sweepSessions();
  const ai = await getAiHealth();
  res.json({
    ok: true,
    active_voice_sessions: sessions.size,
    session_ttl_ms: SESSION_TTL_MS,
    ai,
  });
});

export default router;
