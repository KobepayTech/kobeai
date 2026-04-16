import { Router } from "express";

const router = Router();

router.get("/v1/wallet/balance", (_req, res) => {
  res.json({
    balance: 5000,
    total_earned: 15000,
    level: 3,
    daily_earned: 350,
    daily_limit: 500,
    recent_transactions: [
      { id: "1", amount: 20, type: "attendance", description: "Daily attendance check-in", created_at: new Date(Date.now() - 3600000).toISOString() },
      { id: "2", amount: 10, type: "ai_question", description: "Asked about photosynthesis", created_at: new Date(Date.now() - 7200000).toISOString() },
      { id: "3", amount: 25, type: "quiz", description: "Completed Mathematics Basics", created_at: new Date(Date.now() - 10800000).toISOString() },
      { id: "4", amount: 20, type: "attendance", description: "Daily attendance check-in", created_at: new Date(Date.now() - 86400000).toISOString() },
      { id: "5", amount: 10, type: "ai_question", description: "Asked about Tanzania history", created_at: new Date(Date.now() - 90000000).toISOString() },
    ],
  });
});

export default router;
