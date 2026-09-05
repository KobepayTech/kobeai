import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { verifyToken } from "../lib/auth";

const router = Router();

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireModelListAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const configuredSecret = process.env["KOBEVOICE_SHARED_SECRET"];
  const headerSecret = req.header("x-kobevoice-secret");
  const authorization =
    req.header("authorization") ?? req.header("Authorization") ?? "";
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (
    configuredSecret &&
    ((headerSecret && secureEqual(configuredSecret, headerSecret)) ||
      (bearer && secureEqual(configuredSecret, bearer)))
  ) {
    next();
    return;
  }

  if (bearer && verifyToken(bearer)) {
    next();
    return;
  }

  res.status(401).json({
    error: {
      message: "voice authentication required",
      type: "authentication_error",
    },
  });
}

router.use("/v1/voice/openai/models", requireModelListAuth);

/**
 * LiveKit's OpenAI-compatible LLM may prewarm by calling models.list().
 * Expose the one virtual model that represents KobeAI's router so that
 * prewarming succeeds without bypassing the KobeAI routing layer.
 */
router.get("/v1/voice/openai/models", (_req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: "kobeai-router",
        object: "model",
        created: 0,
        owned_by: "kobeai",
      },
    ],
  });
});

router.get("/v1/voice/openai/models/:id", (req, res) => {
  const id = req.params.id;
  if (id !== "kobeai-router") {
    res.status(404).json({
      error: {
        message: `model ${id} not found`,
        type: "invalid_request_error",
      },
    });
    return;
  }

  res.json({
    id: "kobeai-router",
    object: "model",
    created: 0,
    owned_by: "kobeai",
  });
});

export default router;
