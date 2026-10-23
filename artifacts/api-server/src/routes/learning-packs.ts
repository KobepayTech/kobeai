import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pool } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import {
  ensureLearningPacks,
  reservePack,
  settlePack,
  transaction,
} from "../lib/learning-packs";
import { parseLessons, renderPack } from "../lib/learning-pack-content";
const router = Router();
const staff = requireAuth(["teacher", "admin", "super_admin"]);
const office = requireAuth(["admin", "super_admin"]);
const admin = (r: Request) =>
  ["admin", "super_admin"].includes(r.auth?.role ?? "");
function id(v: unknown): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error("Invalid positive integer");
  return n;
}
async function visibleExam(req: Request, examId: number) {
  const {
    rows: [e],
  } = await pool.query(
    "SELECT e.*,c.teacher_id FROM result_exams e JOIN classes c ON c.id=e.class_id WHERE e.id=$1",
    [examId],
  );
  if (!e || (!admin(req) && e.teacher_id !== req.auth?.user_id))
    throw new Error("Exam not accessible");
  return e;
}
async function visiblePack(req: Request, packId: number) {
  const {
    rows: [p],
  } = await pool.query("SELECT * FROM learning_packs WHERE id=$1", [packId]);
  if (!p) throw new Error("Pack not found");
  await visibleExam(req, p.exam_id);
  return p;
}
const run =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await ensureLearningPacks();
      await fn(req, res);
    } catch (e) {
      if (e instanceof Error && !("code" in e))
        res.status(400).json({ error: e.message });
      else next(e);
    }
  };
router.get(
  "/v1/learning-packs",
  staff,
  run(async (req, res) => {
    const packs = await pool.query(
      `SELECT p.id,p.exam_id,p.student_id,p.kind,p.status,p.sides,p.cost_tsh,p.problems,p.hold_reason,p.printer_job_id,u.name,u.student_code,c.grade,e.title,e.subject
    FROM learning_packs p JOIN users u ON u.id=p.student_id JOIN result_exams e ON e.id=p.exam_id JOIN classes c ON c.id=e.class_id
    WHERE ($1::boolean OR c.teacher_id=$2) ORDER BY c.grade,u.name,p.id DESC LIMIT 500`,
      [admin(req), req.auth!.user_id],
    );
    const settings = (await pool.query("SELECT * FROM learning_pack_settings"))
      .rows[0];
    res.json({ packs: packs.rows, settings });
  }),
);
router.post(
  "/v1/learning-packs/exams/:id/complete",
  staff,
  run(async (req, res) => {
    const examId = id(req.params.id);
    await visibleExam(req, examId);
    await transaction(async (q) => {
      await q.query("UPDATE result_exams SET status='closed' WHERE id=$1", [
        examId,
      ]);
      await q.query(
        "INSERT INTO learning_pack_batches(exam_id,requested_by) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [examId, req.auth!.user_id],
      );
    });
    // Durable batch is picked up by the worker, including after a restart.
    res.status(202).json({ status: "scheduled", exam_id: examId });
  }),
);
router.get(
  "/v1/learning-packs/:id",
  staff,
  run(async (req, res) => {
    res.json(await visiblePack(req, id(req.params.id)));
  }),
);
router.get(
  "/v1/learning-packs/:id/pdf",
  staff,
  run(async (req, res) => {
    const p = await visiblePack(req, id(req.params.id));
    if (!p.content) throw new Error("Pack not generated");
    res.type("application/pdf").send(await renderPack(p.content, p.id));
  }),
);
router.post(
  "/v1/learning-packs/:id/review",
  staff,
  run(async (req, res) => {
    const p = await visiblePack(req, id(req.params.id));
    if (p.status !== "review") throw new Error("Pack is not awaiting review");
    if (
      req.body?.evidence_verified !== true ||
      req.body?.answers_verified !== true
    )
      throw new Error(
        "Verify identity, source photos, marks and reference answers first",
      );
    if (!p.content?.proof?.length)
      throw new Error("No evidence; capture the marked paper first");
    const content = {
      ...p.content,
      lessons: parseLessons(
        JSON.stringify(req.body.lessons),
        p.content.proof,
        p.kind === "quick" ? 2 : 6,
      ),
    };
    await renderPack(content, p.id);
    await pool.query(
      "UPDATE learning_packs SET content=$2,status='ready',reviewed_by=$3,reviewed_at=NOW() WHERE id=$1 AND status='review'",
      [p.id, JSON.stringify(content), req.auth!.user_id],
    );
    await reservePack(p.id);
    res.json({ ok: true });
  }),
);
router.post(
  "/v1/learning-packs/:id/extended",
  staff,
  run(async (req, res) => {
    const p = await visiblePack(req, id(req.params.id));
    const {
      rows: [s],
    } = await pool.query("SELECT * FROM learning_pack_settings WHERE id=1");
    const cost = s.price_per_side * 6;
    if (req.body?.accepted_cost_tsh !== cost)
      throw new Error(`Confirm the extended pack price: TZS ${cost}`);
    await pool.query(
      "INSERT INTO learning_packs(exam_id,student_id,kind,sides,cost_tsh) VALUES($1,$2,'extended',6,$3) ON CONFLICT DO NOTHING",
      [p.exam_id, p.student_id, cost],
    );
    res.status(202).json({ cost_tsh: cost });
  }),
);
router.post(
  "/v1/learning-packs/:id/confirm-print",
  office,
  run(async (req, res) => {
    if (typeof req.body?.printed !== "boolean")
      throw new Error("Specify printed true or false");
    await settlePack(id(req.params.id), req.body.printed, req.auth!.user_id);
    res.json({ ok: true });
  }),
);
router.post(
  "/v1/learning-packs/:id/retry",
  office,
  run(async (req, res) => {
    if (req.body?.confirmed_not_printed !== true)
      throw new Error("Check printer output before retrying");
    await pool.query(
      "UPDATE learning_packs SET status='ready',printer_job_id=NULL WHERE id=$1 AND status='failed'",
      [id(req.params.id)],
    );
    await reservePack(id(req.params.id));
    res.json({ ok: true });
  }),
);
router.post(
  "/v1/learning-packs/:id/collect",
  office,
  run(async (req, res) => {
    const result = await pool.query(
      "UPDATE learning_packs SET status='collected',collected_at=NOW() WHERE id=$1 AND status='printed' RETURNING id",
      [id(req.params.id)],
    );
    if (!result.rows.length)
      throw new Error("Pack is not ready for collection");
    res.json({ ok: true });
  }),
);
router.post(
  "/v1/learning-packs/settings",
  office,
  run(async (req, res) => {
    const price = id(req.body?.price_per_side);
    if (
      price > 10000 ||
      typeof req.body?.auto_print !== "boolean" ||
      !/^[-a-zA-Z0-9_]{1,80}$/.test(req.body?.printer_id ?? "")
    )
      throw new Error("Invalid printer settings");
    await pool.query(
      "UPDATE learning_pack_settings SET price_per_side=$1,printer_id=$2,auto_print=$3 WHERE id=1",
      [price, req.body.printer_id, req.body.auto_print],
    );
    res.json({ ok: true });
  }),
);
router.get(
  "/v1/print-cash/accounts",
  office,
  run(async (_req, res) => {
    res.json({
      accounts: (
        await pool.query(
          `SELECT u.id,u.name,u.student_code,COALESCE(a.balance_tsh,0) AS balance_tsh,COALESCE(a.reserved_tsh,0) AS reserved_tsh FROM users u LEFT JOIN print_cash_accounts a ON a.student_id=u.id WHERE u.role='student' ORDER BY u.name`,
        )
      ).rows,
      ledger: (
        await pool.query(
          "SELECT * FROM print_cash_ledger ORDER BY id DESC LIMIT 100",
        )
      ).rows,
    });
  }),
);
router.post(
  "/v1/print-cash/deposits",
  office,
  run(async (req, res) => {
    const student = id(req.body?.student_id),
      amount = id(req.body?.amount_tsh);
    const ref = String(req.body?.receipt ?? "").trim();
    if (amount > 10000000 || !ref || ref.length > 120)
      throw new Error("Receipt and a valid TZS amount are required");
    const result = await transaction(async (q) => {
      const {
        rows: [u],
      } = await q.query("SELECT id FROM users WHERE id=$1 AND role='student'", [
        student,
      ]);
      if (!u) throw new Error("Student not found");
      await q.query(
        "INSERT INTO print_cash_accounts(student_id) VALUES($1) ON CONFLICT DO NOTHING",
        [student],
      );
      await q.query(
        "SELECT * FROM print_cash_accounts WHERE student_id=$1 FOR UPDATE",
        [student],
      );
      const insert = await q.query(
        "INSERT INTO print_cash_ledger(student_id,delta_tsh,reference,recorded_by) VALUES($1,$2,$3,$4) ON CONFLICT(reference) DO NOTHING RETURNING id",
        [student, amount, `deposit:${ref}`, req.auth!.user_id],
      );
      if (!insert.rows.length) {
        const {
          rows: [old],
        } = await q.query(
          "SELECT * FROM print_cash_ledger WHERE reference=$1",
          [`deposit:${ref}`],
        );
        if (old.student_id !== student || old.delta_tsh !== amount)
          throw new Error("Receipt already used for another deposit");
        return { duplicate: true };
      }
      await q.query(
        "UPDATE print_cash_accounts SET balance_tsh=balance_tsh+$2 WHERE student_id=$1",
        [student, amount],
      );
      return { duplicate: false };
    });
    res.json(result);
  }),
);
// Dedicated secret: no permissive development fallback. Agent cannot charge money.
function agent(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.K9_PRINT_AGENT_SECRET;
  const supplied = req.header("x-print-agent-secret");
  if (
    !expected ||
    !supplied ||
    Buffer.byteLength(expected) !== Buffer.byteLength(supplied) ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
  ) {
    res.status(401).json({ error: "Printer authentication failed" });
    return;
  }
  next();
}
router.post(
  "/v1/learning-pack-agent/claim",
  agent,
  run(async (req, res) => {
    const printer = String(req.body?.printer_id ?? "");
    if (!printer) throw new Error("Printer required");
    const job = await transaction(async (q) => {
      const {
        rows: [settings],
      } = await q.query(
        "SELECT auto_print FROM learning_pack_settings WHERE id=1",
      );
      if (!settings.auto_print) return null;
      const expired = await q.query(
        `SELECT p.* FROM learning_packs p JOIN users u ON u.id=p.student_id
      WHERE p.status='queued' AND p.printer_id=$1 AND NOT EXISTS(SELECT 1 FROM subscription_cache s WHERE s.student_code=u.student_code AND s.status='active' AND s.expires_at>NOW())
      ORDER BY p.id FOR UPDATE OF p SKIP LOCKED`,
        [printer],
      );
      for (const p of expired.rows) {
        await q.query(
          "UPDATE print_cash_accounts SET reserved_tsh=reserved_tsh-$2 WHERE student_id=$1",
          [p.student_id, p.cost_tsh],
        );
        await q.query(
          "UPDATE learning_packs SET status='subscription_required' WHERE id=$1",
          [p.id],
        );
      }
      // Recheck subscription at dispatch, not just when queued. Claims are not automatically retried after ambiguous printer failures.
      const {
        rows: [p],
      } = await q.query(
        `SELECT p.* FROM learning_packs p JOIN users u ON u.id=p.student_id JOIN subscription_cache s ON s.student_code=u.student_code
      WHERE p.status='queued' AND p.printer_id=$1 AND s.status='active' AND s.expires_at>NOW() ORDER BY p.id FOR UPDATE OF p SKIP LOCKED LIMIT 1`,
        [printer],
      );
      if (!p) return null;
      const {rows:[account]}=await q.query("SELECT * FROM print_cash_accounts WHERE student_id=$1 FOR UPDATE",[p.student_id]);
      const {rows:[allowance]}=await q.query("SELECT * FROM print_allowances WHERE student_id=$1",[p.student_id]);
      const {rows:[spent]}=await q.query(`SELECT COALESCE(-SUM(delta_tsh),0)::int AS amount FROM print_cash_ledger WHERE student_id=$1 AND pack_id IS NOT NULL AND created_at >= (date_trunc('month',NOW() AT TIME ZONE 'Africa/Dar_es_Salaam') AT TIME ZONE 'Africa/Dar_es_Salaam')`,[p.student_id]);
      if(allowance&&(!allowance.automatic_enabled||(allowance.monthly_limit_tsh!==null&&spent.amount+account.reserved_tsh>allowance.monthly_limit_tsh))){
        await q.query("UPDATE print_cash_accounts SET reserved_tsh=reserved_tsh-$2 WHERE student_id=$1",[p.student_id,p.cost_tsh]);
        await q.query("UPDATE learning_packs SET status='awaiting_funds',hold_reason='Parent printing allowance' WHERE id=$1",[p.id]);
        return null;
      }
      const token = randomUUID();
      await q.query(
        "UPDATE learning_packs SET status='claimed',claim_token=$2 WHERE id=$1",
        [p.id, token],
      );
      return {
        id: p.id,
        claim_token: token,
        sides: p.sides,
        duplex: "two-sided-long-edge",
        paper: "A4",
        copies: 1,
      };
    });
    res.json({ job });
  }),
);
router.get(
  "/v1/learning-pack-agent/:id/pdf",
  agent,
  run(async (req, res) => {
    const {
      rows: [p],
    } = await pool.query(
      "SELECT * FROM learning_packs WHERE id=$1 AND claim_token=$2 AND status='claimed'",
      [id(req.params.id), req.header("x-print-claim") ?? ""],
    );
    if (!p) throw new Error("Invalid claim");
    res.type("application/pdf").send(await renderPack(p.content, p.id));
  }),
);
router.post(
  "/v1/learning-pack-agent/:id/submitted",
  agent,
  run(async (req, res) => {
    const job = String(req.body?.printer_job_id ?? "").slice(0, 120);
    if (!job) throw new Error("Printer job ID required");
    const result = await pool.query(
      "UPDATE learning_packs SET status='submitted',printer_job_id=$3 WHERE id=$1 AND claim_token=$2 AND status IN ('claimed','submitted') RETURNING id",
      [id(req.params.id), req.header("x-print-claim") ?? "", job],
    );
    if (!result.rows.length) throw new Error("Invalid claim");
    res.json({ ok: true });
  }),
);
export default router;
