#!/usr/bin/env node
/**
 * kobeai-models — operator CLI for the K9 model stack.
 *
 * Reads deploy/school-server/models.json and manages an on-disk models
 * directory (defaults to /var/lib/kobeai/models; override with
 * KOBEAI_MODELS_DIR).
 *
 * Commands:
 *   list                       — show every model + local status
 *   status [name]              — verbose status; single-model when name given
 *   check [name]               — sha256-verify local files
 *   download [name] [--force]  — download missing / mismatched models
 *   path                       — print the models directory
 *
 * No third-party deps — pure Node built-ins so this runs anywhere the
 * school server does.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const MANIFEST_PATH =
  process.env["KOBEAI_MODELS_MANIFEST"] ??
  join(REPO_ROOT, "deploy", "school-server", "models.json");
const MODELS_DIR = process.env["KOBEAI_MODELS_DIR"] ?? "/var/lib/kobeai/models";

// ---------------------------------------------------------------------------
// Manifest parsing + validation
// ---------------------------------------------------------------------------
export const REQUIRED_FIELDS = ["role", "runtime", "license", "required"];

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest is not an object");
  if (!manifest.models || typeof manifest.models !== "object")
    throw new Error("manifest.models missing");
  const errors = [];
  for (const [name, entry] of Object.entries(manifest.models)) {
    if (!name || !/^[a-z0-9._-]+$/i.test(name)) {
      errors.push(`invalid model name: ${JSON.stringify(name)}`);
      continue;
    }
    for (const f of REQUIRED_FIELDS) {
      if (entry[f] === undefined) errors.push(`${name}: missing '${f}'`);
    }
    // A model may legitimately have url === null when it's algorithm-only
    // (e.g. ByteTrack), but if url is set, sha256 must be too — otherwise
    // download-and-verify is impossible and we shouldn't pretend it's ready.
    if (entry.url && !entry.sha256) {
      errors.push(`${name}: has url but no sha256`);
    }
    if (entry.size_mb != null && (typeof entry.size_mb !== "number" || entry.size_mb < 0)) {
      errors.push(`${name}: size_mb must be a non-negative number`);
    }
  }
  return errors;
}

export async function readManifest(path = MANIFEST_PATH) {
  const raw = await readFile(path, "utf8");
  const manifest = JSON.parse(raw);
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    const err = new Error(`invalid manifest at ${path}:\n  ` + errors.join("\n  "));
    err.errors = errors;
    throw err;
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Local state
// ---------------------------------------------------------------------------
export function modelFilePath(name, entry) {
  const url = entry.url ?? "";
  // Use the URL's basename when it has one, otherwise fall back to model
  // name + a runtime-derived extension.
  const base = url ? url.split("/").pop() : "";
  const filename = base && base.length > 1 ? base : `${name}.bin`;
  return join(MODELS_DIR, name, filename);
}

export function statusForEntry(name, entry) {
  if (!entry.url) {
    return { name, kind: "algorithm-only", role: entry.role, present: null, required: !!entry.required };
  }
  const path = modelFilePath(name, entry);
  if (!existsSync(path)) {
    return {
      name,
      kind: "missing",
      role: entry.role,
      required: !!entry.required,
      expected_sha256: entry.sha256 ?? null,
      expected_size_mb: entry.size_mb ?? null,
      path,
    };
  }
  const st = statSync(path);
  return {
    name,
    kind: "downloaded",
    role: entry.role,
    required: !!entry.required,
    expected_sha256: entry.sha256 ?? null,
    expected_size_mb: entry.size_mb ?? null,
    actual_size_mb: Math.round(st.size / (1024 * 1024)),
    path,
  };
}

async function sha256File(path) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const h = createHash("sha256");
    const s = createReadStream(path);
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => resolvePromise(h.digest("hex")));
    s.on("error", rejectPromise);
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function cmdList() {
  const m = await readManifest();
  const rows = Object.entries(m.models).map(([name, entry]) => statusForEntry(name, entry));
  const width = Math.max(...rows.map((r) => r.name.length), 4);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("NAME", width) + "  KIND         REQ  SIZE MB  ROLE");
  for (const r of rows) {
    const size = r.actual_size_mb ?? r.expected_size_mb ?? "-";
    console.log(
      pad(r.name, width) +
        "  " +
        pad(r.kind, 12) +
        " " +
        pad(r.required ? "yes" : "no", 4) +
        " " +
        pad(size, 8) +
        " " +
        r.role,
    );
  }
  console.log(`\nmodels dir: ${MODELS_DIR}`);
}

async function cmdStatus(only) {
  const m = await readManifest();
  const entries = only
    ? [[only, m.models[only]]].filter(([, v]) => v)
    : Object.entries(m.models);
  for (const [name, entry] of entries) {
    const s = statusForEntry(name, entry);
    console.log(`${name}:`);
    console.log(`  role     ${entry.role}`);
    console.log(`  runtime  ${entry.runtime}`);
    console.log(`  required ${entry.required}`);
    console.log(`  license  ${entry.license}`);
    if (entry.license_note) console.log(`    note   ${entry.license_note}`);
    console.log(`  state    ${s.kind}`);
    if (s.kind !== "algorithm-only" && entry.url) {
      const urlEnv = entry.url_env;
      const url = (urlEnv && process.env[urlEnv]) || entry.url;
      console.log(`  url      ${url}`);
      console.log(`  path     ${s.path}`);
      console.log(`  size     expected ${s.expected_size_mb ?? "?"} MB${s.actual_size_mb != null ? ` · on disk ${s.actual_size_mb} MB` : ""}`);
    }
  }
}

async function cmdCheck(only) {
  const m = await readManifest();
  const entries = only
    ? [[only, m.models[only]]].filter(([, v]) => v)
    : Object.entries(m.models);
  let ok = 0;
  let bad = 0;
  let missing = 0;
  for (const [name, entry] of entries) {
    if (!entry.url) continue;
    const s = statusForEntry(name, entry);
    if (s.kind === "missing") {
      console.log(`${name}: missing`);
      missing += 1;
      continue;
    }
    const digest = await sha256File(s.path);
    const expected = entry.sha256;
    const looksReal =
      expected && /^[a-f0-9]{64}$/i.test(expected) && !/replace_with/i.test(expected);
    if (!looksReal) {
      console.log(`${name}: downloaded, sha256 unchecked (manifest sha256 is a placeholder)`);
      ok += 1;
      continue;
    }
    if (digest.toLowerCase() === expected.toLowerCase()) {
      console.log(`${name}: OK`);
      ok += 1;
    } else {
      console.log(`${name}: MISMATCH`);
      console.log(`  expected ${expected}`);
      console.log(`  actual   ${digest}`);
      bad += 1;
    }
  }
  console.log(`\nsummary: ${ok} ok · ${bad} mismatched · ${missing} missing`);
  if (bad > 0 || missing > 0) process.exitCode = 1;
}

async function downloadOne(name, entry, force = false) {
  if (!entry.url) {
    console.log(`${name}: algorithm-only, nothing to download`);
    return;
  }
  const s = statusForEntry(name, entry);
  if (s.kind === "downloaded" && !force) {
    console.log(`${name}: already present at ${s.path} (use --force to redownload)`);
    return;
  }
  const url = (entry.url_env && process.env[entry.url_env]) || entry.url;
  console.log(`${name}: downloading from ${url}`);
  mkdirSync(dirname(s.path), { recursive: true });
  const tmp = s.path + ".part";
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) {
    throw new Error(`${name}: HTTP ${resp.status} ${resp.statusText}`);
  }
  const total = Number(resp.headers.get("content-length") ?? 0);
  let received = 0;
  const out = createWriteStream(tmp);
  const reader = resp.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      out.write(value);
      received += value.length;
      if (total > 0) {
        process.stdout.write(
          `\r  ${((received / total) * 100).toFixed(1)}%  ${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB   `,
        );
      }
    }
  }
  out.end();
  await new Promise((r) => out.on("close", r));
  process.stdout.write("\n");
  await rename(tmp, s.path);
  console.log(`  saved to ${s.path}`);
  // Verify immediately if we can.
  if (entry.sha256 && /^[a-f0-9]{64}$/i.test(entry.sha256) && !/replace_with/i.test(entry.sha256)) {
    const digest = await sha256File(s.path);
    if (digest.toLowerCase() !== entry.sha256.toLowerCase()) {
      console.log(`  sha256 MISMATCH — expected ${entry.sha256}, got ${digest}`);
      await unlink(s.path);
      process.exitCode = 1;
    } else {
      console.log("  sha256 verified");
    }
  }
}

async function cmdDownload(name, args) {
  const force = args.includes("--force");
  const m = await readManifest();
  const targets = name ? [[name, m.models[name]]] : Object.entries(m.models);
  for (const [n, entry] of targets) {
    if (!entry) {
      console.log(`unknown model: ${n}`);
      process.exitCode = 1;
      continue;
    }
    try {
      await downloadOne(n, entry, force);
    } catch (err) {
      console.log(`${n}: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

function usage() {
  console.log(
    `kobeai-models — K9 model registry CLI\n\n` +
      `usage:\n` +
      `  kobeai-models list\n` +
      `  kobeai-models status [name]\n` +
      `  kobeai-models check [name]\n` +
      `  kobeai-models download [name] [--force]\n` +
      `  kobeai-models path\n\n` +
      `env:\n` +
      `  KOBEAI_MODELS_DIR       (default ${MODELS_DIR})\n` +
      `  KOBEAI_MODELS_MANIFEST  (default ${MANIFEST_PATH})\n`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const [, , cmd, ...args] = process.argv;
  try {
    switch (cmd) {
      case "list":
        await cmdList();
        break;
      case "status":
        await cmdStatus(args[0]);
        break;
      case "check":
        await cmdCheck(args[0]);
        break;
      case "download":
        await cmdDownload(args[0]?.startsWith("--") ? undefined : args[0], args);
        break;
      case "path":
        console.log(MODELS_DIR);
        break;
      case "help":
      case "--help":
      case "-h":
      case undefined:
        usage();
        break;
      default:
        console.error(`unknown command: ${cmd}`);
        usage();
        process.exit(2);
    }
  } catch (err) {
    console.error(err.stack || err.message || String(err));
    process.exit(1);
  }
}

// Only run when invoked directly — imports (e.g. tests) reuse the exports.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
