import { Router } from "express";
import { AskQuestionBody } from "@workspace/api-zod";

const router = Router();

const AI_ANSWERS: Record<string, string> = {
  photosynthesis: "Photosynthesis is the process by which plants use sunlight, water, and carbon dioxide to produce oxygen and energy in the form of sugar. It happens mainly in the leaves.",
  "mount kilimanjaro": "Mount Kilimanjaro is the tallest mountain in Africa at 5,895 meters above sea level. It is located in Tanzania near the Kenyan border.",
  "capital of tanzania": "Dodoma is the official capital city of Tanzania. However, Dar es Salaam remains the largest city and commercial hub.",
  "2+2": "2 + 2 = 4",
  "pythagoras": "The Pythagorean theorem states that in a right triangle, the square of the hypotenuse equals the sum of squares of the other two sides: a² + b² = c².",
  "history of tanzania": "Tanzania was formed in 1964 through the union of Tanganyika and Zanzibar. It gained independence from British rule in 1961. Julius Nyerere was the first president and championed pan-Africanism.",
  "water cycle": "The water cycle (hydrological cycle) describes the continuous movement of water: evaporation from oceans, condensation into clouds, precipitation as rain or snow, and collection in rivers and oceans.",
  "cell": "The cell is the basic unit of life. There are two types: prokaryotic (no nucleus, like bacteria) and eukaryotic (with nucleus, like plant and animal cells).",
};

router.post("/v1/watch/ask", (req, res) => {
  const parsed = AskQuestionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { question } = parsed.data;
  const questionLower = question.toLowerCase();

  let answer = "That is a great question! I am here to help you learn. Ask me about mathematics, science, Tanzanian history, or any school subject.";
  for (const [key, val] of Object.entries(AI_ANSWERS)) {
    if (questionLower.includes(key)) {
      answer = val;
      break;
    }
  }

  res.json({
    answer,
    points_earned: 10,
    new_balance: 5010,
    follow_up_suggestions: [
      "Can you explain more?",
      "Give me a practice question",
      "How does this relate to real life?",
    ],
    conversation_id: `conv_${Date.now()}`,
    model_used: "mistral:7b",
  });
});

router.post("/v1/watch/attendance/checkin", (_req, res) => {
  res.json({
    success: true,
    message: "Checked in successfully! +20 points added.",
    points_earned: 20,
    check_in_time: new Date().toISOString(),
    already_checked_in: false,
    new_balance: 5020,
  });
});

export default router;
