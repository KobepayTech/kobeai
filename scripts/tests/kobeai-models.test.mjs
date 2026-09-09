import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  REQUIRED_FIELDS,
  modelFilePath,
  readManifest,
  statusForEntry,
  validateManifest,
} from "../kobeai-models.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MANIFEST_PATH = join(REPO_ROOT, "deploy", "school-server", "models.json");

// ---------------------------------------------------------------------------
// The shipping manifest must always parse cleanly. This is the guard against
// someone editing models.json by hand and forgetting a required field.
// ---------------------------------------------------------------------------
test("shipping manifest at deploy/school-server/models.json parses + validates", async () => {
  const raw = await readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(raw);
  const errors = validateManifest(manifest);
  assert.deepEqual(errors, [], `unexpected validation errors: ${errors.join("; ")}`);
});

test("readManifest returns the same content as JSON.parse", async () => {
  const raw = await readFile(MANIFEST_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const via = await readManifest(MANIFEST_PATH);
  assert.deepEqual(Object.keys(via.models).sort(), Object.keys(parsed.models).sort());
});

test("K9 required-model set is present in the manifest", async () => {
  const manifest = await readManifest(MANIFEST_PATH);
  // These come from docs/K9_ARCHITECTURE.md — if the ADR and the manifest
  // drift, this test tells us which layer we forgot to update.
  const mustHave = [
    "yolo-master-v26.08",
    "bytetrack",
    "osnet-ain-x1_0",
    "scrfd-10g-bnkps",
    "arcface-r100-glint360k",
    "youtu-vl-4b",
    "whisper-large-v3-turbo",
    "titanet-large",
    "qwen3-4b",
  ];
  const names = Object.keys(manifest.models);
  for (const m of mustHave) {
    assert.ok(names.includes(m), `manifest is missing required model: ${m}`);
  }
});

test("required=true implies role, runtime, license present (REQUIRED_FIELDS)", async () => {
  const manifest = await readManifest(MANIFEST_PATH);
  for (const [name, entry] of Object.entries(manifest.models)) {
    for (const f of REQUIRED_FIELDS) {
      assert.notStrictEqual(entry[f], undefined, `${name}: missing ${f}`);
    }
  }
});

test("commercial-review-required flags carry a license_note", async () => {
  const manifest = await readManifest(MANIFEST_PATH);
  for (const [name, entry] of Object.entries(manifest.models)) {
    if (entry.license === "commercial-review-required") {
      assert.ok(
        typeof entry.license_note === "string" && entry.license_note.length > 10,
        `${name}: commercial-review-required must include a license_note explaining what to check`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// validateManifest — pure function, exhaustive edge cases.
// ---------------------------------------------------------------------------
test("validateManifest catches invalid model names", () => {
  const errors = validateManifest({
    models: {
      "!!! bad name !!!": {
        role: "r",
        runtime: "rt",
        license: "MIT",
        required: true,
      },
    },
  });
  assert.ok(errors.length >= 1, "expected at least one error for a garbage name");
  assert.ok(errors.some((e) => e.includes("invalid model name")), errors.join("\n"));
});

test("validateManifest catches url without sha256", () => {
  const errors = validateManifest({
    models: {
      broken: {
        role: "r",
        runtime: "rt",
        license: "MIT",
        required: true,
        url: "https://x/y.onnx",
        // sha256 deliberately omitted
      },
    },
  });
  assert.ok(errors.some((e) => e.includes("has url but no sha256")), errors.join("\n"));
});

test("validateManifest catches negative size_mb", () => {
  const errors = validateManifest({
    models: {
      shrinky: {
        role: "r",
        runtime: "rt",
        license: "MIT",
        required: true,
        url: "https://x/y.onnx",
        sha256: "a".repeat(64),
        size_mb: -5,
      },
    },
  });
  assert.ok(errors.some((e) => e.includes("size_mb")), errors.join("\n"));
});

test("validateManifest accepts a minimal algorithm-only entry (url null)", () => {
  const errors = validateManifest({
    models: {
      bytetrack: {
        role: "single-camera-tracking",
        runtime: "python",
        license: "MIT",
        required: true,
        url: null,
        sha256: null,
      },
    },
  });
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------
// statusForEntry — reports missing vs downloaded vs algorithm-only correctly.
// ---------------------------------------------------------------------------
test("statusForEntry reports algorithm-only when url is null", () => {
  const s = statusForEntry("bytetrack", {
    role: "single-camera-tracking",
    runtime: "python",
    license: "MIT",
    required: true,
    url: null,
    sha256: null,
  });
  assert.equal(s.kind, "algorithm-only");
  assert.equal(s.present, null);
  assert.equal(s.required, true);
});

test("statusForEntry reports missing when the file isn't on disk", () => {
  const s = statusForEntry("phantom", {
    role: "r",
    runtime: "rt",
    license: "MIT",
    required: true,
    url: "https://x/phantom.bin",
    sha256: "a".repeat(64),
    size_mb: 1,
  });
  assert.equal(s.kind, "missing");
  assert.ok(s.path && s.path.endsWith("phantom.bin"), `unexpected path: ${s.path}`);
});

// ---------------------------------------------------------------------------
// modelFilePath — derives a filename from the URL basename, falls back to
// <name>.bin when the URL has no useful tail.
// ---------------------------------------------------------------------------
test("modelFilePath prefers the URL basename", () => {
  const p = modelFilePath("thing", { url: "https://models/x/y/z.onnx" });
  assert.ok(p.endsWith("/thing/z.onnx"), `unexpected: ${p}`);
});

test("modelFilePath falls back to <name>.bin for URLs without a usable basename", () => {
  const p = modelFilePath("nameless", { url: "https://models/" });
  assert.ok(p.endsWith("/nameless/nameless.bin"), `unexpected: ${p}`);
});
