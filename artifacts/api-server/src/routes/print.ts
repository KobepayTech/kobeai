import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { db, usersTable, classMembershipsTable, documentAssignmentsTable, documentsTable, printJobsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { getPrintStore, type Pairing, type PrintJob } from "../lib/print-store";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { requireAuth } from "../lib/auth";
import { listDocumentsForStudent } from "../lib/student-documents";
import { recordPrintJob } from "../lib/usage-counter";
import { Readable } from "node:stream";

const router: IRouter = Router();

const PAIRING_TTL_MS = 60_000;
const JOB_TTL_MS = 5 * 60_000;
const NONCE_TTL_MS = 5 * 60_000;
const TAP_BOX_SECRET = process.env["TAP_BOX_SECRET"] ?? "dev-tap-box-secret";
const WATCH_HCE_SECRET = process.env["WATCH_HCE_SECRET"] ?? "dev-watch-hce-secret";

const store = getPrintStore();
const objStore = new ObjectStorageService();

const PRINTERS: Record<string, { id: string; name: string; location: string; model: string }> = {
  "printer-lib-01":  { id: "printer-lib-01",  name: "Library Printer",     location: "Library",       model: "Epson L3250" },
  "printer-staff-01":{ id: "printer-staff-01",name: "Staff Room Printer",  location: "Staff Room",    model: "HP LaserJet" },
};

function randId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

/** Tap-box → server auth: shared secret in `x-tap-box-secret` header. */
function requireTapBox(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header("x-tap-box-secret");
  if (!provided || provided !== TAP_BOX_SECRET) {
    res.status(401).json({ error: "tap-box auth failed" });
    return;
  }
  next();
}

function verifyWatchPayload(payload: {
  student_id: string;
  watch_session_id: string;
  nonce: string;
  signature: string;
}): boolean {
  const mac = crypto
    .createHmac("sha256", WATCH_HCE_SECRET)
    .update(`${payload.student_id}|${payload.watch_session_id}|${payload.nonce}`)
    .digest("hex");
  if (mac.length !== payload.signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(payload.signature));
}

/**
 * Resolve the document catalogue for a student by joining
 *   class_memberships → document_assignments → documents
 * for whichever classes the student is in.
 */
async function listFilesForStudent(studentCode: string) {
  const docs = await listDocumentsForStudent(studentCode);
  return docs.map((d) => ({
    id: `doc-${d.id}`,
    name: d.name,
    subject: d.subject,
    size_kb: Math.max(1, Math.round(d.size_bytes / 1024)),
    pages: d.pages,
  }));
}

async function findDocumentForStudent(studentCode: string, documentId: string) {
  const numericId = Number(documentId.replace(/^doc-/, ""));
  if (!Number.isFinite(numericId)) return null;

  const student = (await db.select().from(usersTable).where(eq(usersTable.student_code, studentCode)))[0];
  if (!student) return null;
  const memberships = await db.select().from(classMembershipsTable).where(eq(classMembershipsTable.student_id, student.id));
  if (memberships.length === 0) return null;

  const allowed = await db.select().from(documentAssignmentsTable).where(
    and(
      eq(documentAssignmentsTable.document_id, numericId),
      inArray(documentAssignmentsTable.class_id, memberships.map((m) => m.class_id)),
    ),
  );
  if (allowed.length === 0) return null;

  const doc = (await db.select().from(documentsTable).where(eq(documentsTable.id, numericId)))[0];
  return doc ?? null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.post("/v1/print/pair", requireTapBox, async (req, res) => {
  const { tap_box_id, printer_id, watch_payload } = req.body ?? {};
  if (!tap_box_id || !printer_id || !watch_payload) {
    res.status(400).json({ error: "missing fields" });
    return;
  }
  if (!PRINTERS[printer_id]) {
    res.status(404).json({ error: "unknown printer" });
    return;
  }
  if (!verifyWatchPayload(watch_payload)) {
    res.status(401).json({ error: "invalid watch signature" });
    return;
  }

  const nonceKey = `${watch_payload.student_id}:${watch_payload.nonce}`;
  const fresh = await store.checkAndStoreNonce(nonceKey, NONCE_TTL_MS);
  if (!fresh) {
    res.status(409).json({ error: "replayed nonce" });
    return;
  }

  const now = Date.now();
  const pairing: Pairing = {
    id: randId("pair"),
    student_id: watch_payload.student_id,
    watch_session_id: watch_payload.watch_session_id,
    printer_id,
    tap_box_id,
    created_at: now,
    expires_at: now + PAIRING_TTL_MS,
    job_id: null,
  };
  await store.putPairing(pairing, PAIRING_TTL_MS);

  res.json({
    pairing_id: pairing.id,
    expires_in_ms: PAIRING_TTL_MS,
    student_id: pairing.student_id,
    printer: PRINTERS[printer_id],
  });
});

const requireStudent = requireAuth(["student"]);

router.get("/v1/print/pairing-for-session/:watchSessionId", requireStudent, async (req, res) => {
  const latest = await store.findPairingByWatchSession(String(req.params.watchSessionId));
  if (!latest) {
    res.status(204).end();
    return;
  }
  if (req.auth?.student_id && latest.student_id !== req.auth.student_id) {
    res.status(403).json({ error: "pairing belongs to another student" });
    return;
  }
  res.json({ pairing_id: latest.id, expires_at: latest.expires_at });
});

router.get("/v1/print/pairing/:id", requireStudent, async (req, res) => {
  const pairing = await store.getPairing(String(req.params.id));
  if (!pairing) {
    res.status(404).json({ error: "pairing not found or expired" });
    return;
  }
  if (req.auth?.student_id && pairing.student_id !== req.auth.student_id) {
    res.status(403).json({ error: "pairing belongs to another student" });
    return;
  }
  const files = await listFilesForStudent(pairing.student_id);
  res.json({
    pairing_id: pairing.id,
    student_id: pairing.student_id,
    printer: PRINTERS[pairing.printer_id],
    files,
    expires_at: pairing.expires_at,
    job_id: pairing.job_id,
  });
});

router.post("/v1/print/submit", requireStudent, async (req, res) => {
  const { pairing_id, document_id, watch_signature } = req.body ?? {};
  if (!pairing_id || !document_id || !watch_signature) {
    res.status(400).json({ error: "missing fields" });
    return;
  }
  const pairing = await store.getPairing(pairing_id);
  if (!pairing) {
    res.status(404).json({ error: "pairing not found or expired" });
    return;
  }
  if (req.auth?.student_id && pairing.student_id !== req.auth.student_id) {
    res.status(403).json({ error: "pairing belongs to another student" });
    return;
  }
  const expected = crypto
    .createHmac("sha256", WATCH_HCE_SECRET)
    .update(`${pairing_id}|${document_id}`)
    .digest("hex");
  if (
    expected.length !== String(watch_signature).length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(watch_signature)))
  ) {
    res.status(401).json({ error: "invalid watch signature" });
    return;
  }
  const doc = await findDocumentForStudent(pairing.student_id, document_id);
  if (!doc) {
    res.status(404).json({ error: "document not found for this student" });
    return;
  }
  recordPrintJob();
  const now = Date.now();
  const job: PrintJob = {
    id: randId("job"),
    pairing_id,
    student_id: pairing.student_id,
    printer_id: pairing.printer_id,
    document_id,
    document_name: doc.name,
    status: "queued",
    status_message: "Waiting for printer to pick up",
    created_at: now,
    expires_at: now + JOB_TTL_MS,
  };
  await store.putJob(job, JOB_TTL_MS);
  await store.updatePairingJob(pairing_id, job.id);

  // Persist a long-term audit record. The student_code on the job is the
  // student.user.student_code (set at session creation), so we resolve the
  // numeric user.id for FK linkage.
  try {
    const studentRow = (
      await db.select().from(usersTable).where(eq(usersTable.student_code, pairing.student_id))
    )[0];
    await db.insert(printJobsTable).values({
      job_ref: job.id,
      student_code: pairing.student_id,
      student_id: studentRow?.id ?? null,
      document_id: doc.id,
      document_name: doc.name,
      pages: doc.pages ?? 1,
      printer_id: pairing.printer_id,
      printer_name: PRINTERS[pairing.printer_id]?.name ?? null,
      status: "queued",
    });
  } catch (err) {
    req.log?.error({ err }, "failed to persist print job audit row");
  }

  res.json({ job_id: job.id, status: job.status, document_name: doc.name });
});

router.get("/v1/print/jobs/:id", requireStudent, async (req, res) => {
  const job = await store.getJob(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: "job not found or expired" });
    return;
  }
  if (req.auth?.student_id && job.student_id !== req.auth.student_id) {
    res.status(403).json({ error: "job belongs to another student" });
    return;
  }
  res.json(job);
});

router.get("/v1/print/next", requireTapBox, async (req, res) => {
  const printerId = String(req.query["printer_id"] ?? "");
  if (!printerId) {
    res.status(400).json({ error: "printer_id required" });
    return;
  }
  const job = await store.findQueuedForPrinter(printerId);
  res.json({ job: job ?? null });
});

router.get("/v1/print/jobs/:id/document", requireTapBox, async (req, res) => {
  const job = await store.getJob(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  const numericId = Number(job.document_id.replace(/^doc-/, ""));
  const doc = (await db.select().from(documentsTable).where(eq(documentsTable.id, numericId)))[0];
  if (!doc) {
    res.status(404).json({ error: "document row missing" });
    return;
  }
  try {
    const file = await objStore.getObjectEntityFile(doc.object_path);
    res.setHeader("Content-Type", doc.content_type);
    res.setHeader("Content-Disposition", `attachment; filename="${job.id}.pdf"`);
    file.createReadStream()
      .on("error", (err) => {
        req.log?.error({ err }, "object stream error");
        if (!res.headersSent) res.status(500).end();
      })
      .pipe(res);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "document bytes missing in storage" });
      return;
    }
    throw err;
  }
});

router.post("/v1/print/jobs/:id/status", requireTapBox, async (req, res) => {
  const { status, message } = req.body ?? {};
  const allowed: PrintJob["status"][] = ["downloading", "printing", "done", "failed"];
  if (!allowed.includes(status)) {
    res.status(400).json({ error: "invalid status" });
    return;
  }
  const updated = await store.updateJobStatus(String(req.params.id), status, typeof message === "string" ? message : "");
  if (!updated) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  // Mirror the status onto the audit row (best-effort).
  try {
    await db
      .update(printJobsTable)
      .set({
        status,
        status_message: typeof message === "string" ? message : null,
        completed_at: status === "done" || status === "failed" ? new Date() : null,
      })
      .where(eq(printJobsTable.job_ref, String(req.params.id)));
  } catch (err) {
    req.log?.error({ err }, "failed to update print job audit row");
  }
  res.json({ ok: true, job: updated });
});

export default router;
