import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { verifyToken } from "../lib/auth";

const router = Router();

// This proxies the containerised FastAPI runtime (services/k9-runtime/app.py,
// port 8091, `x-k9-secret`) used by the docker-compose school server. It has its
// own variable on purpose: K9_RUNTIME_URL means the runtime the K9 desktop app
// starts itself (services/k9-runtime/server.py on 8766, `x-k9-runtime-secret`),
// and pointing these routes at that one would proxy to endpoints it doesn't have.
const runtimeBase = (process.env["K9_FASTAPI_RUNTIME_URL"] ?? "http://127.0.0.1:8091").replace(/\/$/, "");
const runtimeSecret = process.env["K9_RUNTIME_SHARED_SECRET"] ?? process.env["K9_SHARED_SECRET"] ?? "";

function bearer(req: Request): string | null {
  const header = req.header("authorization") ?? req.header("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

function requireStaff(req: Request, res: Response, next: NextFunction): void {
  const token = bearer(req);
  const principal = token ? verifyToken(token) : null;
  if (!principal) {
    res.status(401).json({ error: "staff_auth_required" });
    return;
  }
  if (!["teacher", "admin", "super_admin"].includes(principal.role)) {
    res.status(403).json({ error: "staff_role_required" });
    return;
  }
  req.auth = principal;
  next();
}

async function runtimeJson(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const headers = new Headers(init?.headers);
  if (runtimeSecret) headers.set("x-k9-secret", runtimeSecret);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  try {
    const response = await fetch(`${runtimeBase}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return { status: response.status, body };
  } catch (error) {
    return {
      status: 503,
      body: {
        error: "k9_runtime_unavailable",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

router.use("/v1/k9-runtime", requireStaff);

router.get("/v1/k9-runtime/health", async (_req, res) => {
  const result = await runtimeJson("/health");
  res.status(result.status).json(result.body);
});

router.get("/v1/k9-runtime/models", async (_req, res) => {
  const result = await runtimeJson("/v1/models");
  res.status(result.status).json(result.body);
});

router.post("/v1/k9-runtime/models/load", async (req, res) => {
  const result = await runtimeJson("/v1/models/load", {
    method: "POST",
    body: JSON.stringify({ model: req.body?.model }),
  });
  res.status(result.status).json(result.body);
});

router.post("/v1/k9-runtime/models/unload", async (req, res) => {
  const result = await runtimeJson("/v1/models/unload", {
    method: "POST",
    body: JSON.stringify({ model: req.body?.model }),
  });
  res.status(result.status).json(result.body);
});

export default router;
