import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  feeAccountsTable,
  feeStructuresTable,
  feeTransactionsTable,
  paymentMatchesTable,
  usersTable,
  type FeeTransaction,
} from "@workspace/db";
import { logger } from "./logger";

// ===========================================================================
// The fee ledger.
//
// Every rule that matters is in this file, and every write to school money
// goes through `post()`. Routes do not touch fee_accounts or
// fee_transactions directly — a second place that knows how to move money is
// a second place that can get the balance wrong.
//
// Invariant: for every student,
//
//     fee_accounts.balance_tsh == SUM(fee_transactions.delta_tsh)
//
// held by taking `SELECT … FOR UPDATE` on the account row and writing both
// the account and the ledger row in one transaction. `verifyLedger()` below
// checks it on demand, and the nightly anomaly watch will read it.
//
// Sign convention: a balance is what the student OWES.
//   charge  +        payment  −        waiver  −
//   reversal takes the opposite sign of the row it undoes.
// ===========================================================================

export type FeeKind = "charge" | "payment" | "waiver" | "reversal";
export type FeeMethod = "mpesa" | "cash" | "bank" | "waiver";

export const FEE_METHODS: FeeMethod[] = ["mpesa", "cash", "bank", "waiver"];

export class FeeError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** Postgres unique-violation, i.e. a duplicate reference or a repeat charge. */
function isUniqueViolation(err: unknown): boolean {
  return String((err as { code?: string })?.code) === "23505";
}

export type PostInput = {
  student_id: number;
  kind: FeeKind;
  /**
   * Always POSITIVE. `post` applies the sign from `kind`, so a caller can
   * never accidentally credit an account by passing a negative charge.
   */
  amount_tsh: number;
  method?: FeeMethod | null;
  reference?: string | null;
  term?: string | null;
  fee_structure_id?: number | null;
  note?: string | null;
  received_at?: Date | null;
  entered_by?: number | null;
  reverses_id?: number | null;
};

function signedDelta(kind: FeeKind, amount: number, reversing?: FeeTransaction | null): number {
  if (kind === "charge") return amount;
  if (kind === "payment" || kind === "waiver") return -amount;
  // A reversal simply undoes the row it points at, whatever that was.
  if (!reversing) throw new FeeError(400, "a reversal must name the transaction it undoes");
  return -reversing.delta_tsh;
}

/**
 * The only way money moves. Runs in its own transaction unless one is passed
 * in, so a caller batching many postings keeps them atomic.
 */
export async function post(
  input: PostInput,
  tx?: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<FeeTransaction> {
  if (!Number.isInteger(input.amount_tsh) || input.amount_tsh <= 0) {
    throw new FeeError(400, "amount_tsh must be a positive whole number of shillings");
  }
  if (input.amount_tsh > 100_000_000) {
    // A hundred million shilling school-fee payment is a typo, every time.
    throw new FeeError(400, "amount_tsh is implausibly large — check the figure");
  }
  const run = async (t: NonNullable<typeof tx>) => {
    let reversing: FeeTransaction | null = null;
    if (input.kind === "reversal") {
      const [row] = await t
        .select()
        .from(feeTransactionsTable)
        .where(eq(feeTransactionsTable.id, input.reverses_id ?? -1))
        .limit(1);
      if (!row) throw new FeeError(404, "the transaction being reversed does not exist");
      if (row.kind === "reversal") throw new FeeError(409, "a reversal cannot itself be reversed");
      const [already] = await t
        .select({ id: feeTransactionsTable.id })
        .from(feeTransactionsTable)
        .where(eq(feeTransactionsTable.reverses_id, row.id))
        .limit(1);
      if (already) throw new FeeError(409, "that transaction has already been reversed");
      if (row.student_id !== input.student_id) {
        throw new FeeError(400, "the reversal must be posted against the same student");
      }
      // The caller states the amount it believes it is undoing. A mismatch
      // means the screen the bursar pressed the button on and the ledger
      // disagree, which is precisely when not to write anything.
      if (input.amount_tsh !== Math.abs(row.delta_tsh)) {
        throw new FeeError(
          409,
          `That transaction is TSh ${Math.abs(row.delta_tsh).toLocaleString()}, not TSh ${input.amount_tsh.toLocaleString()} — reload and try again.`,
        );
      }
      reversing = row;
    }

    // Lock the account for the life of the transaction. Two bursars posting
    // to the same student at once serialise here rather than racing on a
    // read-modify-write of the cached balance.
    await t
      .insert(feeAccountsTable)
      .values({ student_id: input.student_id })
      .onConflictDoNothing();
    const [account] = await t
      .select()
      .from(feeAccountsTable)
      .where(eq(feeAccountsTable.student_id, input.student_id))
      .for("update")
      .limit(1);
    if (!account) throw new FeeError(404, "no fee account for that student");

    const delta = signedDelta(input.kind, input.amount_tsh, reversing);
    const balanceAfter = account.balance_tsh + delta;

    const [row] = await t
      .insert(feeTransactionsTable)
      .values({
        student_id: input.student_id,
        kind: input.kind,
        delta_tsh: delta,
        balance_after_tsh: balanceAfter,
        method: input.method ?? null,
        reference: input.reference?.trim() || null,
        term: input.term ?? null,
        fee_structure_id: input.fee_structure_id ?? null,
        note: input.note ?? null,
        received_at: input.received_at ?? new Date(),
        entered_by: input.entered_by ?? null,
        reverses_id: input.reverses_id ?? null,
      })
      .returning();

    // Keep the running totals in step with the signed history. A reversal
    // unwinds whichever bucket the row it undoes had filled — it is not a
    // charge just because its delta happens to be positive.
    let chargedDelta = 0;
    let paidDelta = 0;
    let waivedDelta = 0;
    if (input.kind === "charge") chargedDelta = input.amount_tsh;
    else if (input.kind === "payment") paidDelta = input.amount_tsh;
    else if (input.kind === "waiver") waivedDelta = input.amount_tsh;
    else if (reversing) {
      const undone = Math.abs(reversing.delta_tsh);
      if (reversing.kind === "charge") chargedDelta = -undone;
      else if (reversing.kind === "payment") paidDelta = -undone;
      else if (reversing.kind === "waiver") waivedDelta = -undone;
    }

    await t
      .update(feeAccountsTable)
      .set({
        charged_tsh: account.charged_tsh + chargedDelta,
        paid_tsh: account.paid_tsh + paidDelta,
        waived_tsh: account.waived_tsh + waivedDelta,
        balance_tsh: balanceAfter,
        last_transaction_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(feeAccountsTable.student_id, input.student_id));

    return row!;
  };

  try {
    return tx ? await run(tx) : await db.transaction(run);
  } catch (err) {
    if (isUniqueViolation(err)) {
      if (input.kind === "payment" && input.reference) {
        throw new FeeError(
          409,
          `Payment ${input.reference} is already on the ledger.`,
          "duplicate_reference",
        );
      }
      throw new FeeError(409, "That charge has already been posted to this student.", "already_charged");
    }
    throw err;
  }
}

/**
 * Charge a fee structure to every student it applies to. Safe to re-run: the
 * partial unique index on (student_id, fee_structure_id) means a student
 * already charged is skipped, not doubled.
 */
export async function chargeStructure(
  structureId: number,
  enteredBy: number | null,
): Promise<{ charged: number; skipped: number; total_tsh: number }> {
  const [structure] = await db
    .select()
    .from(feeStructuresTable)
    .where(eq(feeStructuresTable.id, structureId))
    .limit(1);
  if (!structure) throw new FeeError(404, "no such fee structure");
  if (!structure.active) throw new FeeError(409, "that fee structure is not active");

  const students = await db
    .select({ id: usersTable.id, grade: usersTable.grade })
    .from(usersTable)
    .where(eq(usersTable.role, "student"));
  const applicable = structure.form_level
    ? students.filter((s) => (s.grade ?? "").trim() === structure.form_level)
    : students;

  let charged = 0;
  let skipped = 0;
  for (const student of applicable) {
    try {
      await post({
        student_id: student.id,
        kind: "charge",
        amount_tsh: structure.total_tsh,
        term: structure.term,
        fee_structure_id: structure.id,
        note: structure.name,
        entered_by: enteredBy,
      });
      charged += 1;
    } catch (err) {
      if (err instanceof FeeError && err.code === "already_charged") {
        skipped += 1;
        continue;
      }
      throw err;
    }
  }
  logger.info({ structureId, charged, skipped }, "fee structure charged");
  return { charged, skipped, total_tsh: charged * structure.total_tsh };
}

/**
 * Record a payment, optionally with the reconciliation evidence that led to
 * it. Both rows land in one transaction: a payment whose match could not be
 * recorded is a payment nobody can explain later.
 */
export async function recordPayment(
  input: Omit<PostInput, "kind"> & {
    match?: {
      paper_import_id?: number | null;
      central_payment_id?: number | null;
      payer_name?: string | null;
      payer_phone?: string | null;
      receipt?: string | null;
      matched_by: string;
      confidence?: number | null;
      reason?: string | null;
    };
  },
): Promise<FeeTransaction> {
  return db.transaction(async (tx) => {
    const row = await post({ ...input, kind: "payment" }, tx);
    if (input.match) {
      await tx.insert(paymentMatchesTable).values({
        transaction_id: row.id,
        paper_import_id: input.match.paper_import_id ?? null,
        central_payment_id: input.match.central_payment_id ?? null,
        payer_name: input.match.payer_name ?? null,
        payer_phone: input.match.payer_phone ?? null,
        amount_tsh: input.amount_tsh,
        receipt: input.match.receipt ?? input.reference ?? null,
        matched_by: input.match.matched_by,
        confidence: input.match.confidence ?? null,
        reason: input.match.reason ?? null,
        // Every proposal is confirmed by a named human before it is posted;
        // the endpoint passes who that was as `entered_by`.
        confirmed_by: input.entered_by ?? null,
        confirmed_at: new Date(),
      });
    }
    return row;
  });
}

export type AccountRow = {
  student_id: number;
  name: string;
  student_code: string | null;
  grade: string | null;
  charged_tsh: number;
  paid_tsh: number;
  waived_tsh: number;
  balance_tsh: number;
  last_transaction_at: Date | null;
};

/**
 * Every student with their account, including students who have never been
 * charged — a Form 1 nobody billed yet is exactly who a bursar is looking
 * for, so they must not fall out of the list.
 */
export async function listAccounts(): Promise<AccountRow[]> {
  const rows = await db
    .select({
      student_id: usersTable.id,
      name: usersTable.name,
      student_code: usersTable.student_code,
      grade: usersTable.grade,
      charged_tsh: feeAccountsTable.charged_tsh,
      paid_tsh: feeAccountsTable.paid_tsh,
      waived_tsh: feeAccountsTable.waived_tsh,
      balance_tsh: feeAccountsTable.balance_tsh,
      last_transaction_at: feeAccountsTable.last_transaction_at,
    })
    .from(usersTable)
    .leftJoin(feeAccountsTable, eq(feeAccountsTable.student_id, usersTable.id))
    .where(eq(usersTable.role, "student"))
    .orderBy(desc(feeAccountsTable.balance_tsh), usersTable.name);
  return rows.map((r) => ({
    ...r,
    charged_tsh: r.charged_tsh ?? 0,
    paid_tsh: r.paid_tsh ?? 0,
    waived_tsh: r.waived_tsh ?? 0,
    balance_tsh: r.balance_tsh ?? 0,
  }));
}

export async function accountHistory(studentId: number, limit = 100): Promise<FeeTransaction[]> {
  return db
    .select()
    .from(feeTransactionsTable)
    .where(eq(feeTransactionsTable.student_id, studentId))
    .orderBy(desc(feeTransactionsTable.created_at))
    .limit(limit);
}

export type FeeSummary = {
  students: number;
  students_in_arrears: number;
  charged_tsh: number;
  collected_tsh: number;
  waived_tsh: number;
  outstanding_tsh: number;
  collected_30d_tsh: number;
  collection_rate: number; // 0-100
};

export async function feeSummary(): Promise<FeeSummary> {
  const [totals] = await db
    .select({
      students: sql<number>`count(*)::int`,
      in_arrears: sql<number>`count(*) FILTER (WHERE ${feeAccountsTable.balance_tsh} > 0)::int`,
      charged: sql<number>`COALESCE(SUM(${feeAccountsTable.charged_tsh}), 0)::bigint`,
      paid: sql<number>`COALESCE(SUM(${feeAccountsTable.paid_tsh}), 0)::bigint`,
      waived: sql<number>`COALESCE(SUM(${feeAccountsTable.waived_tsh}), 0)::bigint`,
      outstanding: sql<number>`COALESCE(SUM(GREATEST(${feeAccountsTable.balance_tsh}, 0)), 0)::bigint`,
    })
    .from(feeAccountsTable);
  const [recent] = await db
    .select({
      collected: sql<number>`COALESCE(SUM(-${feeTransactionsTable.delta_tsh}), 0)::bigint`,
    })
    .from(feeTransactionsTable)
    .where(
      and(
        eq(feeTransactionsTable.kind, "payment"),
        sql`${feeTransactionsTable.received_at} >= now() - interval '30 days'`,
      ),
    );

  const charged = Number(totals?.charged ?? 0);
  const paid = Number(totals?.paid ?? 0);
  return {
    students: totals?.students ?? 0,
    students_in_arrears: totals?.in_arrears ?? 0,
    charged_tsh: charged,
    collected_tsh: paid,
    waived_tsh: Number(totals?.waived ?? 0),
    outstanding_tsh: Number(totals?.outstanding ?? 0),
    collected_30d_tsh: Number(recent?.collected ?? 0),
    collection_rate: charged > 0 ? Math.round((paid / charged) * 100) : 0,
  };
}

/**
 * Check the invariant for real: recompute every balance from the signed
 * history and report the accounts where the cached figure disagrees.
 *
 * This should always return an empty list. It exists because "should always"
 * is not a control, and because the first thing a bursar asks of a computer
 * ledger is how they would know if it were wrong.
 */
export async function verifyLedger(): Promise<
  Array<{ student_id: number; cached_tsh: number; ledger_tsh: number }>
> {
  const { rows } = await db.execute(sql`
    SELECT a.student_id,
           a.balance_tsh AS cached_tsh,
           COALESCE(t.total, 0)::int AS ledger_tsh
      FROM fee_accounts a
      LEFT JOIN (
        SELECT student_id, SUM(delta_tsh) AS total
          FROM fee_transactions
         GROUP BY student_id
      ) t ON t.student_id = a.student_id
     WHERE a.balance_tsh <> COALESCE(t.total, 0)
  `);
  return rows as Array<{ student_id: number; cached_tsh: number; ledger_tsh: number }>;
}

/**
 * Parent phone numbers for a set of students. Parent rows keep the phone in
 * `users.email` (the schema rebrand never happened — see routes/auth.ts), so
 * this is the one place that knows it, rather than every caller re-deriving
 * it or, as bulk invoicing used to, inventing one from the student id.
 */
export async function parentPhones(
  studentIds: number[],
): Promise<Map<number, { phone: string; parent_name: string }[]>> {
  if (studentIds.length === 0) return new Map();
  const { rows } = await db.execute(sql`
    SELECT pc.student_user_id AS student_id, u.email AS phone, u.name AS parent_name
      FROM parent_children pc
      JOIN users u ON u.id = pc.parent_user_id
     WHERE pc.student_user_id IN (${sql.join(studentIds.map((id) => sql`${id}`), sql`, `)})
       AND u.email IS NOT NULL
  `);
  const out = new Map<number, { phone: string; parent_name: string }[]>();
  for (const row of rows as Array<Record<string, unknown>>) {
    const id = Number(row["student_id"]);
    const list = out.get(id) ?? [];
    list.push({ phone: String(row["phone"]), parent_name: String(row["parent_name"] ?? "") });
    out.set(id, list);
  }
  return out;
}

/** Students by id, for match candidates and invoice rendering. */
export async function studentsByIds(ids: number[]) {
  if (ids.length === 0) return [];
  return db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      student_code: usersTable.student_code,
      grade: usersTable.grade,
    })
    .from(usersTable)
    .where(and(eq(usersTable.role, "student"), inArray(usersTable.id, ids)));
}
