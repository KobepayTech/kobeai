#!/usr/bin/env node
/**
 * k9-worker — drains the KobeAI vision-analysis queue.
 *
 * This is a **stub** worker: it does not run YOLO / Youtu-VL / Qwen. It
 * exists so the intelligence path can be exercised end-to-end without a
 * GPU box, and so integration tests can watch a real drain happen.
 * Every response is heuristic based on the question shape, with a
 * `generator: "k9-worker-stub"` tag so downstream code can tell it apart
 * from a real Youtu-VL answer.
 *
 * Swap-in path for the real worker:
 *   - keep the poll / claim / complete lifecycle,
 *   - replace `handle()` with a call into your model runtime,
 *   - keep the shared secret + endpoint the same (KOBEVISION_SHARED_SECRET
 *     against POST /v1/vision/analyze/complete).
 *
 * Env:
 *   KOBEAI_API_BASE            (default http://127.0.0.1:5555)
 *   KOBEVISION_SHARED_SECRET   (required — the same secret the api-server
 *                                sees; presence + lens use it too)
 *   KOBEAI_WORKER_ID           (default k9-worker-stub)
 *   KOBEAI_WORKER_BATCH        (default 5)
 *   KOBEAI_WORKER_POLL_MS      (default 4000)
 */
import { setTimeout as sleep } from "node:timers/promises";

const API_BASE = (process.env.KOBEAI_API_BASE ?? "http://127.0.0.1:5555").replace(/\/$/, "");
const SECRET = process.env.KOBEVISION_SHARED_SECRET ?? "";
const WORKER_ID = process.env.KOBEAI_WORKER_ID ?? "k9-worker-stub";
const BATCH = Math.max(1, Math.min(50, Number(process.env.KOBEAI_WORKER_BATCH ?? 5)));
const POLL_MS = Math.max(500, Number(process.env.KOBEAI_WORKER_POLL_MS ?? 4000));

if (!SECRET) {
  console.error("[k9-worker] KOBEVISION_SHARED_SECRET is required");
  process.exit(2);
}

async function api(path, init = {}) {
  const res = await fetch(`${API_BASE}/api${path}`, {
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
    throw new Error(`HTTP ${res.status} at ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * The stub reasoner. Real workers replace this body.
 * Returns a Record<string, unknown> which is stored on the request as
 * `response`.
 */
function handle(request) {
  const q = String(request.question ?? "").toLowerCase();
  const ctx = request.context ?? {};
  const generator = "k9-worker-stub";

  // Lens paper OCR.
  if (q.includes("ocr") && q.includes("paper")) {
    return {
      ok: false,
      generator,
      note:
        "Paper OCR requires the real Youtu-VL worker. The lens accepted the frame; " +
        "the teacher can still fill items manually and submit /paper-graded.",
    };
  }

  // Face lookup.
  if (q.includes("face") || q.includes("recognise the closest") || q.includes("student_code")) {
    return {
      ok: false,
      generator,
      note:
        "Face recognition requires the real SCRFD + ArcFace worker. " +
        "Lens client falls back to student-code entry.",
    };
  }

  // Presence / wrong_location scene analysis.
  if (
    q.includes("student appears to be doing") ||
    (ctx.reason && String(ctx.reason).includes("live_mismatch"))
  ) {
    return {
      generator,
      description:
        "Student appears to be at a different zone from the timetable expectation. " +
        "Insufficient signal for a specific activity classification without the on-prem VLM.",
      confidence: 0.15,
    };
  }

  // Curated notes / remediation plan.
  if (q.includes("remediation") || (ctx.reason && String(ctx.reason).includes("paper_grading_pattern"))) {
    const topic = ctx.topic ?? "the topic";
    const wrong = ctx.wrong_count ?? 1;
    return {
      generator,
      plan: [
        `Revise the definition of ${topic} using a Tanzanian example the student already relates to.`,
        `Work through 3 practice problems together, moving from concrete to abstract.`,
        `Assign 5 similar questions on ${topic} in the next home reading; grade them and hand out a curated note.`,
      ],
      note: `Rule-based plan — student had ${wrong} wrong on ${topic}.`,
    };
  }

  return {
    generator,
    note: "Stub worker acknowledged the request. No task-specific reasoner matched.",
  };
}

async function drain() {
  const claimed = await api(`/v1/vision/analyze/pending?worker=${encodeURIComponent(WORKER_ID)}&limit=${BATCH}`);
  const requests = claimed?.requests ?? [];
  if (requests.length === 0) return 0;
  for (const r of requests) {
    let response;
    let ok = true;
    try {
      response = handle(r);
      if (response && typeof response === "object" && "ok" in response && response.ok === false) ok = false;
    } catch (err) {
      ok = false;
      response = { error: err instanceof Error ? err.message : String(err) };
    }
    try {
      await api(`/v1/vision/analyze/${r.id}/complete`, {
        method: "POST",
        body: JSON.stringify({ ok, response, worker: WORKER_ID }),
      });
      console.log(`[k9-worker] ${ok ? "completed" : "failed"} request ${r.id} (${r.question.slice(0, 60)}…)`);
    } catch (err) {
      console.warn(`[k9-worker] couldn't complete ${r.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return requests.length;
}

async function main() {
  console.log(`[k9-worker] draining ${API_BASE} as ${WORKER_ID} (batch=${BATCH}, poll=${POLL_MS}ms)`);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  // Loop forever; harmless if nothing pending — the API responds 204.
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
