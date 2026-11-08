import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Resolves K9 model locations from the registry at config/k9-models.json —
// the api-server counterpart of scripts/k9-models.mjs. Never hard-code model
// paths in routes or workers; read them through here.

export type K9ModelKind = "file" | "dir" | "repo" | "files";
export type K9ModelStatus = "ready" | "partial" | "missing";
export type K9RootName = "base" | "k9";

export type K9ModelEntry = {
  category: string;
  role: string;
  root?: K9RootName;
  path: string;
  kind: K9ModelKind;
  required: boolean;
  files?: string[];
  expect?: string[];
  gated?: boolean;
  license?: string;
  note?: string;
  source: { type: string; repo?: string; url?: string; id?: string; from?: string; note?: string };
  ollama?: { name: string; quantize?: string; parameters?: Record<string, unknown> };
};

export type K9ModelsConfig = {
  version: number;
  roots: Record<K9RootName, { path: string; env?: string }>;
  runtime?: {
    ollama?: {
      text_model?: string;
      text_fallbacks?: string[];
      vision_model?: string;
      vision_fallbacks?: string[];
    };
    k9_runtime?: { host?: string; port?: number };
    python?: { executable?: string; env?: string };
  };
  models: Record<string, K9ModelEntry>;
};

function ollamaNames(config: K9ModelsConfig, ids: (string | undefined)[]): string[] {
  const names = ids
    .filter((id): id is string => !!id)
    .map((id) => config.models[id]?.ollama?.name)
    .filter((name): name is string => !!name);
  return [...new Set(names)];
}

/** Ollama model names for K9's text brain: the registry default first, then its fallbacks. */
export function k9TextModelNames(config: K9ModelsConfig): string[] {
  const runtime = config.runtime?.ollama;
  return ollamaNames(config, [runtime?.text_model, ...(runtime?.text_fallbacks ?? [])]);
}

/**
 * Ollama model names that can read an image — the paper reader and any image
 * question use these. Empty on a school whose registry declares no vision
 * model; callers fall back to a manual path rather than guessing.
 */
export function k9VisionModelNames(config: K9ModelsConfig): string[] {
  const runtime = config.runtime?.ollama;
  return ollamaNames(config, [runtime?.vision_model, ...(runtime?.vision_fallbacks ?? [])]);
}

export type K9ModelRegistry = {
  config: K9ModelsConfig;
  roots: Record<K9RootName, string>;
  configPath: string;
};

const COMPLETE_MARKER = ".k9_complete";

export function k9ModelsConfigPath(): string {
  const explicit = process.env["K9_MODELS_CONFIG"];
  if (explicit) return path.resolve(explicit);
  // `pnpm run start` runs from artifacts/api-server, two levels below the repo root.
  return path.resolve(process.cwd(), "..", "..", "config", "k9-models.json");
}

export function loadK9Models(configPath = k9ModelsConfigPath()): K9ModelRegistry {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as K9ModelsConfig;
  const resolveRoot = (root: { path: string; env?: string }) =>
    path.resolve((root.env && process.env[root.env]) || root.path);
  return {
    config,
    roots: { base: resolveRoot(config.roots.base), k9: resolveRoot(config.roots.k9) },
    configPath,
  };
}

export function k9ModelPath(roots: Record<K9RootName, string>, entry: K9ModelEntry): string {
  return path.join(roots[entry.root ?? "k9"], ...entry.path.split("/"));
}

function matchesPattern(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

export function k9ModelStatus(entry: K9ModelEntry, absPath: string): K9ModelStatus {
  if (!existsSync(absPath)) return "missing";
  switch (entry.kind) {
    case "file":
      return statSync(absPath).size > 0 ? "ready" : "partial";
    case "repo":
      return existsSync(path.join(absPath, ".git")) ? "ready" : "partial";
    case "files":
      return (entry.files ?? []).every((file) => existsSync(path.join(absPath, ...file.split("/"))))
        ? "ready"
        : "partial";
    default: {
      const names = readdirSync(absPath);
      const expected = (entry.expect ?? []).every((pattern) => names.some((name) => matchesPattern(name, pattern)));
      // Folders downloaded outside the K9 downloader have no completion marker:
      // they count once the expected files exist and nothing is still downloading.
      // A sharded safetensors model with every indexed shard on disk is complete
      // even if an earlier failed attempt left .incomplete pieces behind.
      if (entry.source.type === "external") {
        const settled = safetensorsIndexComplete(absPath) ?? !hasIncompleteDownloads(absPath);
        return names.length > 0 && expected && settled ? "ready" : "partial";
      }
      if (!names.includes(COMPLETE_MARKER)) return "partial";
      return expected ? "ready" : "partial";
    }
  }
}

/**
 * For a folder with model.safetensors.index.json: whether every shard it names
 * is present with at least the indexed number of bytes. null without an index.
 */
function safetensorsIndexComplete(dir: string): boolean | null {
  const indexPath = path.join(dir, "model.safetensors.index.json");
  if (!existsSync(indexPath)) return null;
  try {
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
      metadata?: { total_size?: number };
      weight_map?: Record<string, string>;
    };
    const shards = [...new Set(Object.values(index.weight_map ?? {}))];
    if (shards.length === 0) return false;
    let bytes = 0;
    for (const shard of shards) {
      const file = path.join(dir, shard);
      if (!existsSync(file)) return false;
      bytes += statSync(file).size;
    }
    return bytes >= Number(index.metadata?.total_size ?? 0);
  } catch {
    return false;
  }
}

function hasIncompleteDownloads(absPath: string): boolean {
  const cache = path.join(absPath, ".cache", "huggingface", "download");
  if (!existsSync(cache)) return false;
  const pending = (dir: string, depth: number): boolean =>
    readdirSync(dir, { withFileTypes: true }).some((item) =>
      item.isDirectory()
        ? depth > 0 && pending(path.join(dir, item.name), depth - 1)
        : item.name.endsWith(".incomplete"),
    );
  return pending(cache, 3);
}
