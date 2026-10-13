import { listOllamaModels, ollamaHasModel } from "./ai-provider";
import { k9TextModelNames, k9VisionModelNames, loadK9Models } from "./k9-models";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Direct line to K9's brain.
//
// `askKobe()` (lib/kobe-llm.ts) is the short-answer path: one prompt in, a
// paragraph of prose out, 200 tokens, behind the OLLAMA_ENABLE_GENERATION
// gate. Two newer jobs need more than that:
//
//   * the question-market agent has to get back **strict JSON** it can insert
//     into a table, over enough tokens to hold a whole question set;
//   * the paper reader has to send an **image** — a phone photo of a printed
//     class list — and get the text off it.
//
// Both are the same Ollama call with different knobs, so they share this
// module. Ollama's /api/generate takes `images: [<base64>]` for a vision
// model and `format: "json"` to constrain decoding, which is all K9 needs:
// the brain (Qwen3-VL) reads pictures and writes JSON on the same endpoint.
//
// Everything here returns null rather than throwing. A school server that
// lost its GPU box, or never had one, must keep working — every caller has a
// deterministic fallback behind it.
// ---------------------------------------------------------------------------

export type BrainResult = { text: string; model: string };

export type BrainOptions = {
  /** Traceable tag for logs, e.g. "market-agent:generate". */
  tag: string;
  system?: string;
  /** Base64 (no data: prefix) images for a vision model. */
  images?: string[];
  /** Constrain decoding to a JSON object. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

function baseUrl(): string {
  return process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434";
}

/** True when this deploy has an on-prem LLM configured at all. */
export function brainEnabled(): boolean {
  return (process.env["AI_PROVIDER"] ?? "canned").toLowerCase() === "ollama";
}

/**
 * Models to try for a job, best first. Vision jobs need a model that can see;
 * text jobs take anything. Both come from the K9 registry so an operator who
 * swaps the brain in config/k9-models.json doesn't have to touch code.
 */
function candidates(vision: boolean): string[] {
  const pinned = process.env[vision ? "OLLAMA_VISION_MODEL" : "OLLAMA_MODEL"];
  if (pinned) return [pinned];
  try {
    const config = loadK9Models().config;
    const names = vision ? k9VisionModelNames(config) : k9TextModelNames(config);
    if (names.length > 0) return names;
  } catch {
    // No registry on this deploy — fall through to the historical default.
  }
  return vision ? [] : ["mistral:7b"];
}

/** The first candidate Ollama actually has, or null when none of them exist. */
async function resolveModel(vision: boolean): Promise<string | null> {
  const wanted = candidates(vision);
  if (wanted.length === 0) return null;
  if (wanted.length === 1) return wanted[0]!;
  const installed = await listOllamaModels();
  if (installed.length === 0) return wanted[0]!;
  return wanted.find((m) => ollamaHasModel(installed, m)) ?? null;
}

/**
 * One generation against the on-prem brain. Returns null on any failure —
 * unreachable Ollama, no suitable model, empty answer, timeout.
 */
export async function brainGenerate(
  prompt: string,
  opts: BrainOptions,
): Promise<BrainResult | null> {
  if (!brainEnabled()) return null;
  const vision = (opts.images?.length ?? 0) > 0;
  const model = await resolveModel(vision).catch(() => null);
  if (!model) {
    logger.warn({ tag: opts.tag, vision }, "kobe-brain: no suitable model installed");
    return null;
  }
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl()}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      body: JSON.stringify({
        model,
        prompt,
        ...(opts.system ? { system: opts.system } : {}),
        ...(vision ? { images: opts.images } : {}),
        ...(opts.json ? { format: "json" } : {}),
        stream: false,
        options: {
          temperature: opts.temperature ?? 0.6,
          num_predict: opts.maxTokens ?? 1200,
        },
      }),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = (await res.json()) as { response?: string };
    const text = (data.response ?? "").trim();
    if (!text) throw new Error("empty response");
    logger.info(
      { tag: opts.tag, model, chars: text.length, ms: Date.now() - started, vision },
      "kobe-brain ok",
    );
    return { text, model };
  } catch (err) {
    logger.warn(
      { tag: opts.tag, model, err: err instanceof Error ? err.message : String(err) },
      "kobe-brain failed",
    );
    return null;
  }
}

/**
 * Pull the first JSON value out of a model's answer. `format: "json"` makes
 * Ollama emit a bare object, but a model that ignores it tends to wrap the
 * payload in prose or a ```json fence, so we scan for the outermost
 * bracketed run instead of trusting the whole string to parse.
 */
export function parseJsonLoose<T = unknown>(text: string): T | null {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const direct = tryParse<T>(trimmed);
  if (direct !== null) return direct;
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start >= 0 && end > start) {
      const sliced = tryParse<T>(trimmed.slice(start, end + 1));
      if (sliced !== null) return sliced;
    }
  }
  return null;
}

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** Generate and parse in one step. Null when either half fails. */
export async function brainJson<T = unknown>(
  prompt: string,
  opts: BrainOptions,
): Promise<{ value: T; model: string } | null> {
  const out = await brainGenerate(prompt, { ...opts, json: true });
  if (!out) return null;
  const value = parseJsonLoose<T>(out.text);
  if (value === null) {
    logger.warn({ tag: opts.tag, model: out.model }, "kobe-brain: answer was not JSON");
    return null;
  }
  return { value, model: out.model };
}
