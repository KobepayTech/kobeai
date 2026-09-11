import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { db, documentsTable, printJobsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getPrintStore, type PrintJob } from "../lib/print-store";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { requireAuth } from "../lib/auth";
import { recordPrintJob } from "../lib/usage-counter";

const router: IRouter = Router();

// Staff often queue a handout before the lesson starts, so a job waits for
// its print agent for a while before it is dropped from the live store.
const JOB_TTL_MS = 30 * 60_000;
const MAX_COPIES = 60;
const NODE_ENV = process.env["NODE_ENV"] ?? "development";
const ALLOW_DEV_SECRETS = NODE_ENV === "development" || NODE_ENV === "test";
const RAW_TAP_BOX_SECRET = process.env["TAP_BOX_SECRET"];
if (!RAW_TAP_BOX_SECRET && !ALLOW_DEV_SECRETS) {
  throw new Error("TAP_BOX_SECRET must be set in non-development environments");
}
const TAP_BOX_SECRET = RAW_TAP_BOX_SECRET ?? "dev-tap-box-secret";

const store = getPrintStore();
const objStore = new ObjectStorageService();

const PRINTERS: Record<string, { id: string; name: string; location: string; model: string }> = {
  "printer-lib-01":  { id: "printer-lib-01",  name: "Library Printer",     location: "Library",       model: "Epson L3250" },
  "printer-staff-01":{ id: "printer-staff-01",name: "Staff Room Printer",  location: "Staff Room",    model: "HP LaserJet" },
};

function randId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

const TAP_BOX_SECRET_BUF = Buffer.from(TAP_BOX_SECRET, "utf8");

/** Print agent (tap-box) → server auth: shared secret in `x-tap-box-secret` header. */
function requireTapBox(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header("x-tap-box-secret");
  const providedBuf = provided ? Buffer.from(provided, "utf8") : null;
  const ok =
    !!providedBuf &&
    providedBuf.length === TAP_BOX_SECRET_BUF.length &&
    crypto.timingSafeEqual(providedBuf, TAP_BOX_SECRET_BUF);
  if (!ok) {
    res.status(401).json({ error: "tap-box auth failed" });
    return;
  }
  next();
}

const requireStaff = requireAuth(["teacher", "admin", "super_admin"]);

function isAdmin(req: Request): boolean {
  return req.auth?.role === "admin" || req.auth?.role === "super_admin";
}

// ---------------------------------------------------------------------------
// Staff routes
// ---------------------------------------------------------------------------

router.get("/v1/print/printers", requireStaff, (_req, res) => {
  res.json({ printers: Object.values(PRINTERS) });
});

/**
 * POST /v1/print/jobs
 * Staff-initiated print: a teacher sends a document to a school printer from
 * the Teacher Dashboard. The print agent beside that printer picks the job up
 * via GET /v1/print/next.
 *
 * Body: { printer_id, document_id, copies?, student_code? }
 * Set `student_code` for a personal handout (e.g. a retest sheet) so it shows
 * in that child's parent print history.
 */
router.post("/v1/print/jobs", requireStaff, async (req, res) => {
  const { printer_id, document_id, student_code } = req.body ?? {};
  const printer = typeof printer_id === "string" ? PRINTERS[printer_id] : undefined;
  if (!printer) {
    res.status(404).json({ error: "unknown printer" });
    return;
  }
  const docId = Number(String(document_id ?? "").replace(/^doc-/, ""));
  if (!Number.isInteger(docId) || docId <= 0) {
    res.status(400).json({ error: "document_id required" });
    return;
  }
  const copies = req.body?.copies == null ? 1 : Number(req.body.copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) {
    res.status(400).json({ error: `copies must be between 1 and ${MAX_COPIES}` });
    return;
  }
  const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, docId));
  if (!doc) {
    res.status(404).json({ error: "document not found" });
    return;
  }
  // Teachers print their own uploads; admins can print any document.
  if (!isAdmin(req) && doc.uploaded_by !== req.auth?.user_id) {
    res.status(403).json({ error: "document not owned by this teacher" });
    return;
  }
  let student: typeof usersTable.$inferSelect | undefined;
  if (student_code != null && student_code !== "") {
    [student] = await db.select().from(usersTable).where(eq(usersTable.student_code, String(student_code)));
    if (!student || student.role !== "student") {
      res.status(404).json({ error: "student not found" });
      return;
    }
  }

  recordPrintJob();
  const now = Date.now();
  const job: PrintJob = {
    id: randId("job"),
    printer_id: printer.id,
    document_id: `doc-${doc.id}`,
    document_name: doc.name,
    copies,
    student_code: student?.student_code ?? null,
    requested_by: req.auth!.user_id,
    status: "queued",
    status_message: "Waiting for printer to pick up",
    created_at: now,
    expires_at: now + JOB_TTL_MS,
  };
  await store.putJob(job, JOB_TTL_MS);

  // Long-term audit record — the live store entry expires after JOB_TTL_MS.
  try {
    await db.insert(printJobsTable).values({
      job_ref: job.id,
      student_code: job.student_code,
      student_id: student?.id ?? null,
      requested_by: job.requested_by,
      document_id: doc.id,
      document_name: doc.name,
      pages: doc.pages ?? 1,
      copies,
      printer_id: printer.id,
      printer_name: printer.name,
      status: "queued",
    });
  } catch (err) {
    req.log?.error({ err }, "failed to persist print job audit row");
  }

  res.status(201).json({ job_id: job.id, status: job.status, document_name: doc.name, copies, printer });
});

router.get("/v1/print/jobs/:id", requireStaff, async (req, res) => {
  const job = await store.getJob(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: "job not found or expired" });
    return;
  }
  if (!isAdmin(req) && job.requested_by !== req.auth?.user_id) {
    res.status(403).json({ error: "job belongs to another teacher" });
    return;
  }
  res.json(job);
});

// ---------------------------------------------------------------------------
// Print agent routes
// ---------------------------------------------------------------------------

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
    req.log?.error({ err }, "failed to fetch document bytes for print agent");
    if (!res.headersSent) {
      res.status(502).json({ error: "object_storage_unavailable" });
    } else {
      res.end();
    }
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
