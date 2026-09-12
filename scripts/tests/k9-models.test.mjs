import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  COMPLETE_MARKER,
  applyLayout,
  loadConfig,
  modelPath,
  modelStatus,
  ollamaTextModels,
  planLayout,
  resolveRoots,
  syncOllama,
  validateConfig,
} from "../k9-models.mjs";

const { config } = loadConfig();

function tempRoots() {
  const dir = mkdtempSync(path.join(tmpdir(), "k9-models-"));
  const roots = { base: path.join(dir, "Models"), k9: path.join(dir, "Models", "k9") };
  mkdirSync(roots.k9, { recursive: true });
  return roots;
}

test("shipping registry config/k9-models.json validates", () => {
  assert.deepEqual(validateConfig(config), []);
});

test("Qwen lives at the KobeOS models root and is never downloaded by K9", () => {
  const qwen = config.models.qwen;
  assert.equal(qwen.root, "base");
  assert.equal(qwen.path, "qwen.gguf");
  assert.equal(qwen.source.type, "external");
  for (const [id, entry] of Object.entries(config.models)) {
    if (id !== "qwen" && id !== "qwen3_vl_8b") assert.ok(!/qwen/i.test(entry.path), `${id} should not be a Qwen path`);
  }
});

test("every K9 model sits under a registry layout directory", () => {
  const dirs = config.layout.directories;
  for (const [id, entry] of Object.entries(config.models)) {
    if ((entry.root ?? "k9") !== "k9") continue;
    assert.ok(dirs.some((dir) => entry.path === dir || entry.path.startsWith(`${dir}/`)), `${id} (${entry.path}) is outside the layout`);
  }
});

test("K9's brain is Qwen3-VL-8B through Ollama, falling back to the KobeOS GGUFs", () => {
  const models = ollamaTextModels(config);
  assert.deepEqual(models.map((m) => m.id), ["qwen3_vl_8b", "qwen", "mistral", "llama3", "phi3", "deepseek"]);
  assert.ok(models.every((m) => m.name.startsWith("k9-")));
  const brain = config.models.qwen3_vl_8b;
  assert.equal(brain.path, "brain/qwen3-vl-8b");
  assert.equal(brain.required, true);
  assert.equal(brain.ollama.quantize, "q4_K_M");
});

test("validateConfig rejects Ollama names on non-model entries, bad quantization and unknown runtime models", () => {
  const bad = {
    version: 2,
    roots: { base: { path: "C:\\m" }, k9: { path: "C:\\m\\k9" } },
    runtime: { ollama: { text_model: "nope" } },
    models: {
      weights: { category: "x", role: "x", path: "detection/y.pt", kind: "file", required: false, source: { type: "url" }, ollama: { name: "k9-y" } },
      gguf: { category: "x", role: "x", path: "brain/a.gguf", kind: "file", required: false, source: { type: "url" }, ollama: { name: "k9-a", quantize: "q4_K_M" } },
      vl: { category: "x", role: "x", path: "brain/vl", kind: "dir", expect: ["*.safetensors"], required: false, source: { type: "external" }, ollama: { name: "k9-vl", quantize: "q3" } },
    },
  };
  const errors = validateConfig(bad).join("\n");
  assert.match(errors, /weights: only \.gguf files or safetensors model folders can be registered with Ollama/);
  assert.match(errors, /gguf: ollama\.quantize is for safetensors folders/);
  assert.match(errors, /vl: ollama\.quantize is for safetensors folders and must be one of q4_K_M/);
  assert.doesNotMatch(errors, /vl: only/);
  assert.match(errors, /runtime\.ollama: nope is not a model with an ollama name/);
});

const sha = (text) => createHash("sha256").update(text).digest("hex");

/** A stand-in Ollama API that records calls; `blobs` holds digests it already has. */
async function startMockOllama({ installed = [], blobs = new Set() } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      calls.push({ method: req.method, url: req.url, body });
      if (req.url === "/api/tags") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ models: installed.map((name) => ({ name })) }));
      }
      if (req.url.startsWith("/api/blobs/sha256:")) {
        const digest = req.url.slice("/api/blobs/sha256:".length);
        if (req.method === "HEAD") res.statusCode = blobs.has(digest) ? 200 : 404;
        else if (sha(body) === digest) {
          blobs.add(digest);
          res.statusCode = 201;
        } else res.statusCode = 400;
        return res.end();
      }
      if (req.url === "/api/create") {
        // Ollama streams NDJSON progress and ends with "success".
        return res.end(`${JSON.stringify({ status: "converting model" })}\n${JSON.stringify({ status: "success" })}\n`);
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() };
}

test("syncOllama builds missing models from registry GGUFs and reuses blobs Ollama already has", async () => {
  const roots = tempRoots();
  writeFileSync(path.join(roots.base, "known.gguf"), "GGUF-KNOWN");
  writeFileSync(path.join(roots.base, "fresh.gguf"), "GGUF-FRESH");
  writeFileSync(path.join(roots.base, "done.gguf"), "GGUF-DONE");
  const entry = (file, name) => ({
    category: "brain", role: "x", root: "base", path: file, kind: "file", required: false,
    source: { type: "external" }, ollama: { name, parameters: { temperature: 0.4 } },
  });
  const cfg = {
    version: 2,
    roots: config.roots,
    models: {
      known: entry("known.gguf", "k9-known"),
      fresh: entry("fresh.gguf", "k9-fresh"),
      done: entry("done.gguf", "k9-done"),
      gone: entry("gone.gguf", "k9-gone"),
    },
  };

  const { baseUrl, calls, close } = await startMockOllama({ installed: ["k9-done:latest"], blobs: new Set([sha("GGUF-KNOWN")]) });
  try {
    const results = await syncOllama(cfg, roots, { baseUrl, log: () => {} });
    assert.deepEqual(Object.fromEntries(results.map((r) => [r.id, r.outcome])), {
      known: "created",
      fresh: "created",
      done: "installed",
      gone: "missing",
    });
    const uploads = calls.filter((c) => c.method === "POST" && c.url.startsWith("/api/blobs/"));
    assert.deepEqual(uploads.map((c) => c.url), [`/api/blobs/sha256:${sha("GGUF-FRESH")}`], "only the unknown file is uploaded");
    const creates = calls.filter((c) => c.url === "/api/create").map((c) => JSON.parse(c.body));
    assert.deepEqual(creates[0], {
      model: "k9-known",
      files: { "known.gguf": `sha256:${sha("GGUF-KNOWN")}` },
      parameters: { temperature: 0.4 },
      stream: true,
    });

    // A second run reads digests from the cache instead of re-hashing.
    assert.ok(existsSync(path.join(roots.k9, ".k9_ollama_digests.json")));
  } finally {
    close();
  }
});

test("syncOllama imports a safetensors folder with its config and tokenizer, quantized", async () => {
  const roots = tempRoots();
  const dir = path.join(roots.k9, "brain", "vl");
  mkdirSync(path.join(dir, ".cache", "huggingface"), { recursive: true });
  const contents = {
    "model-00001-of-00002.safetensors": "SHARD-1",
    "model-00002-of-00002.safetensors": "SHARD-2",
    "model.safetensors.index.json": JSON.stringify({
      metadata: { total_size: 14 },
      weight_map: { a: "model-00001-of-00002.safetensors", b: "model-00002-of-00002.safetensors" },
    }),
    "config.json": "{}",
    "tokenizer.json": "{}",
    "merges.txt": "m",
    "README.md": "not imported",
    ".gitattributes": "not imported",
  };
  for (const [name, text] of Object.entries(contents)) writeFileSync(path.join(dir, name), text);
  writeFileSync(path.join(dir, ".cache", "huggingface", "stale.incomplete"), "");
  const cfg = {
    version: 2,
    roots: config.roots,
    models: {
      vl: {
        category: "brain", role: "x", path: "brain/vl", kind: "dir", required: true, expect: ["*.safetensors"],
        source: { type: "external" }, ollama: { name: "k9-vl", quantize: "q4_K_M", parameters: { num_ctx: 8192 } },
      },
    },
  };

  const { baseUrl, calls, close } = await startMockOllama();
  try {
    const results = await syncOllama(cfg, roots, { baseUrl, log: () => {} });
    assert.deepEqual(results, [{ id: "vl", name: "k9-vl", outcome: "created" }]);
    const [create] = calls.filter((c) => c.url === "/api/create").map((c) => JSON.parse(c.body));
    const imported = ["config.json", "merges.txt", "model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors", "model.safetensors.index.json", "tokenizer.json"];
    assert.deepEqual(create, {
      model: "k9-vl",
      files: Object.fromEntries(imported.map((name) => [name, `sha256:${sha(contents[name])}`])),
      parameters: { num_ctx: 8192 },
      quantize: "q4_K_M",
      stream: true,
    });
  } finally {
    close();
  }
});

test("a sharded safetensors folder is ready once every indexed shard is on disk, despite stale .incomplete pieces", () => {
  const roots = tempRoots();
  const entry = { kind: "dir", path: "brain/vl", expect: ["model.safetensors.index.json", "*.safetensors"], source: { type: "external" } };
  const dir = modelPath(roots, entry);
  const cache = path.join(dir, ".cache", "huggingface", "download");
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(cache, "old.incomplete"), "");
  writeFileSync(
    path.join(dir, "model.safetensors.index.json"),
    JSON.stringify({ metadata: { total_size: 10 }, weight_map: { a: "model-00001-of-00002.safetensors", b: "model-00002-of-00002.safetensors" } }),
  );
  writeFileSync(path.join(dir, "model-00001-of-00002.safetensors"), "12345");
  assert.equal(modelStatus(entry, dir), "partial", "second shard missing");
  writeFileSync(path.join(dir, "model-00002-of-00002.safetensors"), "12");
  assert.equal(modelStatus(entry, dir), "partial", "shards smaller than the index says");
  writeFileSync(path.join(dir, "model-00002-of-00002.safetensors"), "12345");
  assert.equal(modelStatus(entry, dir), "ready");
});

test("resolveRoots honours environment overrides", () => {
  const roots = resolveRoots(config, { K9_MODELS_ROOT: "D:\\k9-models", KOBEOS_MODELS_ROOT: "D:\\kobeos-models" });
  assert.equal(roots.k9, path.resolve("D:\\k9-models"));
  assert.equal(roots.base, path.resolve("D:\\kobeos-models"));
});

test("validateConfig rejects absolute paths, required optional models and duplicates", () => {
  const bad = {
    version: 2,
    roots: { base: { path: "C:\\m" }, k9: { path: "C:\\m\\k9" } },
    models: {
      a: { category: "x", role: "x", path: "C:\\abs.pt", kind: "file", required: true, source: { type: "url" } },
      b: { category: "x", role: "x", path: "optional/x", kind: "dir", required: true, source: { type: "hf" } },
      c: { category: "x", role: "x", path: "optional/x", kind: "dir", required: false, source: { type: "hf" } },
    },
  };
  const errors = validateConfig(bad).join("\n");
  assert.match(errors, /a: .* must be a path relative/);
  assert.match(errors, /b: models under optional\/ cannot be required/);
  assert.match(errors, /c: path is also used by b/);
});

test("modelStatus distinguishes missing, partial and ready", () => {
  const roots = tempRoots();
  const dirEntry = { kind: "dir", path: "audio/pyannote", expect: ["pytorch_model.bin"] };
  const dir = modelPath(roots, dirEntry);
  assert.equal(modelStatus(dirEntry, dir), "missing");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "gated");
  assert.equal(modelStatus(dirEntry, dir), "partial");
  writeFileSync(path.join(dir, COMPLETE_MARKER), "");
  assert.equal(modelStatus(dirEntry, dir), "partial", "marker alone is not enough when weights are expected");
  writeFileSync(path.join(dir, "pytorch_model.bin"), "weights");
  assert.equal(modelStatus(dirEntry, dir), "ready");

  const fileEntry = { kind: "file", path: "detection/yolo.pt" };
  const file = modelPath(roots, fileEntry);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
  assert.equal(modelStatus(fileEntry, file), "partial");
  writeFileSync(file, "w");
  assert.equal(modelStatus(fileEntry, file), "ready");
});

test("external folders are ready without a marker once weights exist and nothing is still downloading", () => {
  const roots = tempRoots();
  const entry = { kind: "dir", path: "optional/vision/vl", expect: ["*.safetensors"], source: { type: "external" } };
  const dir = modelPath(roots, entry);
  const cache = path.join(dir, ".cache", "huggingface", "download");
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(dir, "config.json"), "{}");
  assert.equal(modelStatus(entry, dir), "partial", "no weights yet");
  writeFileSync(path.join(dir, "model-00001-of-00002.safetensors"), "w");
  writeFileSync(path.join(cache, "abc.def.incomplete"), "");
  assert.equal(modelStatus(entry, dir), "partial", "a download is still in progress");
  rmSync(path.join(cache, "abc.def.incomplete"));
  assert.equal(modelStatus(entry, dir), "ready");
});

test("planLayout replaces an empty destination and drops an empty legacy leftover", () => {
  const roots = tempRoots();
  const layoutConfig = {
    version: 2,
    roots: config.roots,
    layout: {},
    models: {
      filled: { category: "x", role: "x", path: "optional/vision/a", legacy_paths: ["vision/a"], kind: "dir", required: false, source: { type: "hf" } },
      leftover: { category: "x", role: "x", path: "optional/vision/b", legacy_paths: ["vision/b"], kind: "dir", required: false, source: { type: "hf" } },
    },
  };
  mkdirSync(path.join(roots.k9, "vision", "a"), { recursive: true });
  writeFileSync(path.join(roots.k9, "vision", "a", "weights.bin"), "w");
  mkdirSync(path.join(roots.k9, "optional", "vision", "a"), { recursive: true });
  mkdirSync(path.join(roots.k9, "vision", "b"), { recursive: true });
  mkdirSync(path.join(roots.k9, "optional", "vision", "b"), { recursive: true });
  writeFileSync(path.join(roots.k9, "optional", "vision", "b", "weights.bin"), "w");

  const actions = planLayout(layoutConfig, roots);
  assert.deepEqual(actions.map((a) => a.type).sort(), ["move", "rmdir-if-empty"]);
  applyLayout(actions);
  assert.ok(existsSync(path.join(roots.k9, "optional", "vision", "a", "weights.bin")));
  assert.ok(!existsSync(path.join(roots.k9, "vision", "a")));
  assert.ok(!existsSync(path.join(roots.k9, "vision", "b")));
  assert.ok(existsSync(path.join(roots.k9, "optional", "vision", "b", "weights.bin")));
});

test("planLayout moves legacy paths, flags conflicts and only unlinks true hard links", () => {
  const roots = tempRoots();
  const layoutConfig = {
    version: 2,
    roots: config.roots,
    layout: {
      directories: ["optional/ocr"],
      redundant_hard_links: ["brain/legacy"],
      remove_if_empty: ["brain/legacy"],
    },
    models: {
      moved: { category: "x", role: "x", path: "optional/ocr/vl", legacy_paths: ["ocr/vl"], kind: "dir", required: false, source: { type: "hf" } },
      clash: { category: "x", role: "x", path: "optional/ocr/both", legacy_paths: ["ocr/both"], kind: "dir", required: false, source: { type: "hf" } },
    },
  };
  mkdirSync(path.join(roots.k9, "ocr", "vl"), { recursive: true });
  // A real conflict: both the legacy and the registry location hold files.
  mkdirSync(path.join(roots.k9, "ocr", "both"), { recursive: true });
  writeFileSync(path.join(roots.k9, "ocr", "both", "old.bin"), "old");
  mkdirSync(path.join(roots.k9, "optional", "ocr", "both"), { recursive: true });
  writeFileSync(path.join(roots.k9, "optional", "ocr", "both", "new.bin"), "new");

  const legacy = path.join(roots.k9, "brain", "legacy");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(roots.base, "mistral.gguf"), "gguf");
  linkSync(path.join(roots.base, "mistral.gguf"), path.join(legacy, "mistral.gguf"));
  writeFileSync(path.join(legacy, "notes.txt"), "a real file, not a link");

  const actions = planLayout(layoutConfig, roots);
  const byType = (type) => actions.filter((a) => a.type === type);
  assert.equal(byType("move").length, 1);
  assert.equal(byType("conflict").length, 1);
  assert.deepEqual(byType("unlink").map((a) => path.basename(a.from)), ["mistral.gguf"]);
  assert.deepEqual(byType("keep").map((a) => path.basename(a.from)), ["notes.txt"]);

  applyLayout(actions);
  assert.ok(existsSync(path.join(roots.k9, "optional", "ocr", "vl")));
  assert.ok(!existsSync(path.join(roots.k9, "ocr", "vl")));
  assert.ok(existsSync(path.join(roots.base, "mistral.gguf")), "the KobeOS copy is untouched");
  assert.ok(!existsSync(path.join(legacy, "mistral.gguf")));
  assert.ok(existsSync(path.join(legacy, "notes.txt")), "non-empty legacy folder is kept");
});
