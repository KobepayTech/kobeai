import { statSync } from "node:fs";
import type { Request, Response } from "express";
import { Router } from "express";
import { listOllamaModels, ollamaHasModel } from "../lib/ai-provider";
import { requireAuth } from "../lib/auth";
import { k9ModelPath, k9ModelsConfigPath, k9ModelStatus, loadK9Models, type K9ModelEntry } from "../lib/k9-models";
import { fetchK9RuntimeHealth, type K9RuntimeHealth } from "../lib/k9-runtime";

const router = Router();
const requireStaff = requireAuth(["admin", "super_admin"]);

type Connection = { connection: "connected" | "not_connected" | "runtime_offline"; connection_note: string };

/**
 * Whether K9 can actually use a model right now: text models through their
 * Ollama name, everything else through a K9 runtime engine.
 */
function connectionFor(name: string, entry: K9ModelEntry, runtime: K9RuntimeHealth, ollamaModels: string[]): Connection {
  if (entry.ollama) {
    return ollamaHasModel(ollamaModels, entry.ollama.name)
      ? { connection: "connected", connection_note: `Ollama model ${entry.ollama.name}` }
      : { connection: "not_connected", connection_note: "Not in Ollama yet — run `node scripts/k9-models.mjs ollama-sync`" };
  }
  const engines = Object.entries(runtime.engines).filter(([, engine]) => engine.models.includes(name));
  if (engines.length === 0) {
    return runtime.reachable
      ? { connection: "not_connected", connection_note: "Not used by the K9 runtime" }
      : { connection: "runtime_offline", connection_note: `K9 runtime not reachable at ${runtime.url}` };
  }
  const live = engines.find(([, engine]) => engine.state === "loaded" || engine.state === "available");
  if (live) return { connection: "connected", connection_note: `K9 runtime ${live[0]} (${live[1].state})` };
  const [engineName, engine] = engines[0]!;
  const reason = engine.needs_packages.length
    ? `needs ${engine.needs_packages.join(", ")}`
    : engine.state === "not_integrated"
      ? "not integrated yet"
      : engine.missing_models.length
        ? `missing ${engine.missing_models.join(", ")}`
        : (engine.error ?? engine.state);
  return { connection: "not_connected", connection_note: `K9 runtime ${engineName}: ${reason}` };
}

/**
 * GET /v1/admin/models
 * The K9 model registry (config/k9-models.json) merged with what is on disk
 * and what K9 can actually run (Ollama + the K9 model runtime). Admin-only —
 * it reveals local paths.
 */
router.get("/v1/admin/models", requireStaff, async (_req: Request, res: Response) => {
  let registry;
  try {
    registry = loadK9Models();
  } catch (err) {
    res.status(500).json({
      error: "models_registry_unreadable",
      detail: err instanceof Error ? err.message : String(err),
      manifest_path: k9ModelsConfigPath(),
    });
    return;
  }

  const [runtime, ollamaModels] = await Promise.all([fetchK9RuntimeHealth(), listOllamaModels()]);
  const { config, roots, configPath } = registry;
  const rows = Object.entries(config.models).map(([name, entry]) => {
    const modelPath = k9ModelPath(roots, entry);
    const status = k9ModelStatus(entry, modelPath);
    const source = entry.source;
    return {
      name,
      role: entry.role,
      runtime: entry.category,
      purpose: source.note ?? entry.note ?? null,
      required: entry.required,
      license: entry.license ?? "see model card",
      license_note: null,
      note: entry.gated ? "Gated on Hugging Face — accept the model terms and run `hf auth login` before downloading." : null,
      expected_size_mb: null,
      expected_sha256: null,
      url: source.repo ? `https://huggingface.co/${source.repo}` : source.url ?? null,
      kind: status === "ready" ? ("downloaded" as const) : status,
      path: modelPath,
      actual_size_mb: entry.kind === "file" && status === "ready" ? Math.round(statSync(modelPath).size / (1024 * 1024)) : undefined,
      ...(status === "ready"
        ? connectionFor(name, entry, runtime, ollamaModels)
        : { connection: "not_connected" as const, connection_note: "Not on disk yet" }),
    };
  });

  const notReady = rows.filter((r) => r.kind !== "downloaded");
  res.json({
    models_dir: roots.k9,
    base_models_dir: roots.base,
    manifest_path: configPath,
    runtime: { url: runtime.url, reachable: runtime.reachable, error: runtime.error },
    totals: {
      total: rows.length,
      downloaded: rows.length - notReady.length,
      missing: notReady.filter((r) => r.required).length,
      optional_missing: notReady.filter((r) => !r.required).length,
      partial: rows.filter((r) => r.kind === "partial").length,
      connected: rows.filter((r) => r.connection === "connected").length,
    },
    models: rows,
  });
});

export default router;
