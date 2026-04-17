import { Router } from "express";
import { AddDepositBody } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";

const router = Router();

/**
 * GET /v1/bursar/subscription-payments
 * Lists subscription M-Pesa collections for THIS school. Reads from the
 * central server using the school's tenant license key.
 *
 * The bursar uses this to reconcile incoming parent payments and to see
 * which subscriptions just renewed.
 *
 * AUTH: locked down to teacher/admin staff only — payment rows contain
 * parent phone numbers and M-Pesa receipts (PII). The other bursar demo
 * endpoints below are intentionally left unauthed for the demo, but the
 * payments feed is real PII so it gets explicit auth.
 */
router.get("/v1/bursar/subscription-payments", requireAuth(["admin", "teacher", "super_admin"]), async (_req, res) => {
  const base = process.env["CENTRAL_BASE_URL"] ?? "";
  const key = process.env["TENANT_LICENSE_KEY"] ?? "";
  if (!base || !key) {
    res.json({ payments: [], summary: { total_count: 0, success_count: 0, pending_count: 0, failed_count: 0, collected_tsh: 0 } });
    return;
  }
  try {
    const upstream = await fetch(`${base}/api/central/v1/payments?limit=50`, {
      headers: { "x-tenant-license-key": key },
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) {
      res.status(502).json({ error: `Central returned ${upstream.status}` });
      return;
    }
    const body = await upstream.json();
    res.json(body);
  } catch (err) {
    logger.warn({ err }, "bursar subscription-payments fetch failed");
    res.status(502).json({ error: "Central unreachable" });
  }
});

const AI_QUESTION_COST = 50;
const QUIZ_COST = 100;

type StudentSpend = {
  id: string;
  student_id: string;
  name: string;
  grade: string;
  total_deposited: number;
  questions_count: number;
  quizzes_count: number;
  status: string;
};

const STUDENTS: StudentSpend[] = [
  { id: "1", student_id: "DSS001", name: "Amina Hassan", grade: "Form 1", total_deposited: 80000, questions_count: 412, quizzes_count: 73, status: "healthy" },
  { id: "2", student_id: "DSS002", name: "Brian Mwenda", grade: "Form 2", total_deposited: 25000, questions_count: 358, quizzes_count: 53, status: "low" },
  { id: "3", student_id: "DSS003", name: "Fatuma Ali", grade: "Form 1", total_deposited: 60000, questions_count: 264, quizzes_count: 86, status: "healthy" },
  { id: "4", student_id: "DSS004", name: "James Oloo", grade: "Form 3", total_deposited: 15000, questions_count: 161, quizzes_count: 24, status: "medium" },
  { id: "5", student_id: "DSS005", name: "Neema Kibwe", grade: "Form 2", total_deposited: 95000, questions_count: 380, quizzes_count: 90, status: "healthy" },
  { id: "6", student_id: "DSS006", name: "Omar Suleiman", grade: "Form 4", total_deposited: 10000, questions_count: 124, quizzes_count: 30, status: "low" },
  { id: "7", student_id: "DSS007", name: "Pendo Makame", grade: "Form 1", total_deposited: 45000, questions_count: 248, quizzes_count: 35, status: "medium" },
  { id: "8", student_id: "DSS008", name: "Rashidi Juma", grade: "Form 3", total_deposited: 30000, questions_count: 230, quizzes_count: 65, status: "medium" },
];

function buildBalances() {
  return STUDENTS.map((s) => {
    const ai_questions_spend = s.questions_count * AI_QUESTION_COST;
    const quiz_spend = s.quizzes_count * QUIZ_COST;
    const total_spent = ai_questions_spend + quiz_spend;
    const balance = s.total_deposited - total_spent;
    return {
      id: s.id,
      student_id: s.student_id,
      name: s.name,
      grade: s.grade,
      balance,
      total_deposited: s.total_deposited,
      total_spent,
      ai_questions_spend,
      quiz_spend,
      questions_count: s.questions_count,
      quizzes_count: s.quizzes_count,
      status: s.status,
    };
  });
}

router.get("/v1/bursar/students/balances", (_req, res) => {
  const students = buildBalances();
  res.json({
    students,
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
  const students = buildBalances();
  const student = students.find((b) => b.student_id === student_id);
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
