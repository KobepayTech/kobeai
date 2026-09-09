import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Request, Response } from "express";
import { Router } from "express";
import { requireAuth } from "../lib/auth";

const router = Router();
const requireStaff = requireAuth(["admin", "super_admin"]);

// Resolve the manifest path from env, then fall back to the check-in copy at
// deploy/school-server/models.json (relative to the running api-server process).
function manifestPath(): string {
  const explicit = process.env["KOBEAI_MODELS_MANIFEST"];
  if (explicit) return resolve(explicit);
  // artifacts/api-server/dist is the runtime cwd on `pnpm run start`, so walk
  // up to the repo root before descending into deploy/.
  return resolve(process.cwd(), "..", "..", "deploy", "school-server", "models.json");
}

function modelsDir(): string {
  return process.env["KOBEAI_MODELS_DIR"] ?? "/var/lib/kobeai/models";
}

type ModelEntry = {
  role: string;
  runtime: string;
  purpose?: string;
  url?: string | null;
  url_env?: string;
  sha256?: string | null;
  size_mb?: number;
  license: string;
  license_note?: string;
  required: boolean;
  note?: string;
};

function modelFilePath(name: string, entry: ModelEntry): string | null {
  if (!entry.url) return null;
  const base = entry.url.split("/").pop() ?? "";
  const filename = base && base.length > 1 ? base : `${name}.bin`;
  return join(modelsDir(), name, filename);
}

async function localStatus(
  name: string,
  entry: ModelEntry,
): Promise<{
  kind: "algorithm-only" | "missing" | "downloaded";
  path: string | null;
  actual_size_mb?: number;
}> {
  if (!entry.url) return { kind: "algorithm-only", path: null };
  const path = modelFilePath(name, entry);
  if (!path) return { kind: "missing", path: null };
  try {
    const s = await stat(path);
    return { kind: "downloaded", path, actual_size_mb: Math.round(s.size / (1024 * 1024)) };
  } catch {
    return { kind: "missing", path };
  }
}

/**
 * GET /v1/admin/models
 * Merged view of the K9 model manifest + local disk state. Admin-only —
 * this leaks the models directory path and download URLs which we don't
 * expose to teachers.
 */
router.get("/v1/admin/models", requireStaff, async (_req: Request, res: Response) => {
  let manifest: { models: Record<string, ModelEntry> };
  try {
    const raw = await readFile(manifestPath(), "utf8");
    manifest = JSON.parse(raw);
  } catch (err) {
    res.status(500).json({
      error: "models_manifest_unreadable",
      detail: err instanceof Error ? err.message : String(err),
      manifest_path: manifestPath(),
    });
    return;
  }

  const entries = Object.entries(manifest.models ?? {});
  const rows = await Promise.all(
    entries.map(async ([name, entry]) => {
      const status = await localStatus(name, entry);
      return {
        name,
        role: entry.role,
        runtime: entry.runtime,
        purpose: entry.purpose ?? null,
        required: !!entry.required,
        license: entry.license,
        license_note: entry.license_note ?? null,
        note: entry.note ?? null,
        expected_size_mb: entry.size_mb ?? null,
        expected_sha256: entry.sha256 ?? null,
        url: entry.url ?? null,
        ...status,
      };
    }),
  );

  const totals = {
    total: rows.length,
    downloaded: rows.filter((r) => r.kind === "downloaded").length,
    missing: rows.filter((r) => r.kind === "missing" && r.required).length,
    optional_missing: rows.filter((r) => r.kind === "missing" && !r.required).length,
    algorithm_only: rows.filter((r) => r.kind === "algorithm-only").length,
  };

  res.json({
    models_dir: modelsDir(),
    manifest_path: manifestPath(),
    totals,
    models: rows,
  });
});

export default router;
