import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { requireAuth, verifyToken } from "../lib/auth";
import { faceGallery } from "../lib/face-gallery";
import { logger } from "../lib/logger";
import {
  claimVisionRequests,
  completeVisionRequest,
  enqueueVisionAnalysis,
  ensureVisionQueueTables,
  listVisionRequests,
} from "../lib/vision-queue";
import { onLensRequestCompleted } from "./teacher-lens";

const router = Router();

const requireStaff = requireAuth(["teacher", "admin", "super_admin"]);

// Worker auth: shared secret in x-kobevision-secret (reused from the
// existing presence path — the Youtu-VL worker is expected to run
// alongside KobeVision on the on-prem GPU box). Staff JWTs also work so
// operators can inspect / drain the queue from the dashboard.
function requireWorkerOrStaff(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env["KOBEVISION_SHARED_SECRET"];
  const provided = req.header("x-kobevision-secret");
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
  res.status(401).json({ error: "vision_worker_auth_required" });
}

function cleanText(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

/**
 * POST /v1/vision/analyze
 * Enqueue a Youtu-VL / Qwen scene-analysis request. Staff-auth only. Body:
 *   { question, camera_id?, student_code?, reason?, context?, priority? }
 */
router.post("/v1/vision/analyze", requireStaff, async (req, res) => {
  await ensureVisionQueueTables();
  const question = cleanText(req.body?.question, 500);
  if (!question) {
    res.status(400).json({ error: "question required (<=500 chars)" });
    return;
  }
  try {
    const request = await enqueueVisionAnalysis({
      question,
      cameraId: cleanText(req.body?.camera_id, 160),
      studentCode: cleanText(req.body?.student_code, 100),
      reason: cleanText(req.body?.reason, 500),
      context: req.body?.context && typeof req.body.context === "object" ? req.body.context : {},
      requestedBy: req.auth?.user_id ?? null,
      priority: Number(req.body?.priority ?? 5),
    });
    res.status(201).json({ request });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /v1/vision/analyze/pending
 * Worker inbox: claim up to N pending requests, flipping them to
 * in_progress atomically. Two workers polling in parallel won't both
 * claim the same row.
 * Query: worker=<id> limit=<n>
 */
router.get("/v1/vision/analyze/pending", requireWorkerOrStaff, async (req, res) => {
  const worker = cleanText(req.query["worker"], 100) ?? "anonymous-worker";
  const limit = Math.max(1, Math.min(50, Number(req.query["limit"] ?? 5)));
  const claimed = await claimVisionRequests(worker, limit);
  res.json({ requests: claimed });
});

/**
 * POST /v1/vision/analyze/:id/complete
 * Worker posts its answer back. Body: { ok: bool, response: {...} }
 */
router.post("/v1/vision/analyze/:id/complete", requireWorkerOrStaff, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const ok = req.body?.ok !== false;
  const response =
    req.body?.response && typeof req.body.response === "object"
      ? (req.body.response as Record<string, unknown>)
      : {};
  const worker = cleanText(req.body?.worker, 100);
  const updated = await completeVisionRequest(id, { ok, response, worker });
  if (!updated) {
    res.status(404).json({ error: "vision_request_not_found" });
    return;
  }
  res.json({ request: updated });
  // Teacher Lens requests are spoken back through the teacher's earbud.
  if (updated.reason?.startsWith("lens:")) {
    onLensRequestCompleted(updated).catch((err) =>
      logger.warn({ err: err instanceof Error ? err.message : String(err), id }, "lens result whisper failed"),
    );
  }
});

/**
 * GET /v1/vision/face-gallery
 * Enrolled student faces (SFace embeddings) for the K9 worker's matcher.
 */
router.get("/v1/vision/face-gallery", requireWorkerOrStaff, async (_req, res) => {
  res.json({ students: await faceGallery() });
});

/**
 * GET /v1/vision/analyze
 * Staff inspection surface. Filters: ?status=&student_code=&camera_id=&limit=
 */
router.get("/v1/vision/analyze", requireStaff, async (req, res) => {
  const requests = await listVisionRequests({
    status: cleanText(req.query["status"], 40) ?? undefined,
    studentCode: cleanText(req.query["student_code"], 100),
    cameraId: cleanText(req.query["camera_id"], 160),
    limit: Number(req.query["limit"] ?? 100),
  });
  res.json({ requests });
});

export default router;
