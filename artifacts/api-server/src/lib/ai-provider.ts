import { logger } from "./logger";

export type AskResult = {
  answer: string;
  model: string;
  provider: string;
};

const CANNED_ANSWERS: Record<string, string> = {
  photosynthesis:
    "Photosynthesis is the process by which plants use sunlight, water, and carbon dioxide to produce oxygen and energy in the form of sugar. It happens mainly in the leaves.",
  "mount kilimanjaro":
    "Mount Kilimanjaro is the tallest mountain in Africa at 5,895 meters above sea level. It is located in Tanzania near the Kenyan border.",
  "capital of tanzania":
    "Dodoma is the official capital city of Tanzania. However, Dar es Salaam remains the largest city and commercial hub.",
  "2+2": "2 + 2 = 4",
  pythagoras:
    "The Pythagorean theorem states that in a right triangle, the square of the hypotenuse equals the sum of squares of the other two sides: a² + b² = c².",
  "history of tanzania":
    "Tanzania was formed in 1964 through the union of Tanganyika and Zanzibar. It gained independence from British rule in 1961. Julius Nyerere was the first president and championed pan-Africanism.",
  "water cycle":
    "The water cycle (hydrological cycle) describes the continuous movement of water: evaporation from oceans, condensation into clouds, precipitation as rain or snow, and collection in rivers and oceans.",
  cell:
    "The cell is the basic unit of life. There are two types: prokaryotic (no nucleus, like bacteria) and eukaryotic (with nucleus, like plant and animal cells).",
};

const FALLBACK =
  "That is a great question! I am here to help you learn. Ask me about mathematics, science, Tanzanian history, or any school subject.";

const SYSTEM_PROMPT =
  "You are KobeAI, a friendly tutor for Tanzanian school students aged 8-18. " +
  "Answer in clear, simple English (or Swahili if the question is in Swahili). " +
  "Keep answers under 80 words. Use examples relevant to Tanzania when possible. " +
  "If asked about something inappropriate, gently redirect to schoolwork.";

function cannedAnswer(question: string): string {
  const q = question.toLowerCase();
  for (const [key, val] of Object.entries(CANNED_ANSWERS)) {
    if (q.includes(key)) return val;
  }
  return FALLBACK;
}

async function askOllama(question: string): Promise<AskResult> {
  const baseUrl = process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434";
  const model = process.env["OLLAMA_MODEL"] ?? "mistral:7b";
  const timeoutMs = Number(process.env["OLLAMA_TIMEOUT_MS"] ?? 30000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        prompt: question,
        system: SYSTEM_PROMPT,
        stream: false,
        options: { temperature: 0.4, num_predict: 200 },
      }),
    });

    if (!resp.ok) {
      throw new Error(`Ollama HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as { response?: string };
    const answer = data.response?.trim();
    if (!answer) throw new Error("Empty Ollama response");
    return { answer, model, provider: "ollama" };
  } finally {
    clearTimeout(timer);
  }
}

export async function askAI(question: string): Promise<AskResult> {
  const provider = (process.env["AI_PROVIDER"] ?? "canned").toLowerCase();

  if (provider === "ollama") {
    try {
      return await askOllama(question);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Ollama call failed; falling back to canned answer",
      );
      return {
        answer: cannedAnswer(question),
        model: "canned-fallback",
        provider: "canned",
      };
    }
  }

  return {
    answer: cannedAnswer(question),
    model: "canned",
    provider: "canned",
  };
}
