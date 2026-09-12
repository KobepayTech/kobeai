#!/usr/bin/env node
/**
 * k9-worker — drains the KobeAI vision-analysis queue with K9's local models.
 *
 * No model is hard-coded here; the work goes where the model registry
 * (config/k9-models.json) says it runs:
 *   - Teacher Lens lookup → YuNet + SFace in the K9 model runtime, matched
 *     against the enrolled student face gallery
 *   - Teacher Lens paper photos → the first registry brain in Ollama that can
 *     read images (Qwen3-VL-8B)
 *   - remediation plans, curated notes, other text → Ollama, using the
 *     registry's brain order
 * Requests the connected models can't answer — an unenrolled face, camera
 * scenes without a frame — complete with ok:false and a note saying why.
 *
 * Env:
 *   KOBEAI_API_BASE            (default http://127.0.0.1:5555)
 *   KOBEVISION_SHARED_SECRET   (required — the api-server's worker secret)
 *   KOBEAI_WORKER_ID           (default k9-worker)
 *   KOBEAI_WORKER_BATCH        (default 5)
 *   KOBEAI_WORKER_POLL_MS      (default 4000)
 *   KOBEAI_LENS_FRAMES_DIR     where the api-server saves Teacher Lens frames
 *   K9_RUNTIME_URL / K9_RUNTIME_SECRET   (default URL from the registry)
 *   OLLAMA_BASE_URL            (default http://127.0.0.1:11434); OLLAMA_MODEL pins one model
 *   K9_MODELS_CONFIG           (default config/k9-models.json)
 */
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig, ollamaTextModels } from "./k9-models.mjs";

const API_BASE = (process.env.KOBEAI_API_BASE ?? "http://127.0.0.1:5555").replace(/\/$/, "");
const SECRET = process.env.KOBEVISION_SHARED_SECRET ?? "";
const WORKER_ID = process.env.KOBEAI_WORKER_ID ?? "k9-worker";
const BATCH = Math.max(1, Math.min(50, Number(process.env.KOBEAI_WORKER_BATCH ?? 5)));
const POLL_MS = Math.max(500, Number(process.env.KOBEAI_WORKER_POLL_MS ?? 4000));
const FRAMES_DIR = path.resolve(process.env.KOBEAI_LENS_FRAMES_DIR ?? "/var/lib/kobeai/lens-frames");
const OLLAMA_URL = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
// An 8B brain on a CPU-only school PC needs minutes, not seconds.
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 600_000);
// Reading a paper photo takes longer still: the image is encoded first.
const VISION_TIMEOUT_MS = Number(process.env.K9_VISION_TIMEOUT_MS ?? 1_800_000);
// OpenCV's SFace cosine threshold, the same one the K9 runtime uses.
const SFACE_MATCH_COSINE = 0.363;
const GENERATOR = "k9-worker";

const { config } = loadConfig();
const runtimeDefaults = config.runtime?.k9_runtime ?? {};
const RUNTIME_URL = (
  process.env.K9_RUNTIME_URL ?? `http://${runtimeDefaults.host ?? "127.0.0.1"}:${runtimeDefaults.port ?? 8766}`
).replace(/\/$/, "");
const RUNTIME_SECRET = process.env.K9_RUNTIME_SECRET ?? "";

const TEXT_SYSTEM_PROMPT =
  "You are KobeAI's K9 assistant for Tanzanian secondary-school teachers. " +
  "Be accurate, concise and practical. Never invent student records.";

if (!SECRET) {
  console.error("[k9-worker] KOBEVISION_SHARED_SECRET is required");
  process.exit(2);
}

async function api(route, init = {}) {
  const res = await fetch(`${API_BASE}/api${route}`, {
    ...init,
    headers: {
      "x-kobevision-secret": SECRET,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} at ${route}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Connected models
// ---------------------------------------------------------------------------

async function runtime(route, body) {
  const res = await fetch(`${RUNTIME_URL}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(RUNTIME_SECRET ? { "x-k9-runtime-secret": RUNTIME_SECRET } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`K9 runtime ${route} answered HTTP ${res.status}: ${payload.detail ?? payload.error ?? "no detail"}`);
  return payload;
}

let textModelCache = null;
async function textModel() {
  if (process.env.OLLAMA_MODEL) return process.env.OLLAMA_MODEL;
  if (!textModelCache || Date.now() - textModelCache.at > 60_000) {
    const tags = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.json());
    const installed = (tags.models ?? []).map((m) => m.name);
    const name = ollamaTextModels(config)
      .map((m) => m.name)
      .find((candidate) => installed.some((n) => n === candidate || n.startsWith(`${candidate}:`)));
    textModelCache = { at: Date.now(), name: name ?? null };
  }
  if (!textModelCache.name) {
    throw new Error("none of the registry's text models are in Ollama — run `node scripts/k9-models.mjs ollama-sync`");
  }
  return textModelCache.name;
}

/**
 * POSTs JSON to Ollama and reads the whole answer. Uses node:http directly:
 * fetch() gives up after 5 minutes waiting for headers, which a CPU-only PC
 * loading an 8B model (or encoding a photo) regularly exceeds.
 */
function ollamaPost(route, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, OLLAMA_URL);
    const client = url.protocol === "https:" ? https : http;
    const payload = JSON.stringify(body);
    const request = client.request(
      url,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          if (response.statusCode >= 400) {
            reject(new Error(`Ollama answered HTTP ${response.statusCode} for ${body.model}: ${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`Ollama sent an unreadable answer for ${body.model}`));
          }
        });
        response.on("error", reject);
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Ollama did not answer within ${Math.round(timeoutMs / 1000)}s`)));
    request.on("error", reject);
    request.end(payload);
  });
}

async function generate(prompt, { json = false } = {}) {
  const model = await textModel();
  const data = await ollamaPost(
    "/api/generate",
    {
      model,
      prompt,
      system: TEXT_SYSTEM_PROMPT,
      stream: false,
      ...(json ? { format: "json" } : {}),
      options: { temperature: 0.3, num_predict: 400 },
    },
    OLLAMA_TIMEOUT_MS,
  );
  const text = String(data.response ?? "").trim();
  if (!text) throw new Error(`${model} returned an empty answer`);
  return { text, model };
}

let visionModelCache = null;
/** The first registry brain in Ollama that accepts images. */
async function visionModel() {
  if (visionModelCache && Date.now() - visionModelCache.at < 60_000 && visionModelCache.name) return visionModelCache.name;
  const tags = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.json());
  const installed = (tags.models ?? []).map((m) => m.name);
  let name = null;
  for (const candidate of ollamaTextModels(config).map((m) => m.name)) {
    const tag = installed.find((n) => n === candidate || n.startsWith(`${candidate}:`));
    if (!tag) continue;
    const show = await fetch(`${OLLAMA_URL}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: tag }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.json())
      .catch(() => ({}));
    if ((show.capabilities ?? []).includes("vision")) {
      name = tag;
      break;
    }
  }
  visionModelCache = { at: Date.now(), name };
  if (!name) {
    throw new Error("no registry brain in Ollama can read images — run `node scripts/k9-models.mjs ollama-sync` to import Qwen3-VL-8B");
  }
  return name;
}

const PAPER_SCHEMA = {
  type: "object",
  properties: {
    student_name: { type: "string" },
    student_code: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question_number: { type: "integer" },
          question_text: { type: "string" },
          student_answer: { type: "string" },
          expected_answer: { type: "string" },
          is_correct: { type: "boolean" },
          marks_awarded: { type: "number" },
          marks_possible: { type: "number" },
        },
        required: ["question_number", "student_answer"],
      },
    },
    total_marks_awarded: { type: "number" },
  },
  required: ["items"],
};

/** Asks the vision brain to transcribe a student's paper into mark-sheet items. */
async function readPaper(imageBase64, ctx) {
  const model = await visionModel();
  const hints = [
    ctx.subject ? `Subject: ${ctx.subject}.` : "",
    ctx.total_marks ? `The paper is out of ${ctx.total_marks} marks.` : "",
  ].filter(Boolean);
  const prompt = [
    "This is a photo of a student's exam or exercise paper. Transcribe it for their teacher.",
    "For every question give question_number, question_text if it is visible, and student_answer: the student's final answer exactly as written.",
    "Only give expected_answer if a correct answer is printed or written by the teacher.",
    "Only give is_correct if the teacher's tick or cross is visible, and marks_awarded / marks_possible only if they are written.",
    "Give student_name or student_code if written on the paper, and total_marks_awarded if the teacher wrote a total.",
    "Do not solve the questions yourself. Write ? for anything unreadable. Reply with JSON only.",
    ...hints,
  ].join("\n");
  const data = await ollamaPost(
    "/api/chat",
    {
      model,
      stream: false,
      format: PAPER_SCHEMA,
      options: { temperature: 0.1, num_predict: 1500 },
      messages: [{ role: "user", content: prompt, images: [imageBase64] }],
    },
    VISION_TIMEOUT_MS,
  );
  let parsed = {};
  try {
    parsed = JSON.parse(String(data.message?.content ?? "{}"));
  } catch {
    throw new Error(`${model} didn't return readable JSON for the paper`);
  }
  return { model, parsed };
}

/** Cleans the brain's paper JSON into the items /paper-graded accepts. */
function paperItems(parsed) {
  const str = (v) => (typeof v === "string" && v.trim() && v.trim() !== "?" ? v.trim().slice(0, 800) : null);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  return (Array.isArray(parsed?.items) ? parsed.items : [])
    .map((item, index) => ({
      question_number: Number.isInteger(item?.question_number) && item.question_number > 0 ? item.question_number : index + 1,
      question_text: str(item?.question_text),
      student_answer: str(item?.student_answer),
      expected_answer: str(item?.expected_answer),
      is_correct: typeof item?.is_correct === "boolean" ? item.is_correct : null,
      marks_awarded: num(item?.marks_awarded),
      marks_possible: num(item?.marks_possible),
    }))
    .filter((item) => item.student_answer !== null || item.question_text !== null)
    .slice(0, 100);
}

let galleryCache = null;
async function faceGallery({ refresh = false } = {}) {
  if (refresh || !galleryCache || Date.now() - galleryCache.at > 30_000) {
    const body = await api("/v1/vision/face-gallery");
    galleryCache = { at: Date.now(), students: body?.students ?? [] };
  }
  return galleryCache;
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

function bestFaceMatch(embedding, students) {
  let best = null;
  for (const student of students) {
    for (const enrolled of student.embeddings ?? []) {
      const score = cosine(embedding, enrolled);
      if (!best || score > best.cosine) best = { student_code: student.student_code, name: student.name, cosine: score };
    }
  }
  return best;
}

/** Reads a saved Teacher Lens frame; keys look like `2026-09-11/abc123.lookup.jpg`. */
async function readFrame(imageKey) {
  if (!/^\d{4}-\d{2}-\d{2}[\\/][\w.-]+\.(jpe?g|png)$/i.test(String(imageKey))) {
    throw new Error(`unexpected lens frame key: ${imageKey}`);
  }
  const file = path.resolve(FRAMES_DIR, imageKey);
  if (!file.startsWith(FRAMES_DIR + path.sep)) throw new Error("lens frame key escapes the frames folder");
  return readFile(file);
}

function planFrom(text) {
  try {
    const parsed = JSON.parse(text);
    const steps = Array.isArray(parsed) ? parsed : parsed.plan ?? parsed.steps;
    if (Array.isArray(steps) && steps.length > 0) return steps.map((step) => String(step).trim()).filter(Boolean).slice(0, 5);
  } catch {
    // not JSON — fall back to lines
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 5);
}

const boxArea = ([x1, y1, x2, y2]) => Math.max(0, x2 - x1) * Math.max(0, y2 - y1);

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

/** Returns the object stored on the request as `response`; ok:false marks it failed. */
async function handle(request) {
  const question = String(request.question ?? "");
  const q = question.toLowerCase();
  const reason = String(request.reason ?? "");
  const ctx = request.context ?? {};

  // Teacher Lens paper photo: the vision brain reads the answers for the mark sheet.
  if (reason === "lens:mark_paper" || (q.includes("ocr") && q.includes("paper"))) {
    if (!ctx.image_key) {
      return { ok: false, generator: GENERATOR, note: "The paper photo wasn't saved, so there is nothing to read." };
    }
    const image = (await readFrame(ctx.image_key)).toString("base64");
    const { model, parsed } = await readPaper(image, ctx);
    const items = paperItems(parsed);
    if (items.length === 0) {
      return { ok: false, generator: GENERATOR, model, note: "No answers could be read — hold the paper flat, fill the frame and avoid glare." };
    }
    const optional = (value) => (typeof value === "string" && value.trim() && value.trim() !== "?" ? value.trim().slice(0, 120) : null);
    return {
      generator: GENERATOR,
      model,
      items,
      student_name: optional(parsed.student_name),
      student_code: optional(parsed.student_code),
      total_marks_awarded: typeof parsed.total_marks_awarded === "number" ? parsed.total_marks_awarded : null,
      note: `Read by ${model}. The teacher checks every answer before saving.`,
    };
  }

  // Teacher Lens lookup: YuNet finds faces, SFace embeds the largest one, and
  // it is matched against the enrolled student face gallery.
  if (reason === "lens:lookup" || q.includes("face-recognise") || q.includes("face recognise")) {
    if (!ctx.image_key) {
      return { ok: false, generator: GENERATOR, note: "The lens frame wasn't saved, so there is nothing to analyse." };
    }
    const image = (await readFrame(ctx.image_key)).toString("base64");
    const { faces } = await runtime("/v1/faces", { image, embed: true });
    if (faces.length === 0) {
      return { ok: false, generator: GENERATOR, models: ["yunet"], faces: 0, hint: "No face in the frame — move closer or improve the lighting." };
    }
    const largest = faces.reduce((best, face) => (boxArea(face.box) > boxArea(best.box) ? face : best));
    let gallery = await faceGallery();
    let match = bestFaceMatch(largest.embedding, gallery.students);
    if ((!match || match.cosine < SFACE_MATCH_COSINE) && Date.now() - gallery.at > 2_000) {
      // A face may have been enrolled since the gallery was cached.
      gallery = await faceGallery({ refresh: true });
      match = bestFaceMatch(largest.embedding, gallery.students);
    }
    if (!match || match.cosine < SFACE_MATCH_COSINE) {
      return {
        ok: false,
        generator: GENERATOR,
        models: ["yunet", "sface"],
        faces: faces.length,
        best_cosine: match ? Number(match.cosine.toFixed(3)) : null,
        enrolled_students: gallery.students.length,
        hint:
          gallery.students.length === 0
            ? "No student faces are enrolled yet. Pick the student and tick Remember this face."
            : "Pick the student from the list and tick Remember this face.",
      };
    }
    return {
      generator: GENERATOR,
      models: ["yunet", "sface"],
      faces: faces.length,
      student_code: match.student_code,
      student_name: match.name,
      confidence: Number(match.cosine.toFixed(3)),
    };
  }

  // Presence mismatches don't carry a camera frame yet.
  if (reason.includes("live_mismatch") || q.includes("student appears to be doing")) {
    return {
      ok: false,
      generator: GENERATOR,
      confidence: 0,
      note: "Camera frames aren't attached to presence requests yet, so the scene can't be analysed. The timetable mismatch itself is recorded.",
    };
  }

  // Remediation plans from paper-grading patterns: the K9 text brain.
  if (reason === "auto:paper_grading_pattern" || q.includes("remediation")) {
    const { text, model } = await generate(`${question}\nReply with JSON only: {"plan": ["step 1", "step 2", "step 3"]}.`, { json: true });
    return { generator: GENERATOR, model, plan: planFrom(text), note: `Generated by ${model} from the K9 model registry.` };
  }

  // Curated notes for students.
  if (reason === "auto:curated_note" || q.includes("curated note")) {
    const { text, model } = await generate(question);
    return { generator: GENERATOR, model, note_markdown: text, topic: ctx.topic ?? null };
  }

  // Anything else is answered by the text model.
  const { text, model } = await generate(question);
  return { generator: GENERATOR, model, answer: text };
}

async function drain() {
  const claimed = await api(`/v1/vision/analyze/pending?worker=${encodeURIComponent(WORKER_ID)}&limit=${BATCH}`);
  const requests = claimed?.requests ?? [];
  for (const r of requests) {
    let response;
    let ok = true;
    try {
      response = await handle(r);
      if (response && typeof response === "object" && response.ok === false) ok = false;
    } catch (err) {
      ok = false;
      response = { generator: GENERATOR, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      await api(`/v1/vision/analyze/${r.id}/complete`, {
        method: "POST",
        body: JSON.stringify({ ok, response, worker: WORKER_ID }),
      });
      console.log(`[k9-worker] ${ok ? "completed" : "failed"} request ${r.id} (${r.reason ?? "manual"}): ${String(r.question).slice(0, 60)}…`);
    } catch (err) {
      console.warn(`[k9-worker] couldn't complete ${r.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return requests.length;
}

async function main() {
  console.log(`[k9-worker] draining ${API_BASE} as ${WORKER_ID} (batch=${BATCH}, poll=${POLL_MS}ms)`);
  console.log(`[k9-worker] K9 runtime ${RUNTIME_URL}; Ollama ${OLLAMA_URL}; lens frames ${FRAMES_DIR}`);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await drain();
    } catch (err) {
      console.warn("[k9-worker] tick failed:", err instanceof Error ? err.message : err);
    }
    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  console.error("[k9-worker] fatal:", err);
  process.exit(1);
});
