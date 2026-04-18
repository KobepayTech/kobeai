// Parent ↔ Student linking endpoints.
//
// The parent app calls these to:
//   - List currently linked children          GET  /v1/parent/children
//   - Add a child by claim code               POST /v1/parent/children/claim
//   - Add a child by scanning watch QR        POST /v1/parent/children/pair
//
// The watch app calls:
//   - Mint a fresh pairing token (2-min TTL)  POST /v1/watch/pairing/start
//
// All consumption is wrapped in a transaction with `WHERE consumed_at IS NULL`
// CAS guards so concurrent scans / claims of the same token can't double-link.

import { Router } from "express";
import { and, eq, isNull, gt, desc } from "drizzle-orm";
import {
  db,
  usersTable,
  parentChildrenTable,
  claimCodesTable,
  parentPairingTokensTable,
  classMembershipsTable,
  classesTable,
  tenantsTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import {
  generatePairingToken,
  hashCode,
  normalizeCode,
} from "../lib/claim-codes";

const router = Router();

// ---------------------------------------------------------------------------
// Parent endpoints
// ---------------------------------------------------------------------------
router.get("/v1/parent/children", requireAuth(["parent"]), async (req, res) => {
  const parentId = Number(req.auth?.user_id);
  if (!parentId) return res.status(401).json({ error: "no parent in token" });
  const rows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      grade: usersTable.grade,
      student_code: usersTable.student_code,
      tenant_id: parentChildrenTable.tenant_id,
      nickname: parentChildrenTable.nickname,
      linked_at: parentChildrenTable.created_at,
    })
    .from(parentChildrenTable)
    .innerJoin(usersTable, eq(usersTable.id, parentChildrenTable.student_user_id))
    .where(eq(parentChildrenTable.parent_user_id, parentId))
    .orderBy(parentChildrenTable.created_at);
  res.json({ children: rows });
});

router.post(
  "/v1/parent/children/claim",
  requireAuth(["parent"]),
  async (req, res) => {
    const parentId = Number(req.auth?.user_id);
    if (!parentId) return res.status(401).json({ error: "no parent in token" });
    const code =
      typeof req.body?.code === "string" ? normalizeCode(req.body.code) : "";
    if (!code || code.length < 8) {
      return res.status(400).json({ error: "Code missing or too short" });
    }
    const codeHash = hashCode(code);
    const linked = await linkByLookup({
      parentId,
      lookup: (tx) =>
        tx
          .select()
          .from(claimCodesTable)
          .where(
            and(
              eq(claimCodesTable.code_hash, codeHash),
              isNull(claimCodesTable.consumed_at),
            ),
          )
          .limit(1),
      consume: (tx, row) =>
        tx
          .update(claimCodesTable)
          .set({ consumed_by: parentId, consumed_at: new Date() })
          .where(
            and(
              eq(claimCodesTable.id, row.id),
              isNull(claimCodesTable.consumed_at),
            ),
          )
          .returning({ id: claimCodesTable.id }),
      readStudent: (row) => ({
        student_user_id: row.student_user_id,
        tenant_id: row.tenant_id,
      }),
      isExpired: (row) => !!row.expires_at && row.expires_at.getTime() < Date.now(),
    });
    if ("error" in linked) return res.status(linked.status).json({ error: linked.error });
    res.json({ ok: true, child: linked.child });
  },
);

router.post(
  "/v1/parent/children/pair",
  requireAuth(["parent"]),
  async (req, res) => {
    const parentId = Number(req.auth?.user_id);
    if (!parentId) return res.status(401).json({ error: "no parent in token" });
    const token =
      typeof req.body?.token === "string" ? normalizeCode(req.body.token) : "";
    if (!token || token.length < 8) {
      return res.status(400).json({ error: "Token missing or invalid" });
    }
    const tokenHash = hashCode(token);
    const linked = await linkByLookup({
      parentId,
      lookup: (tx) =>
        tx
          .select()
          .from(parentPairingTokensTable)
          .where(
            and(
              eq(parentPairingTokensTable.token_hash, tokenHash),
              isNull(parentPairingTokensTable.consumed_at),
              gt(parentPairingTokensTable.expires_at, new Date()),
            ),
          )
          .limit(1),
      consume: (tx, row) =>
        tx
          .update(parentPairingTokensTable)
          .set({ consumed_by: parentId, consumed_at: new Date() })
          .where(
            and(
              eq(parentPairingTokensTable.id, row.id),
              isNull(parentPairingTokensTable.consumed_at),
            ),
          )
          .returning({ id: parentPairingTokensTable.id }),
      readStudent: (row) => ({
        student_user_id: row.student_user_id,
        tenant_id: row.tenant_id,
      }),
      isExpired: (row) => row.expires_at.getTime() < Date.now(),
    });
    if ("error" in linked) return res.status(linked.status).json({ error: linked.error });
    res.json({ ok: true, child: linked.child });
  },
);

// ---------------------------------------------------------------------------
// Watch endpoints
// ---------------------------------------------------------------------------
router.post(
  "/v1/watch/pairing/start",
  requireAuth(["student"]),
  async (req, res) => {
    const studentId = Number(req.auth?.user_id);
    const studentCode = req.auth?.student_id;
    if (!studentId || !studentCode) {
      return res.status(401).json({ error: "no student in token" });
    }
    // Resolve tenant the lazy way: subscriptionCache row holds the tenant. If
    // the student isn't synced yet we still allow pairing (tenant_id falls
    // back to 1 — the demo school).
    const [defaultTenant] = await db
      .select()
      .from(tenantsTable)
      .orderBy(tenantsTable.id)
      .limit(1);
    const tenantId = defaultTenant?.id ?? 1;
    const token = generatePairingToken();
    const tokenHash = hashCode(token);
    const ttlMs = 2 * 60 * 1000; // 2 minutes
    const expiresAt = new Date(Date.now() + ttlMs);
    await db.insert(parentPairingTokensTable).values({
      token_hash: tokenHash,
      student_user_id: studentId,
      tenant_id: tenantId,
      expires_at: expiresAt,
    });
    // The QR encodes a JSON envelope so a future scanner can validate the
    // app and not just a raw string. Apps that don't recognise the JSON can
    // still extract `t` (the token) from a regex.
    const payload = JSON.stringify({
      v: 1,
      app: "kobeai",
      kind: "parent_pair",
      t: token,
    });
    res.json({
      token,
      qr_payload: payload,
      expires_at: expiresAt.toISOString(),
      ttl_seconds: Math.floor(ttlMs / 1000),
    });
  },
);

router.get(
  "/v1/watch/pairing/status",
  requireAuth(["student"]),
  async (req, res) => {
    // Watch polls this once per second to know when the parent has scanned.
    // Returns the most recent token row for this student.
    const studentId = Number(req.auth?.user_id);
    if (!studentId) return res.status(401).json({ error: "no student" });
    const [row] = await db
      .select()
      .from(parentPairingTokensTable)
      .where(eq(parentPairingTokensTable.student_user_id, studentId))
      .orderBy(desc(parentPairingTokensTable.created_at))
      .limit(1);
    if (!row) return res.json({ status: "none" });
    if (row.consumed_at) return res.json({ status: "linked", consumed_at: row.consumed_at });
    if (row.expires_at.getTime() < Date.now())
      return res.json({ status: "expired" });
    return res.json({
      status: "pending",
      expires_at: row.expires_at,
    });
  },
);

// ---------------------------------------------------------------------------
// Shared linker
// ---------------------------------------------------------------------------
type LinkRow = { id: number };
async function linkByLookup<R extends LinkRow>(opts: {
  parentId: number;
  // `lookup` and `consume` here are intentionally tx-scoped — passed the
  // transaction object — so the read, the CAS-consume, and the link-insert
  // all share one atomic transaction. Earlier versions split them across
  // separate connections, which meant a transient FK error after `consume`
  // would permanently burn the code with no link created.
  lookup: (tx: typeof db) => Promise<R[]>;
  consume: (tx: typeof db, row: R) => Promise<{ id: number }[]>;
  readStudent: (row: R) => { student_user_id: number; tenant_id: number };
  isExpired: (row: R) => boolean;
}): Promise<
  | { error: string; status: number }
  | { child: { id: number; name: string; grade: string | null; student_code: string | null } }
> {
  return await db.transaction(async (tx) => {
    const [row] = await opts.lookup(tx as unknown as typeof db);
    if (!row) return { error: "Code not found or already used", status: 404 };
    if (opts.isExpired(row)) return { error: "Code has expired", status: 410 };
    const { student_user_id, tenant_id } = opts.readStudent(row);
    const consumed = await opts.consume(tx as unknown as typeof db, row);
    if (consumed.length === 0)
      return { error: "Code already used by another parent", status: 409 };
    await tx
      .insert(parentChildrenTable)
      .values({
        parent_user_id: opts.parentId,
        student_user_id,
        tenant_id,
      })
      .onConflictDoNothing();
    const [student] = await tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, student_user_id));
    if (!student) {
      // Roll back — student row vanished mid-flight.
      throw new Error("Student record missing");
    }
    return {
      child: {
        id: student.id,
        name: student.name,
        grade: student.grade,
        student_code: student.student_code,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Teacher / admin endpoints — issue + list claim codes for a student
// ---------------------------------------------------------------------------
import { generateClaimCode, schoolPrefix } from "../lib/claim-codes";

router.post(
  "/v1/teacher/students/:studentId/claim-code",
  requireAuth(["teacher", "admin", "super_admin"]),
  async (req, res) => {
    const studentId = Number(req.params["studentId"]);
    if (!Number.isFinite(studentId))
      return res.status(400).json({ error: "Invalid student id" });
    const [student] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, studentId));
    if (!student || student.role !== "student")
      return res.status(404).json({ error: "Student not found" });
    // The on-prem KobeAI server is single-tenant: one DB per school. We
    // confirm the student is reachable via *this* server's classes (i.e.,
    // belongs to a class whose tenant matches this server's tenant). Even
    // though every record is in this DB, this guard prevents a teacher token
    // from issuing codes for un-rostered users (e.g., orphaned imports from
    // a different school's data dump). Super-admins are allowed regardless.
    const [tenant] = await db
      .select()
      .from(tenantsTable)
      .orderBy(tenantsTable.id)
      .limit(1);
    if (!tenant) return res.status(500).json({ error: "No tenant configured" });
    if (req.auth?.role !== "super_admin") {
      const [membership] = await db
        .select({ tenant_id: classesTable.tenant_id })
        .from(classMembershipsTable)
        .innerJoin(classesTable, eq(classesTable.id, classMembershipsTable.class_id))
        .where(eq(classMembershipsTable.student_id, studentId))
        .limit(1);
      if (!membership || membership.tenant_id !== tenant.id) {
        return res
          .status(403)
          .json({ error: "Student does not belong to your school" });
      }
    }
    // Expire any previously-issued unused codes for this student.
    await db
      .update(claimCodesTable)
      .set({ expires_at: new Date(0) })
      .where(
        and(
          eq(claimCodesTable.student_user_id, studentId),
          isNull(claimCodesTable.consumed_at),
        ),
      );
    const code = generateClaimCode(tenant.slug);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    await db.insert(claimCodesTable).values({
      code_hash: hashCode(code),
      code_prefix: schoolPrefix(tenant.slug),
      tenant_id: tenant.id,
      student_user_id: studentId,
      issued_by: Number(req.auth?.user_id) || null,
      expires_at: expiresAt,
    });
    res.json({
      // Plaintext returned exactly once. School should print/SMS immediately.
      code,
      expires_at: expiresAt.toISOString(),
      student_id: studentId,
    });
  },
);

// List the school's claim codes (with status), one row per student/code.
// Always tenant-scoped to this on-prem server's tenant; super-admin bypasses.
router.get(
  "/v1/teacher/claim-codes",
  requireAuth(["teacher", "admin", "super_admin"]),
  async (req, res) => {
    const [tenant] = await db
      .select()
      .from(tenantsTable)
      .orderBy(tenantsTable.id)
      .limit(1);
    const filterTenantId = req.auth?.role === "super_admin" ? null : tenant?.id ?? -1;
    const baseQuery = db
      .select({
        id: claimCodesTable.id,
        student_user_id: claimCodesTable.student_user_id,
        student_name: usersTable.name,
        student_code: usersTable.student_code,
        grade: usersTable.grade,
        code_prefix: claimCodesTable.code_prefix,
        consumed_at: claimCodesTable.consumed_at,
        expires_at: claimCodesTable.expires_at,
        created_at: claimCodesTable.created_at,
      })
      .from(claimCodesTable)
      .innerJoin(usersTable, eq(usersTable.id, claimCodesTable.student_user_id));
    const rows = await (filterTenantId == null
      ? baseQuery
      : baseQuery.where(eq(claimCodesTable.tenant_id, filterTenantId))
    )
      .orderBy(desc(claimCodesTable.created_at))
      .limit(500);
    res.json({ codes: rows });
  },
);

export default router;
