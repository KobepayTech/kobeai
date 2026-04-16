import { Router } from "express";
import { AddFundsBody } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";

const router = Router();

router.use("/v1/parent", requireAuth(["parent"]));

const CHILDREN = [
  {
    id: "1",
    name: "John Mwangi",
    grade: "Form 1",
    balance: 52000,
    today_points: 85,
    total_points: 3450,
    attendance_streak: 12,
    daily_limit: 5000,
    transactions: [
      { id: "1", amount: 20, type: "attendance", description: "Daily attendance check-in", created_at: new Date(Date.now() - 3600000).toISOString() },
      { id: "2", amount: 10, type: "ai_question", description: "Asked about photosynthesis", created_at: new Date(Date.now() - 7200000).toISOString() },
      { id: "3", amount: 25, type: "quiz", description: "Completed Science Quiz", created_at: new Date(Date.now() - 10800000).toISOString() },
    ],
  },
  {
    id: "2",
    name: "Mary Mwangi",
    grade: "Standard 4",
    balance: 18500,
    today_points: 45,
    total_points: 1820,
    attendance_streak: 7,
    daily_limit: 3000,
    transactions: [
      { id: "4", amount: 20, type: "attendance", description: "Daily attendance check-in", created_at: new Date(Date.now() - 3600000).toISOString() },
      { id: "5", amount: 10, type: "ai_question", description: "Asked about Tanzania history", created_at: new Date(Date.now() - 7200000).toISOString() },
    ],
  },
];

const ACTIVITY: Record<string, { id: string; type: string; description: string; points: number; timestamp: string; subject: string }[]> = {
  "1": [
    { id: "1", type: "attendance", description: "Checked in for school", points: 20, timestamp: new Date(Date.now() - 3600000).toISOString(), subject: "School" },
    { id: "2", type: "ai_question", description: "Asked about photosynthesis", points: 10, timestamp: new Date(Date.now() - 7200000).toISOString(), subject: "Biology" },
    { id: "3", type: "quiz", description: "Completed Science Quiz - Score 80%", points: 25, timestamp: new Date(Date.now() - 10800000).toISOString(), subject: "Science" },
    { id: "4", type: "ai_question", description: "Asked about Pythagorean theorem", points: 10, timestamp: new Date(Date.now() - 14400000).toISOString(), subject: "Mathematics" },
    { id: "5", type: "attendance", description: "Checked in for school", points: 20, timestamp: new Date(Date.now() - 86400000).toISOString(), subject: "School" },
  ],
  "2": [
    { id: "1", type: "attendance", description: "Checked in for school", points: 20, timestamp: new Date(Date.now() - 3600000).toISOString(), subject: "School" },
    { id: "2", type: "ai_question", description: "Asked about Tanzania history", points: 10, timestamp: new Date(Date.now() - 7200000).toISOString(), subject: "History" },
    { id: "3", type: "quiz", description: "Completed Kiswahili Vocabulary", points: 30, timestamp: new Date(Date.now() - 86400000 + 3600000).toISOString(), subject: "Kiswahili" },
  ],
};

router.get("/v1/parent/dashboard", (_req, res) => {
  res.json({
    parent_name: "Grace Mwangi",
    children: CHILDREN.map(({ id, name, grade, balance, today_points, total_points, attendance_streak }) => ({
      id, name, grade, balance, today_points, total_points, attendance_streak,
    })),
  });
});

router.get("/v1/parent/child/:childId/activity", (req, res) => {
  const { childId } = req.params;
  const child = CHILDREN.find((c) => c.id === childId);
  if (!child) {
    res.status(404).json({ error: "Child not found" });
    return;
  }
  res.json({
    child_name: child.name,
    activities: ACTIVITY[childId] ?? [],
  });
});

router.get("/v1/parent/wallet", (_req, res) => {
  const totalBalance = CHILDREN.reduce((sum, c) => sum + c.balance, 0);
  res.json({
    total_balance: totalBalance,
    children: CHILDREN.map(({ id, name, grade, balance, daily_limit, transactions }) => ({
      id, name, grade, balance, daily_limit, transactions,
    })),
  });
});

router.post("/v1/parent/wallet/add-funds", (req, res) => {
  const parsed = AddFundsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { child_id, amount } = parsed.data;
  const child = CHILDREN.find((c) => c.id === child_id);
  const newBalance = (child?.balance ?? 0) + amount;
  res.json({
    success: true,
    new_balance: newBalance,
    message: `Successfully added TSh ${amount.toLocaleString()} to ${child?.name ?? "child"}'s wallet`,
    receipt_id: `RCP-${Date.now()}`,
  });
});

export default router;
