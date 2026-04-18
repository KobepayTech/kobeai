import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  kpLedgerTable,
  kpPendingGrantsTable,
  studentKpTable,
  usersTable,
} from "@workspace/db";

/**
 * Drain any unclaimed `kp_pending_grants` rows for the given student_code
 * into the student's ledger + balance. At-most-once per pending row,
 * race-safe under concurrent calls thanks to:
 *   - `FOR UPDATE SKIP LOCKED` on the pending rows (queue-style claiming)
 *   - a `WHERE claimed_at IS NULL` CAS guard on the claim update
 *   - a single transaction wrapping the ledger insert, balance update,
 *     and claim flip — so any partial failure rolls everything back
 *
 * No-op (and cheap, indexed by `kp_pending_student_idx`) when the student
 * has no pending grants. Safe to call from any hot watch endpoint to
 * guarantee eventual delivery without depending on market traffic.
 *
 * Returns the number of pending rows credited.
 */
export async function drainPendingGrants(studentCode: string): Promise<number> {
  // Cheap pre-check on the partial index — most calls return 0 here and
  // skip the transaction overhead entirely.
  const head = await db
    .select({ id: kpPendingGrantsTable.id })
    .from(kpPendingGrantsTable)
    .where(
      and(
        eq(kpPendingGrantsTable.student_code, studentCode),
        isNull(kpPendingGrantsTable.claimed_at),
      ),
    )
    .limit(1);
  if (head.length === 0) return 0;

  const [user] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.student_code, studentCode))
    .limit(1);
  if (!user) return 0;

  // Ensure the balance row exists before we lock it FOR UPDATE.
  await db
    .insert(studentKpTable)
    .values({ user_id: user.id, balance: 0 })
    .onConflictDoNothing();

  return db.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(kpPendingGrantsTable)
      .where(
        and(
          eq(kpPendingGrantsTable.student_code, studentCode),
          isNull(kpPendingGrantsTable.claimed_at),
        ),
      )
      .for("update", { skipLocked: true });
    if (pending.length === 0) return 0;
    const [bal] = await tx
      .select({ balance: studentKpTable.balance })
      .from(studentKpTable)
      .where(eq(studentKpTable.user_id, user.id))
      .for("update")
      .limit(1);
    let balance = bal?.balance ?? 0;
    for (const p of pending) {
      balance += p.delta;
      const [ledgerRow] = await tx
        .insert(kpLedgerTable)
        .values({
          user_id: user.id,
          delta: p.delta,
          reason: p.reason,
          balance_after: balance,
        })
        .returning({ id: kpLedgerTable.id });
      const claimed = await tx
        .update(kpPendingGrantsTable)
        .set({ claimed_at: new Date(), claimed_ledger_id: ledgerRow!.id })
        .where(
          and(
            eq(kpPendingGrantsTable.id, p.id),
            isNull(kpPendingGrantsTable.claimed_at),
          ),
        )
        .returning({ id: kpPendingGrantsTable.id });
      if (claimed.length === 0) {
        // Lost the race against another concurrent drain — roll back so
        // we never credit a pending row twice.
        throw new Error("PENDING_GRANT_RACE");
      }
    }
    await tx
      .update(studentKpTable)
      .set({ balance, updated_at: new Date() })
      .where(eq(studentKpTable.user_id, user.id));
    return pending.length;
  });
}
