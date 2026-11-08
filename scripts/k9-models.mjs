#!/usr/bin/env node
/**
 * k9-models — the one place K9 model locations come from.
 *
 * Reads config/k9-models.json (override with K9_MODELS_CONFIG) and resolves
 * every model against its root: `k9` (C:\KobeOS\Models\k9, override with
 * K9_MODELS_ROOT) or `base` (C:\KobeOS\Models, override with
 * KOBEOS_MODELS_ROOT) for the general KobeOS text models.
 *
 * Commands:
 *   root                  print the K9 models root
 *   paths [--json]        resolved absolute path of every model
 *   status [--json]       READY / PARTIAL / MISSING; exits 1 if a required model isn't ready
 *   layout [--apply]      align the folders with the registry (dry run unless --apply)
 *   download [id ...]     fetch what's missing (Hugging Face, git, URL, gdown, hard link)
 *   ollama-sync           register the registry's text brains with Ollama (k9-qwen3-vl, k9-qwen, …)
 *
 * Only Node built-ins, so it runs on a school PC without `npm install`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = path.resolve(HERE, "..", "config", "k9-models.json");
export const KINDS = ["file", "dir", "repo", "files"];
export const SOURCE_TYPES = ["hf", "hf-files", "git", "url", "gdown", "link", "external"];
export const COMPLETE_MARKER = ".k9_complete";
/** Quantizations Ollama can apply when it imports a safetensors model. */
export const OLLAMA_QUANTIZE = ["q4_K_M", "q4_K_S", "q8_0"];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function loadConfig(configPath = process.env.K9_MODELS_CONFIG || DEFAULT_CONFIG_PATH) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`invalid K9 model registry ${configPath}:\n  ${errors.join("\n  ")}`);
  }
  return { config, configPath };
}

function isRelativeInside(p) {
  return typeof p === "string" && p.length > 0 && !path.isAbsolute(p) && !/^[a-z]:/i.test(p) && !p.split(/[\\/]/).includes("..");
}

export function validateConfig(config) {
  const errors = [];
  if (config?.version !== 2) errors.push("version must be 2");
  for (const root of ["base", "k9"]) {
    if (!config?.roots?.[root]?.path) errors.push(`roots.${root}.path is missing`);
  }
  const used = new Map();
  for (const [id, entry] of Object.entries(config?.models ?? {})) {
    if (!/^[a-z0-9_]+$/.test(id)) errors.push(`${id}: model ids are snake_case`);
    for (const field of ["category", "role", "path", "kind", "source"]) {
      if (entry[field] === undefined) errors.push(`${id}: missing ${field}`);
    }
    if (typeof entry.required !== "boolean") errors.push(`${id}: required must be true or false`);
    if (entry.kind !== undefined && !KINDS.includes(entry.kind)) errors.push(`${id}: unknown kind ${entry.kind}`);
    if (entry.source && !SOURCE_TYPES.includes(entry.source.type)) errors.push(`${id}: unknown source type ${entry.source.type}`);
    if (entry.root !== undefined && !["base", "k9"].includes(entry.root)) errors.push(`${id}: root must be "base" or "k9"`);
    for (const p of [entry.path, ...(entry.legacy_paths ?? [])]) {
      if (!isRelativeInside(p)) errors.push(`${id}: ${JSON.stringify(p)} must be a path relative to its root`);
    }
    for (const field of ["weights", "code"]) {
      if (entry[field] !== undefined && !isRelativeInside(entry[field])) {
        errors.push(`${id}: ${field} must be a path relative to the model folder`);
      }
    }
    if (typeof entry.path === "string" && entry.path.startsWith("optional/") && entry.required) {
      errors.push(`${id}: models under optional/ cannot be required`);
    }
    if (entry.kind === "files" && !(Array.isArray(entry.files) && entry.files.length > 0)) {
      errors.push(`${id}: kind "files" needs a non-empty files list`);
    }
    if (entry.ollama !== undefined) {
      if (!/^[a-z0-9][a-z0-9._-]*(:[a-z0-9._-]+)?$/.test(entry.ollama?.name ?? "")) {
        errors.push(`${id}: ollama.name must be a valid Ollama model name`);
      }
      const gguf = entry.kind === "file" && String(entry.path).toLowerCase().endsWith(".gguf");
      const safetensors = entry.kind === "dir" && (entry.expect ?? []).some((pattern) => /safetensors/i.test(pattern));
      if (!gguf && !safetensors) {
        errors.push(`${id}: only .gguf files or safetensors model folders can be registered with Ollama`);
      }
      if (entry.ollama?.quantize !== undefined && !(safetensors && OLLAMA_QUANTIZE.includes(entry.ollama.quantize))) {
        errors.push(`${id}: ollama.quantize is for safetensors folders and must be one of ${OLLAMA_QUANTIZE.join(", ")}`);
      }
    }
    const key = `${entry.root ?? "k9"}:${entry.path}`;
    if (used.has(key)) errors.push(`${id}: path is also used by ${used.get(key)}`);
    else used.set(key, id);
  }
  const ollamaRuntime = config?.runtime?.ollama;
  if (ollamaRuntime) {
    const declared = [
      ollamaRuntime.text_model,
      ...(ollamaRuntime.text_fallbacks ?? []),
      ollamaRuntime.vision_model,
      ...(ollamaRuntime.vision_fallbacks ?? []),
    ].filter(Boolean);
    for (const id of declared) {
      if (!config.models?.[id]?.ollama) errors.push(`runtime.ollama: ${id} is not a model with an ollama name`);
    }
  }
  return errors;
}

export function resolveRoots(config, env = process.env) {
  return Object.fromEntries(
    Object.entries(config.roots).map(([name, root]) => [name, path.resolve((root.env && env[root.env]) || root.path)]),
  );
}

const joinRelative = (root, rel) => path.join(root, ...rel.split("/"));

export function modelPath(roots, entry) {
  return joinRelative(roots[entry.root ?? "k9"], entry.path);
}

function linkSourcePath(roots, from) {
  const [root, rel] = from.includes(":") ? from.split(/:(.*)/s) : ["k9", from];
  return joinRelative(roots[root], rel);
}

function matchesPattern(name, pattern) {
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
  return regex.test(name);
}

/**
 * For a folder with model.safetensors.index.json: whether every shard it names
 * is present with at least the indexed number of bytes. null without an index.
 */
function safetensorsIndexComplete(dir) {
  const indexPath = path.join(dir, "model.safetensors.index.json");
  if (!existsSync(indexPath)) return null;
  try {
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
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

/** "ready" | "partial" | "missing" for one registry entry at its resolved path. */
export function modelStatus(entry, absPath) {
  if (!existsSync(absPath)) return "missing";
  switch (entry.kind) {
    case "file":
      return statSync(absPath).size > 0 ? "ready" : "partial";
    case "repo":
      return existsSync(path.join(absPath, ".git")) ? "ready" : "partial";
    case "files":
      return entry.files.every((file) => existsSync(joinRelative(absPath, file))) ? "ready" : "partial";
    default: {
      const names = readdirSync(absPath);
      const expected = (entry.expect ?? []).every((pattern) => names.some((name) => matchesPattern(name, pattern)));
      // Folders downloaded outside the K9 downloader have no completion marker:
      // they count once the expected files exist and no download is unfinished.
      // A sharded safetensors model with every indexed shard on disk is complete,
      // even if an earlier failed attempt left .incomplete pieces behind.
      if (entry.source?.type === "external") {
        const settled = safetensorsIndexComplete(absPath) ?? !hasIncompleteDownloads(absPath);
        return names.length > 0 && expected && settled ? "ready" : "partial";
      }
      // Hugging Face folders only count once the downloader marked them complete,
      // and gated repos must also contain their real weights, not just a README.
      if (!names.includes(COMPLETE_MARKER)) return "partial";
      return expected ? "ready" : "partial";
    }
  }
}

function hasIncompleteDownloads(absPath) {
  const cache = path.join(absPath, ".cache", "huggingface", "download");
  if (!existsSync(cache)) return false;
  const pending = (dir, depth) =>
    readdirSync(dir, { withFileTypes: true }).some((item) =>
      item.isDirectory() ? depth > 0 && pending(path.join(dir, item.name), depth - 1) : item.name.endsWith(".incomplete"),
    );
  return pending(cache, 3);
}

function isEmptyDirectory(p) {
  return existsSync(p) && statSync(p).isDirectory() && readdirSync(p).length === 0;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Actions that make the on-disk folders match the registry. Nothing here deletes
 * model data: folders are renamed within the same drive, and the only files
 * removed are extra hard-link names whose data stays at the KobeOS models root.
 */
export function planLayout(config, roots) {
  const at = (rel) => joinRelative(roots.k9, rel);
  const actions = [];

  for (const dir of config.layout?.directories ?? []) {
    if (!existsSync(at(dir))) actions.push({ type: "mkdir", to: at(dir) });
  }

  const moves = [
    ...Object.entries(config.models)
      .filter(([, entry]) => (entry.root ?? "k9") === "k9")
      .flatMap(([id, entry]) => (entry.legacy_paths ?? []).map((from) => ({ from, to: entry.path, note: id }))),
    ...(config.layout?.relocate ?? []),
  ];
  for (const move of moves) {
    const from = at(move.from);
    const to = at(move.to);
    if (!existsSync(from)) continue;
    if (existsSync(to) && isEmptyDirectory(from)) {
      // A download recreated the old folder but hasn't written anything to it yet.
      actions.push({ type: "rmdir-if-empty", from, note: `${move.note ?? ""} — empty leftover of ${move.to}` });
    } else if (existsSync(to) && !isEmptyDirectory(to)) {
      actions.push({ type: "conflict", from, to, note: `${move.note ?? ""} — both locations have files; resolve by hand` });
    } else {
      actions.push({ type: "move", from, to, note: move.note, replaceEmpty: existsSync(to) });
    }
  }

  for (const rel of config.layout?.redundant_hard_links ?? []) {
    const target = at(rel);
    if (!existsSync(target)) continue;
    const files = statSync(target).isDirectory()
      ? readdirSync(target).map((name) => path.join(target, name))
      : [target];
    for (const file of files) {
      const baseFile = path.join(roots.base, path.basename(file));
      if (sharesData(file, baseFile)) {
        actions.push({ type: "unlink", from: file, note: `extra hard-link name; the data stays at ${baseFile}` });
      } else {
        actions.push({ type: "keep", from: file, note: `not a hard link of ${baseFile}; left in place` });
      }
    }
  }

  for (const rel of config.layout?.remove_if_empty ?? []) {
    if (existsSync(at(rel))) actions.push({ type: "rmdir-if-empty", from: at(rel) });
  }
  return actions;
}

function sharesData(file, other) {
  if (!existsSync(file) || !existsSync(other)) return false;
  const a = statSync(file, { bigint: true });
  const b = statSync(other, { bigint: true });
  return a.isFile() && b.isFile() && a.nlink > 1n && a.dev === b.dev && a.ino === b.ino;
}

export function applyLayout(actions) {
  const results = [];
  for (const action of actions) {
    try {
      switch (action.type) {
        case "mkdir":
          mkdirSync(action.to, { recursive: true });
          break;
        case "move":
          // An empty placeholder at the destination (e.g. from an earlier run) is replaced.
          if (action.replaceEmpty && isEmptyDirectory(action.to)) rmdirSync(action.to);
          mkdirSync(path.dirname(action.to), { recursive: true });
          renameSync(action.from, action.to);
          break;
        case "unlink":
          unlinkSync(action.from);
          break;
        case "rmdir-if-empty":
          if (existsSync(action.from) && readdirSync(action.from).length === 0) rmdirSync(action.from);
          else {
            results.push({ ...action, outcome: "not empty — kept" });
            continue;
          }
          break;
        default:
          results.push({ ...action, outcome: "skipped" });
          continue;
      }
      results.push({ ...action, outcome: "done" });
    } catch (err) {
      results.push({ ...action, outcome: `failed: ${err.message}` });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

async function downloadUrl(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const partial = `${dest}.part`;
  writeFileSync(partial, Buffer.from(await res.arrayBuffer()));
  renameSync(partial, dest);
}

export async function downloadModels(config, roots, ids = []) {
  const hf = process.env.HF_EXE || "hf";
  const python = process.env.PYTHON || (process.platform === "win32" ? "py" : "python3");
  mkdirSync(roots.k9, { recursive: true });
  const okLog = path.join(roots.k9, "download_completed.txt");
  const failLog = path.join(roots.k9, "download_failures.txt");
  writeFileSync(okLog, "");
  writeFileSync(failLog, "");

  const entries = Object.entries(config.models).filter(([id]) => ids.length === 0 || ids.includes(id));
  for (const unknown of ids.filter((id) => !config.models[id])) {
    console.log(`[UNKNOWN] ${unknown}`);
    appendFileSync(failLog, `${unknown}: not in the registry\n`);
  }

  for (const [id, entry] of entries) {
    const dest = modelPath(roots, entry);
    if (modelStatus(entry, dest) === "ready") {
      console.log(`[SKIP] ${id}`);
      appendFileSync(okLog, `SKIP ${id}\n`);
      continue;
    }
    const source = entry.source;
    console.log(`\n[GET] ${id} (${source.type}) -> ${dest}`);
    try {
      switch (source.type) {
        case "external":
          throw new Error(source.note ?? "managed outside the K9 downloader");
        case "link": {
          const from = linkSourcePath(roots, source.from);
          if (!existsSync(from)) throw new Error(`existing local model not found: ${from}`);
          mkdirSync(path.dirname(dest), { recursive: true });
          linkSync(from, dest);
          break;
        }
        case "hf":
          mkdirSync(dest, { recursive: true });
          run(hf, ["download", source.repo, "--local-dir", dest, ...(source.exclude ?? []).flatMap((pattern) => ["--exclude", pattern])]);
          writeFileSync(path.join(dest, COMPLETE_MARKER), "");
          break;
        case "hf-files":
          mkdirSync(dest, { recursive: true });
          for (const file of entry.files) run(hf, ["download", source.repo, file, "--local-dir", dest]);
          break;
        case "git":
          if (existsSync(dest)) throw new Error(`${dest} exists but is not a git checkout`);
          mkdirSync(path.dirname(dest), { recursive: true });
          run("git", ["clone", "--depth", "1", ...(source.recursive ? ["--recursive"] : []), source.url, dest]);
          break;
        case "url":
          mkdirSync(path.dirname(dest), { recursive: true });
          await downloadUrl(source.url, dest);
          break;
        case "gdown":
          mkdirSync(path.dirname(dest), { recursive: true });
          run(python, ["-m", "gdown", "--id", source.id, "-O", dest]);
          break;
        default:
          throw new Error(`unsupported source type ${source.type}`);
      }
      const status = modelStatus(entry, dest);
      if (status !== "ready") throw new Error(`still ${status} after download${entry.gated ? " (gated: accept the terms and run `hf auth login`)" : ""}`);
      console.log(`[OK] ${id}`);
      appendFileSync(okLog, `${id}\n`);
    } catch (err) {
      console.log(`[FAILED] ${id}: ${err.message}`);
      appendFileSync(failLog, `${id}: ${err.message}\n`);
    }
  }
  console.log(`\nCompleted/skipped: ${okLog}\nFailed/gated:      ${failLog}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Ollama (text brain)
// ---------------------------------------------------------------------------

function ollamaModelsFor(config, ids) {
  const seen = new Set();
  return ids
    .filter(Boolean)
    .map((id) => ({ id, name: config.models[id]?.ollama?.name }))
    .filter((model) => model.name && !seen.has(model.name) && seen.add(model.name));
}

/** K9's text models in the order the api-server tries them: default first, then fallbacks. */
export function ollamaTextModels(config) {
  const runtime = config.runtime?.ollama;
  return ollamaModelsFor(config, [runtime?.text_model, ...(runtime?.text_fallbacks ?? [])]);
}

/** K9's image-reading models, in the order the paper reader tries them. */
export function ollamaVisionModels(config) {
  const runtime = config.runtime?.ollama;
  return ollamaModelsFor(config, [runtime?.vision_model, ...(runtime?.vision_fallbacks ?? [])]);
}

async function fileDigest(file, cache) {
  const { size, mtimeMs } = statSync(file);
  const key = path.resolve(file);
  const hit = cache[key];
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.sha256;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  cache[key] = { size, mtimeMs, sha256 };
  return sha256;
}

const OLLAMA_IMPORT_FILE = /\.(safetensors|json|txt|model|jinja)$/i;

/** What Ollama needs to build a model: the GGUF itself, or a safetensors folder's weights, config and tokenizer. */
export function ollamaImportFiles(entry, absPath) {
  if (entry.kind === "file") return [absPath];
  return readdirSync(absPath, { withFileTypes: true })
    .filter((item) => item.isFile() && !item.name.startsWith(".") && OLLAMA_IMPORT_FILE.test(item.name))
    .map((item) => path.join(absPath, item.name))
    .sort();
}

/**
 * POST /api/create and follow its progress stream. Converting and quantizing a
 * large safetensors model takes far longer than fetch()'s timeouts allow.
 */
function createOllamaModel(baseUrl, body, log) {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/create", baseUrl);
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(url, { method: "POST", headers: { "content-type": "application/json" } }, (response) => {
      let buffer = "";
      let lastStatus = "";
      let failure = null;
      const handle = (line) => {
        if (!line.trim()) return;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.error) failure = message.error;
        if (message.status && message.status !== lastStatus) {
          lastStatus = message.status;
          log(`  ${message.status}`);
        }
      };
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          handle(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      });
      response.on("end", () => {
        handle(buffer);
        if (response.statusCode >= 400 || failure) reject(new Error(`create failed: HTTP ${response.statusCode} ${failure ?? lastStatus}`.trim()));
        else if (lastStatus !== "success") reject(new Error(`create did not finish (last status: ${lastStatus || "none"})`));
        else resolve();
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

/**
 * Registers every registry model that has an `ollama` name as an Ollama model
 * built straight from its registry path: a GGUF file as-is, or a safetensors
 * folder converted (and quantized when `ollama.quantize` is set). A blob Ollama
 * already holds for the same file (e.g. imported by KobeOS) is reused, so
 * nothing is copied twice. Digests are cached next to the models so reruns are
 * instant.
 */
export async function syncOllama(config, roots, { baseUrl, digestCachePath = path.join(roots.k9, ".k9_ollama_digests.json"), log = console.log } = {}) {
  const tagsResponse = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) });
  if (!tagsResponse.ok) throw new Error(`Ollama at ${baseUrl} answered HTTP ${tagsResponse.status}`);
  const installed = new Set(((await tagsResponse.json()).models ?? []).map((model) => model.name));

  let cache = {};
  try {
    cache = JSON.parse(readFileSync(digestCachePath, "utf8"));
  } catch {
    // first run
  }

  const results = [];
  for (const [id, entry] of Object.entries(config.models)) {
    if (!entry.ollama) continue;
    const name = entry.ollama.name;
    if (installed.has(name) || installed.has(`${name}:latest`)) {
      log(`[SKIP] ${name} is already in Ollama`);
      results.push({ id, name, outcome: "installed" });
      continue;
    }
    const source = modelPath(roots, entry);
    if (modelStatus(entry, source) !== "ready") {
      log(`[MISSING] ${id}: ${source}`);
      results.push({ id, name, outcome: "missing" });
      continue;
    }
    try {
      const files = {};
      for (const file of ollamaImportFiles(entry, source)) {
        log(`[HASH] ${file}`);
        const digest = await fileDigest(file, cache);
        mkdirSync(path.dirname(digestCachePath), { recursive: true });
        writeFileSync(digestCachePath, JSON.stringify(cache, null, 2));

        const blobUrl = `${baseUrl}/api/blobs/sha256:${digest}`;
        if ((await fetch(blobUrl, { method: "HEAD" })).status !== 200) {
          log(`[UPLOAD] ${path.basename(file)} into Ollama's blob store`);
          const upload = await fetch(blobUrl, { method: "POST", body: Readable.toWeb(createReadStream(file)), duplex: "half" });
          if (!upload.ok) throw new Error(`blob upload failed: HTTP ${upload.status}`);
        }
        files[path.basename(file)] = `sha256:${digest}`;
      }

      const quantize = entry.ollama.quantize;
      log(quantize ? `[CREATE] ${name}: converting and quantizing to ${quantize} (this takes a while)` : `[CREATE] ${name}`);
      await createOllamaModel(
        baseUrl,
        { model: name, files, parameters: entry.ollama.parameters, ...(quantize ? { quantize } : {}), stream: true },
        log,
      );
      log(`[CREATED] ${name} from ${source}`);
      results.push({ id, name, outcome: "created" });
    } catch (err) {
      log(`[FAILED] ${id}: ${err.message}`);
      results.push({ id, name, outcome: `failed: ${err.message}` });
    }
  }
  return results;
}

function printStatus(config, roots, json) {
  const rows = Object.entries(config.models).map(([id, entry]) => {
    const absPath = modelPath(roots, entry);
    return { id, category: entry.category, role: entry.role, required: entry.required, status: modelStatus(entry, absPath), path: absPath };
  });
  const requiredNotReady = rows.filter((row) => row.required && row.status !== "ready");
  if (json) {
    console.log(JSON.stringify({ roots, models: rows }, null, 2));
  } else {
    const label = { ready: "READY", partial: "PART ", missing: "MISS " };
    console.log(`K9 models root:     ${roots.k9}\nKobeOS models root: ${roots.base}\n`);
    for (const required of [true, false]) {
      console.log(required ? "Required" : "\nOptional");
      for (const row of rows.filter((r) => r.required === required)) {
        console.log(`  [${label[row.status]}] ${row.id.padEnd(34)} ${row.status === "ready" ? "" : row.path}`);
      }
    }
    const requiredRows = rows.filter((row) => row.required);
    const optionalRows = rows.filter((row) => !row.required);
    console.log(`\nRequired ready: ${requiredRows.length - requiredNotReady.length} / ${requiredRows.length}`);
    console.log(`Optional ready: ${optionalRows.filter((row) => row.status === "ready").length} / ${optionalRows.length}`);
    console.log(requiredNotReady.length === 0 ? "[READY] Required K9 model stack is present." : "[NOT READY] One or more required K9 models are missing or incomplete.");
  }
  return requiredNotReady.length === 0;
}

function printLayout(actions, apply) {
  if (actions.length === 0) {
    console.log("Layout already matches config/k9-models.json.");
    return;
  }
  const results = apply ? applyLayout(actions) : actions.map((action) => ({ ...action, outcome: "planned" }));
  for (const r of results) {
    const where = r.type === "move" || r.type === "conflict" ? `${r.from}\n        -> ${r.to}` : r.to ?? r.from;
    console.log(`[${r.type.toUpperCase()}] ${where}${r.note ? `\n        ${r.note}` : ""}${apply ? `\n        ${r.outcome}` : ""}`);
  }
  if (!apply) console.log("\nDry run — re-run with --apply to make these changes.");
}

async function main() {
  const [, , command, ...args] = process.argv;
  const { config, configPath } = loadConfig();
  const roots = resolveRoots(config);
  switch (command) {
    case "root":
      console.log(roots.k9);
      break;
    case "python": {
      const python = config.runtime?.python;
      console.log((python?.env && process.env[python.env]) || python?.executable || "python");
      break;
    }
    case "paths": {
      const paths = Object.fromEntries(Object.entries(config.models).map(([id, entry]) => [id, modelPath(roots, entry)]));
      if (args.includes("--json")) console.log(JSON.stringify({ config: configPath, roots, models: paths }, null, 2));
      else for (const [id, p] of Object.entries(paths)) console.log(`${id.padEnd(34)} ${p}`);
      break;
    }
    case "status":
      if (!printStatus(config, roots, args.includes("--json"))) process.exitCode = 1;
      break;
    case "layout":
      printLayout(planLayout(config, roots), args.includes("--apply"));
      break;
    case "download":
      await downloadModels(config, roots, args.filter((arg) => !arg.startsWith("--")));
      break;
    case "ollama-sync": {
      const flag = args.indexOf("--base-url");
      const baseUrl = (flag >= 0 ? args[flag + 1] : process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
      const results = await syncOllama(config, roots, { baseUrl });
      const order = ollamaTextModels(config).map((model) => model.name).join(" → ");
      console.log(`\nK9 text model order: ${order}`);
      if (results.some((result) => result.outcome.startsWith("failed"))) process.exitCode = 1;
      break;
    }
    default:
      console.log(
        "k9-models — K9 model registry (config/k9-models.json)\n\n" +
        "usage:\n" +
        "  node scripts/k9-models.mjs root\n" +
        "  node scripts/k9-models.mjs python\n" +
        "  node scripts/k9-models.mjs paths [--json]\n" +
        "  node scripts/k9-models.mjs status [--json]\n" +
        "  node scripts/k9-models.mjs layout [--apply]\n" +
        "  node scripts/k9-models.mjs download [id ...]\n" +
        "  node scripts/k9-models.mjs ollama-sync [--base-url URL]\n\n" +
        "env: K9_MODELS_CONFIG, K9_MODELS_ROOT, KOBEOS_MODELS_ROOT, HF_EXE, PYTHON, OLLAMA_BASE_URL",
      );
      if (command && command !== "help") process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
