import { Router } from "express";
import { AddDepositBody } from "@workspace/api-zod";

const router = Router();

const BALANCES = [
  { id: "1", student_id: "DSS001", name: "Amina Hassan", grade: "Form 1", balance: 52000, total_deposited: 80000, status: "healthy" },
  { id: "2", student_id: "DSS002", name: "Brian Mwenda", grade: "Form 2", balance: 1800, total_deposited: 25000, status: "low" },
  { id: "3", student_id: "DSS003", name: "Fatuma Ali", grade: "Form 1", balance: 38000, total_deposited: 60000, status: "healthy" },
  { id: "4", student_id: "DSS004", name: "James Oloo", grade: "Form 3", balance: 4500, total_deposited: 15000, status: "medium" },
  { id: "5", student_id: "DSS005", name: "Neema Kibwe", grade: "Form 2", balance: 67000, total_deposited: 95000, status: "healthy" },
  { id: "6", student_id: "DSS006", name: "Omar Suleiman", grade: "Form 4", balance: 800, total_deposited: 10000, status: "low" },
  { id: "7", student_id: "DSS007", name: "Pendo Makame", grade: "Form 1", balance: 29000, total_deposited: 45000, status: "medium" },
  { id: "8", student_id: "DSS008", name: "Rashidi Juma", grade: "Form 3", balance: 12000, total_deposited: 30000, status: "medium" },
];

router.get("/v1/bursar/students/balances", (_req, res) => {
  const totalBalance = BALANCES.reduce((sum, b) => sum + b.balance, 0);
  const lowCount = BALANCES.filter((b) => b.status === "low").length;
  res.json({
    students: BALANCES,
    summary: {
      total_accounts: 1247,
      total_balance: 45892000,
      low_balance_count: 23,
    },
  });
});

router.post("/v1/bursar/deposit", (req, res) => {
  const parsed = AddDepositBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { student_id, amount } = parsed.data;
  const student = BALANCES.find((b) => b.student_id === student_id);
  const newBalance = (student?.balance ?? 0) + amount;
  res.json({
    success: true,
    deposit_id: `dep_${Date.now()}`,
    receipt_number: `RCP-${new Date().toISOString().split("T")[0].replace(/-/g, "")}-${Math.floor(Math.random() * 999).toString().padStart(3, "0")}`,
    new_balance: newBalance,
    message: `Successfully deposited TSh ${amount.toLocaleString()}`,
  });
});

router.get("/v1/bursar/billing/summary", (_req, res) => {
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  res.json({
    period,
    total_ai_questions: 3421,
    total_quizzes: 156,
    ai_cost: 171050,
    quiz_cost: 15600,
    subscription_fee: 6235000,
    total_amount: 6421650,
    status: "pending",
  });
});

export default router;
