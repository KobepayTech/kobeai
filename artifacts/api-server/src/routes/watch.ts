import { Router } from "express";
import { AskQuestionBody } from "@workspace/api-zod";
import { askAI } from "../lib/ai-provider";
import { requireAuth } from "../lib/auth";

const router = Router();

router.use("/v1/watch", requireAuth(["student"]));

router.post("/v1/watch/ask", async (req, res) => {
  const parsed = AskQuestionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { question } = parsed.data;

  const { answer, model } = await askAI(question);

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
    model_used: model,
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
