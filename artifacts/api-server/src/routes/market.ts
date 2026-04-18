import { Router } from "express";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  db,
  marketQuestionsTable,
  questionLocksTable,
  kpLedgerTable,
  studentKpTable,
  usersTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { drainPendingGrants } from "../lib/kp";

const router = Router();

router.use("/v1/watch/market", requireAuth(["student"]));

const LOCK_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const LOCK_KP_COST = 10;

/**
 * Resolve the calling student's user_id, ensure a student_kp row exists,
 * and drain any kp_pending_grants that were parked while the user row
 * didn't yet exist. Drain runs in a single transaction with `FOR UPDATE
 * SKIP LOCKED` so two concurrent calls can't double-credit the same
 * pending row.
 */
async function resolveStudent(req: any): Promise<{ user_id: number; balance: number } | null> {
  const studentCode = req.auth?.student_id;
  if (!studentCode) return null;
  const user = (
    await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.student_code, studentCode))
      .limit(1)
  )[0];
  if (!user) return null;
  // Upsert balance row.
  await db
    .insert(studentKpTable)
    .values({ user_id: user.id, balance: 0 })
    .onConflictDoNothing();
  // Drain any pending grants parked while the student was unprovisioned.
  await drainPendingGrants(studentCode);

  const bal = (
    await db
      .select({ balance: studentKpTable.balance })
      .from(studentKpTable)
      .where(eq(studentKpTable.user_id, user.id))
      .limit(1)
  )[0];
  return { user_id: user.id, balance: bal?.balance ?? 0 };
}

/**
 * GET /v1/watch/market/me
 * Returns the calling student's KP balance and the last 20 ledger entries.
 */
router.get("/v1/watch/market/me", async (req, res) => {
  const me = await resolveStudent(req);
  if (!me) return void res.status(401).json({ error: "no student" });
  const ledger = await db
    .select()
    .from(kpLedgerTable)
    .where(eq(kpLedgerTable.user_id, me.user_id))
    .orderBy(desc(kpLedgerTable.created_at))
    .limit(20);
  res.json({ balance: me.balance, ledger });
});

/**
 * GET /v1/watch/market/questions
 * Lists open + locked questions (locked ones still visible so others can see
 * what's being worked on), with the active lock's owner + expiry attached.
 */
router.get("/v1/watch/market/questions", async (_req, res) => {
  const rows = await db
    .select({
      q: marketQuestionsTable,
      lock_id: questionLocksTable.id,
      lock_owner: questionLocksTable.student_id,
      lock_expires_at: questionLocksTable.expires_at,
    })
    .from(marketQuestionsTable)
    .leftJoin(
      questionLocksTable,
      and(
        eq(questionLocksTable.question_id, marketQuestionsTable.id),
        isNull(questionLocksTable.released_at),
      ),
    )
    .where(sql`${marketQuestionsTable.status} IN ('open', 'locked')`)
    .orderBy(desc(marketQuestionsTable.released_at))
    .limit(50);
  const now = new Date();
  res.json({
    questions: rows.map((r) => {
      // A lock row only counts as "active" for clients when it has not been
      // released AND its deadline is still in the future. Expired-but-not-
      // released rows are stale and will be cleaned up on the next mutating
      // call against this question.
      const lockActive =
        r.lock_id != null && r.lock_expires_at != null && r.lock_expires_at > now;
      return {
        id: r.q.id,
        subject: r.q.subject,
        prompt: r.q.prompt,
        choices: r.q.choices,
        kp_reward: r.q.kp_reward,
        status: lockActive ? r.q.status : "open",
        lock: lockActive
          ? { owner_user_id: r.lock_owner, expires_at: r.lock_expires_at }
          : null,
      };
    }),
  });
});

/**
 * POST /v1/watch/market/questions/:id/lock
 * Buy an exclusive 5-minute lock on a question. Costs LOCK_KP_COST KP.
 * - 404 if question not found
 * - 409 if not 'open' or another active lock exists
 * - 402 if balance < cost
 */
router.post("/v1/watch/market/questions/:id/lock", async (req, res) => {
  const me = await resolveStudent(req);
  if (!me) return void res.status(401).json({ error: "no student" });
  const qid = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(qid)) return void res.status(400).json({ error: "bad id" });

  if (me.balance < LOCK_KP_COST) {
    return void res.status(402).json({ error: "insufficient_kp", balance: me.balance, cost: LOCK_KP_COST });
  }

  try {
    const result = await db.transaction(async (tx) => {
      const now = new Date();
      // Self-heal: any lock whose expires_at has passed but never got
      // released (locker never answered, just walked away) blocks this
      // question via the unique partial index. Release it now and reopen
      // the question so the new lock attempt can succeed.
      const stale = await tx
        .update(questionLocksTable)
        .set({ released_at: now })
        .where(
          and(
            eq(questionLocksTable.question_id, qid),
            isNull(questionLocksTable.released_at),
            sql`${questionLocksTable.expires_at} <= ${now}`,
          ),
        )
        .returning({ id: questionLocksTable.id });
      if (stale.length > 0) {
        await tx
          .update(marketQuestionsTable)
          .set({ status: "open" })
          .where(
            and(
              eq(marketQuestionsTable.id, qid),
              eq(marketQuestionsTable.status, "locked"),
            ),
          );
      }
      // Atomic CAS: only flip 'open' → 'locked'.
      const flipped = await tx
        .update(marketQuestionsTable)
        .set({ status: "locked" })
        .where(and(eq(marketQuestionsTable.id, qid), eq(marketQuestionsTable.status, "open")))
        .returning({ id: marketQuestionsTable.id, kp_reward: marketQuestionsTable.kp_reward });
      if (flipped.length === 0) {
        const exists = await tx
          .select({ id: marketQuestionsTable.id })
          .from(marketQuestionsTable)
          .where(eq(marketQuestionsTable.id, qid))
          .limit(1);
        return { kind: exists.length ? "conflict" : "notfound" } as const;
      }

      // Re-check balance under transaction; deduct.
      const balRow = (
        await tx
          .select({ balance: studentKpTable.balance })
          .from(studentKpTable)
          .where(eq(studentKpTable.user_id, me.user_id))
          .for("update")
          .limit(1)
      )[0];
      const balance = balRow?.balance ?? 0;
      if (balance < LOCK_KP_COST) {
        // Roll back the status flip.
        throw new Error("INSUFFICIENT_KP");
      }
      const newBalance = balance - LOCK_KP_COST;
      await tx
        .update(studentKpTable)
        .set({ balance: newBalance, updated_at: new Date() })
        .where(eq(studentKpTable.user_id, me.user_id));
      await tx.insert(kpLedgerTable).values({
        user_id: me.user_id,
        delta: -LOCK_KP_COST,
        reason: "lock_purchase",
        question_id: qid,
        balance_after: newBalance,
      });
      const expiresAt = new Date(Date.now() + LOCK_DURATION_MS);
      const lock = (
        await tx
          .insert(questionLocksTable)
          .values({
            question_id: qid,
            student_id: me.user_id,
            kp_cost: LOCK_KP_COST,
            expires_at: expiresAt,
          })
          .returning()
      )[0];
      return { kind: "ok", lock, new_balance: newBalance } as const;
    });
    if (result.kind === "notfound") return void res.status(404).json({ error: "not_found" });
    if (result.kind === "conflict") return void res.status(409).json({ error: "not_open" });
    res.json({ ok: true, lock: result.lock, new_balance: result.new_balance });
  } catch (e: any) {
    if (e?.message === "INSUFFICIENT_KP") {
      return void res.status(402).json({ error: "insufficient_kp" });
    }
    // Unique-index violation = race lost.
    if (String(e?.code) === "23505") {
      return void res.status(409).json({ error: "already_locked" });
    }
    console.error("[market] lock failed", e);
    res.status(500).json({ error: "lock_failed" });
  }
});

/**
 * POST /v1/watch/market/questions/:id/answer
 * Body: { choice_index: number }
 * Rules:
 *  - Question must be 'open' or 'locked'.
 *  - If 'locked' and the active lock is held by another student (and not
 *    expired), reject 423.
 *  - Correct answer: question → 'won', award kp_reward, release any lock.
 *  - Wrong answer by lock owner: release the lock so others can compete.
 *  - Wrong answer by anyone else on an open question: just record nothing.
 */
router.post("/v1/watch/market/questions/:id/answer", async (req, res) => {
  const me = await resolveStudent(req);
  if (!me) return void res.status(401).json({ error: "no student" });
  const qid = Number.parseInt(req.params.id, 10);
  const choice = Number(req.body?.choice_index);
  if (!Number.isFinite(qid) || !Number.isInteger(choice)) {
    return void res.status(400).json({ error: "bad input" });
  }

  try {
    const result = await db.transaction(async (tx) => {
      const q = (
        await tx
          .select()
          .from(marketQuestionsTable)
          .where(eq(marketQuestionsTable.id, qid))
          .for("update")
          .limit(1)
      )[0];
      if (!q) return { kind: "notfound" } as const;
      if (q.status === "won") return { kind: "already_won" } as const;
      if (q.status === "expired") return { kind: "expired" } as const;

      const now = new Date();
      // Check active lock (released_at IS NULL AND expires_at > now).
      const activeLock = (
        await tx
          .select()
          .from(questionLocksTable)
          .where(
            and(
              eq(questionLocksTable.question_id, qid),
              isNull(questionLocksTable.released_at),
            ),
          )
          .for("update")
          .limit(1)
      )[0];
      const lockHeldByOther =
        activeLock &&
        activeLock.expires_at > now &&
        activeLock.student_id !== me.user_id;
      if (lockHeldByOther) return { kind: "locked_by_other" } as const;

      // If lock exists but expired, release it now (no refund — rent paid).
      if (activeLock && activeLock.expires_at <= now) {
        await tx
          .update(questionLocksTable)
          .set({ released_at: now })
          .where(eq(questionLocksTable.id, activeLock.id));
        if (q.status === "locked") {
          await tx
            .update(marketQuestionsTable)
            .set({ status: "open" })
            .where(eq(marketQuestionsTable.id, qid));
          q.status = "open";
        }
      }

      const correct = choice === q.correct_index;

      if (!correct) {
        // Wrong answer from the lock owner releases the lock.
        if (activeLock && activeLock.student_id === me.user_id && !activeLock.released_at) {
          await tx
            .update(questionLocksTable)
            .set({ released_at: now })
            .where(eq(questionLocksTable.id, activeLock.id));
          await tx
            .update(marketQuestionsTable)
            .set({ status: "open" })
            .where(eq(marketQuestionsTable.id, qid));
        }
        return { kind: "wrong" } as const;
      }

      // Correct: award KP, release any lock, mark question won.
      const balRow = (
        await tx
          .select({ balance: studentKpTable.balance })
          .from(studentKpTable)
          .where(eq(studentKpTable.user_id, me.user_id))
          .for("update")
          .limit(1)
      )[0];
      const newBalance = (balRow?.balance ?? 0) + q.kp_reward;
      await tx
        .insert(studentKpTable)
        .values({ user_id: me.user_id, balance: newBalance })
        .onConflictDoUpdate({
          target: studentKpTable.user_id,
          set: { balance: newBalance, updated_at: now },
        });
      await tx.insert(kpLedgerTable).values({
        user_id: me.user_id,
        delta: q.kp_reward,
        reason: "question_won",
        question_id: qid,
        balance_after: newBalance,
      });
      // Atomic CAS so two concurrent correct submits can't both win.
      const wonRows = await tx
        .update(marketQuestionsTable)
        .set({ status: "won", won_by_user_id: me.user_id, won_at: now })
        .where(
          and(
            eq(marketQuestionsTable.id, qid),
            sql`${marketQuestionsTable.status} IN ('open', 'locked')`,
          ),
        )
        .returning({ id: marketQuestionsTable.id });
      if (wonRows.length === 0) {
        // Lost the race — roll back by throwing.
        throw new Error("RACE_LOST");
      }
      if (activeLock && !activeLock.released_at) {
        await tx
          .update(questionLocksTable)
          .set({ released_at: now })
          .where(eq(questionLocksTable.id, activeLock.id));
      }
      return { kind: "won", new_balance: newBalance, kp_awarded: q.kp_reward } as const;
    });

    switch (result.kind) {
      case "notfound":
        return void res.status(404).json({ error: "not_found" });
      case "already_won":
        return void res.status(409).json({ error: "already_won" });
      case "expired":
        return void res.status(409).json({ error: "expired" });
      case "locked_by_other":
        return void res.status(423).json({ error: "locked_by_other" });
      case "wrong":
        return void res.json({ ok: true, correct: false });
      case "won":
        return void res.json({
          ok: true,
          correct: true,
          kp_awarded: result.kp_awarded,
          new_balance: result.new_balance,
        });
    }
  } catch (e: any) {
    if (e?.message === "RACE_LOST") {
      return void res.status(409).json({ error: "race_lost" });
    }
    console.error("[market] answer failed", e);
    res.status(500).json({ error: "answer_failed" });
  }
});

export default router;
