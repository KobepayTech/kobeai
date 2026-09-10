import { askAI } from "./ai-provider";
import { logger } from "./logger";

// One shared entry point every generator in the tree calls. Today it
// wraps askAI() (which already knows how to talk to on-prem Ollama and
// falls back to canned answers). Rule-based templates keep firing when
// AI_PROVIDER is not "ollama" or when OLLAMA_ENABLE_GENERATION is not
// explicitly set to "1" — that gate lets an operator keep Ollama running
// for the watch-tutor path without paying LLM cost on every paper mark.

const AI_PROVIDER = () => (process.env["AI_PROVIDER"] ?? "canned").toLowerCase();
const GEN_FLAG = () => (process.env["OLLAMA_ENABLE_GENERATION"] ?? "0") === "1";

export function llmGenerationEnabled(): boolean {
  return AI_PROVIDER() === "ollama" && GEN_FLAG();
}

export type KobeAskOptions = {
  /**
   * Short human-facing tag used only for logging + Ollama's `system`
   * override, so a bad output can be traced back to which caller wrote
   * it. Example: "curated-note:v1", "retest-question:v1", "lesson-plan:v1".
   */
  tag: string;
  /** Additional system prompt appended to KobeAI's default. */
  system?: string;
  /** Max chars we'll accept back from the LLM. Truncate longer output. */
  maxChars?: number;
};

/**
 * Ask KobeAI for a piece of generated text. Returns `null` on any
 * failure — callers must have a rule-based fallback ready. Never throws.
 */
export async function askKobe(prompt: string, opts: KobeAskOptions): Promise<string | null> {
  if (!llmGenerationEnabled()) return null;
  const maxChars = opts.maxChars ?? 2000;
  try {
    const started = Date.now();
    const result = await askAI(prompt, opts.system);
    const answer = (result?.answer ?? "").trim();
    if (!answer) return null;
    logger.info(
      { tag: opts.tag, chars: answer.length, ms: Date.now() - started, model: result.model },
      "kobe-llm generation ok",
    );
    if (answer.length > maxChars) return answer.slice(0, maxChars).trim() + "…";
    return answer;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), tag: opts.tag },
      "kobe-llm generation failed",
    );
    return null;
  }
}
