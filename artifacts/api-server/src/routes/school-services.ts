import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { ensureLearningPacks, transaction } from "../lib/learning-packs";
const router = Router();
router.use(
  "/v1/parent/school-services",
  requireAuth(["parent"]),
  async (_req, _res, next) => {
    try {
      await ensureLearningPacks();
      next();
    } catch (e) {
      next(e);
    }
  },
);
async function own(parent: number, student: number) {
  return (
    (
      await pool.query(
        "SELECT student_user_id FROM parent_children WHERE parent_user_id=$1 AND student_user_id=$2",
        [parent, student],
      )
    ).rows.length > 0
  );
}
router.get("/v1/parent/school-services", async (req, res) => {
  const students = await pool.query(
    `SELECT u.id,u.name,u.student_code,u.grade,a.monthly_limit_tsh,COALESCE(a.automatic_enabled,TRUE) AS automatic_enabled,
    COALESCE(c.balance_tsh,0) AS printing_funds_tsh,COALESCE(c.reserved_tsh,0) AS reserved_tsh
    FROM parent_children pc JOIN users u ON u.id=pc.student_user_id LEFT JOIN print_allowances a ON a.student_id=u.id LEFT JOIN print_cash_accounts c ON c.student_id=u.id WHERE pc.parent_user_id=$1`,
    [req.auth!.user_id],
  );
  const packs = await pool.query(
    `SELECT p.id,p.student_id,p.exam_id,p.kind,p.status,p.cost_tsh,p.sides,p.hold_reason,p.created_at,p.printed_at,p.collected_at,e.subject,e.title
    FROM learning_packs p JOIN parent_children pc ON pc.student_user_id=p.student_id JOIN result_exams e ON e.id=p.exam_id WHERE pc.parent_user_id=$1 ORDER BY p.id DESC LIMIT 200`,
    [req.auth!.user_id],
  );
  const settings = (
    await pool.query(
      "SELECT price_per_side FROM learning_pack_settings WHERE id=1",
    )
  ).rows[0];
  res.json({
    students: students.rows,
    packs: packs.rows,
    extended_cost_tsh: settings.price_per_side * 6,
    wallet_connected: false,
  });
});
router.post(
  "/v1/parent/school-services/:studentId/allowance",
  async (req, res) => {
    const student = Number(req.params.studentId),
      limit = req.body?.monthly_limit_tsh,
      enabled = req.body?.automatic_enabled;
    if (
      !Number.isSafeInteger(student) ||
      !(await own(req.auth!.user_id, student))
    ) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    if (
      (limit !== null &&
        (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000000)) ||
      typeof enabled !== "boolean"
    ) {
      res.status(400).json({ error: "Invalid monthly printing limit" });
      return;
    }
    await transaction(async (q) => {
      // Lock unsent jobs before the account, matching reserve/claim lock order.
      const queued = await q.query(
        "SELECT id,cost_tsh FROM learning_packs WHERE student_id=$1 AND status='queued' ORDER BY id FOR UPDATE",
        [student],
      );
      await q.query(
        "INSERT INTO print_cash_accounts(student_id) VALUES($1) ON CONFLICT DO NOTHING",
        [student],
      );
      await q.query(
        "SELECT student_id FROM print_cash_accounts WHERE student_id=$1 FOR UPDATE",
        [student],
      );
      await q.query(
        `INSERT INTO print_allowances(student_id,monthly_limit_tsh,automatic_enabled,updated_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(student_id) DO UPDATE SET monthly_limit_tsh=$2,automatic_enabled=$3,updated_by=$4,updated_at=NOW()`,
        [student, limit, enabled, req.auth!.user_id],
      );
      // Release unsent work; worker evaluates every pack against the new limit. Already claimed output cannot be recalled.
      const released = queued.rows.reduce((n, p) => n + p.cost_tsh, 0);
      if (released)
        await q.query(
          "UPDATE print_cash_accounts SET reserved_tsh=reserved_tsh-$2 WHERE student_id=$1",
          [student, released],
        );
      if (queued.rows.length)
        await q.query(
          "UPDATE learning_packs SET status='ready',hold_reason='Allowance changed' WHERE id=ANY($1::int[])",
          [queued.rows.map((p) => p.id)],
        );
    });
    res.json({
      ok: true,
      message:
        "Applies to unsent and future printing. Jobs already with the printer may complete.",
    });
  },
);
router.post(
  "/v1/parent/school-services/packs/:id/extended",
  async (req, res) => {
    const {
      rows: [p],
    } = await pool.query(
      "SELECT p.* FROM learning_packs p JOIN parent_children pc ON pc.student_user_id=p.student_id WHERE p.id=$1 AND pc.parent_user_id=$2",
      [Number(req.params.id), req.auth!.user_id],
    );
    if (!p) {
      res.status(404).json({ error: "Pack not found" });
      return;
    }
    const {
      rows: [s],
    } = await pool.query(
      "SELECT price_per_side FROM learning_pack_settings WHERE id=1",
    );
    const cost = s.price_per_side * 6;
    if (req.body?.accepted_cost_tsh !== cost) {
      res
        .status(409)
        .json({ error: "Confirm the current printing price", cost_tsh: cost });
      return;
    }
    await pool.query(
      "INSERT INTO learning_packs(exam_id,student_id,kind,sides,cost_tsh) VALUES($1,$2,'extended',6,$3) ON CONFLICT DO NOTHING",
      [p.exam_id, p.student_id, cost],
    );
    res.status(202).json({ ok: true, cost_tsh: cost });
  },
);
export default router;
