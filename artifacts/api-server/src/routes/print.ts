import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// In-memory state. For a real pilot this should live in Redis so multiple
// backend replicas can share pairings, but for one school server / one
// process this is fine.
// ---------------------------------------------------------------------------

const PAIRING_TTL_MS = 60_000;
const JOB_TTL_MS = 5 * 60_000;
const TAP_BOX_SECRET = process.env["TAP_BOX_SECRET"] ?? "dev-tap-box-secret";
const WATCH_HCE_SECRET = process.env["WATCH_HCE_SECRET"] ?? "dev-watch-hce-secret";

type Pairing = {
  id: string;
  student_id: string;
  watch_session_id: string;
  printer_id: string;
  tap_box_id: string;
  created_at: number;
  expires_at: number;
  job_id: string | null;
};

type PrintJob = {
  id: string;
  pairing_id: string;
  student_id: string;
  printer_id: string;
  document_id: string;
  document_name: string;
  status: "queued" | "downloading" | "printing" | "done" | "failed";
  status_message: string;
  created_at: number;
  expires_at: number;
};

const pairings = new Map<string, Pairing>();
const jobs = new Map<string, PrintJob>();

// Replay protection: remember every nonce we've accepted for NONCE_TTL_MS so
// the same HMAC-signed payload cannot be re-used by a sniffer. The Map value
// is the expiry timestamp so gc() can prune cheaply.
const NONCE_TTL_MS = 5 * 60_000;
const seenNonces = new Map<string, number>();

function gc() {
  const now = Date.now();
  for (const [id, p] of pairings) if (p.expires_at < now) pairings.delete(id);
  for (const [id, j] of jobs) if (j.expires_at < now) jobs.delete(id);
  for (const [k, exp] of seenNonces) if (exp < now) seenNonces.delete(k);
}
setInterval(gc, 10_000).unref();

// ---------------------------------------------------------------------------
// Demo file catalogue. Replace with a DB-backed list per student in production.
// ---------------------------------------------------------------------------
const FILES_BY_STUDENT: Record<string, Array<{ id: string; name: string; subject: string; size_kb: number; pages: number }>> = {
  TEST001: [
    { id: "doc-math-hw-12", name: "Mathematics Homework Week 12", subject: "Mathematics", size_kb: 84, pages: 2 },
    { id: "doc-bio-notes",  name: "Biology Class Notes - Cells",  subject: "Science",     size_kb: 120, pages: 4 },
    { id: "doc-history-tz", name: "Tanzanian Independence Essay", subject: "History",     size_kb: 56, pages: 3 },
    { id: "doc-eng-poem",   name: "English Poem Analysis",        subject: "English",     size_kb: 32, pages: 1 },
  ],
};

const PRINTERS: Record<string, { id: string; name: string; location: string; model: string }> = {
  "printer-lib-01":  { id: "printer-lib-01",  name: "Library Printer",     location: "Library",       model: "Epson L3250" },
  "printer-staff-01":{ id: "printer-staff-01",name: "Staff Room Printer",  location: "Staff Room",    model: "HP LaserJet" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Verify the HCE payload the watch transmitted. The watch signs
 * `${student_id}|${watch_session_id}|${nonce}` with HMAC-SHA256(WATCH_HCE_SECRET).
 * In production each watch enrolls its own per-device key; for the pilot a
 * shared secret is acceptable since all the watches are owned by the school.
 */
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
  // timingSafeEqual requires equal-length buffers
  if (mac.length !== payload.signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(payload.signature));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/print/pair
 * Called by the tap-box when a watch is tapped. Verifies the watch payload,
 * resolves which printer this tap-box drives, and creates a 60-second
 * pairing the watch can poll for.
 *
 * Auth: x-tap-box-secret header
 * Body: { tap_box_id, printer_id, watch_payload: { student_id, watch_session_id, nonce, signature } }
 */
router.post("/v1/print/pair", requireTapBox, (req, res) => {
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
  // Replay defence: same nonce cannot be reused for the TTL window.
  const nonceKey = `${watch_payload.student_id}:${watch_payload.nonce}`;
  if (seenNonces.has(nonceKey)) {
    res.status(409).json({ error: "replayed nonce" });
    return;
  }
  seenNonces.set(nonceKey, Date.now() + NONCE_TTL_MS);

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
  pairings.set(pairing.id, pairing);

  res.json({
    pairing_id: pairing.id,
    expires_in_ms: PAIRING_TTL_MS,
    student_id: pairing.student_id,
    printer: PRINTERS[printer_id],
  });
});

/**
 * GET /api/v1/print/pairing-for-session/:watchSessionId
 * Watch polls this every ~1.5s while on the "Tap your watch" screen.
 * Returns the most recent unexpired pairing created for that watch session,
 * or 204 No Content if none yet. This is how the watch discovers the
 * pairing_id without seeing the tap directly (only the tap-box does).
 */
router.get("/v1/print/pairing-for-session/:watchSessionId", (req, res) => {
  const sessionId = req.params.watchSessionId;
  const now = Date.now();
  let latest: Pairing | null = null;
  for (const p of pairings.values()) {
    if (p.expires_at < now) continue;
    if (p.watch_session_id !== sessionId) continue;
    if (!latest || p.created_at > latest.created_at) latest = p;
  }
  if (!latest) {
    res.status(204).end();
    return;
  }
  res.json({ pairing_id: latest.id, expires_at: latest.expires_at });
});

/**
 * GET /api/v1/print/pairing/:id
 * Watch polls this after a tap to discover which printer it was paired with
 * and to fetch the file list to display.
 */
router.get("/v1/print/pairing/:id", (req, res) => {
  const pairing = pairings.get(req.params.id);
  if (!pairing) {
    res.status(404).json({ error: "pairing not found or expired" });
    return;
  }
  const files = FILES_BY_STUDENT[pairing.student_id] ?? [];
  res.json({
    pairing_id: pairing.id,
    student_id: pairing.student_id,
    printer: PRINTERS[pairing.printer_id],
    files,
    expires_at: pairing.expires_at,
    job_id: pairing.job_id,
  });
});

/**
 * POST /api/v1/print/submit
 * Watch calls this after the student picks a document.
 * Creates a print job which the tap-box will pick up via /next.
 *
 * Body: { pairing_id, document_id, watch_signature }
 *
 * `watch_signature` = HMAC-SHA256(WATCH_HCE_SECRET, "${pairing_id}|${document_id}").
 * This binds the submit to the watch that owns the pairing — even if the
 * pairing_id leaks, no one else can submit a print job with it.
 */
router.post("/v1/print/submit", (req, res) => {
  const { pairing_id, document_id, watch_signature } = req.body ?? {};
  if (!pairing_id || !document_id || !watch_signature) {
    res.status(400).json({ error: "missing fields" });
    return;
  }
  const pairing = pairings.get(pairing_id);
  if (!pairing || pairing.expires_at < Date.now()) {
    res.status(404).json({ error: "pairing not found or expired" });
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
  const file = (FILES_BY_STUDENT[pairing.student_id] ?? []).find((f) => f.id === document_id);
  if (!file) {
    res.status(404).json({ error: "document not found for this student" });
    return;
  }
  const now = Date.now();
  const job: PrintJob = {
    id: randId("job"),
    pairing_id,
    student_id: pairing.student_id,
    printer_id: pairing.printer_id,
    document_id,
    document_name: file.name,
    status: "queued",
    status_message: "Waiting for printer to pick up",
    created_at: now,
    expires_at: now + JOB_TTL_MS,
  };
  jobs.set(job.id, job);
  pairing.job_id = job.id;

  res.json({ job_id: job.id, status: job.status, document_name: file.name });
});

/**
 * GET /api/v1/print/jobs/:id
 * Watch polls this to show progress to the student.
 */
router.get("/v1/print/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "job not found or expired" });
    return;
  }
  res.json(job);
});

/**
 * GET /api/v1/print/next?tap_box_id=...&printer_id=...
 * Tap-box long-polls (or short-polls every second) this endpoint to discover
 * jobs queued for the printer it owns.
 *
 * Auth: x-tap-box-secret
 */
router.get("/v1/print/next", requireTapBox, (req, res) => {
  const printerId = String(req.query["printer_id"] ?? "");
  if (!printerId) {
    res.status(400).json({ error: "printer_id required" });
    return;
  }
  for (const job of jobs.values()) {
    if (job.printer_id === printerId && job.status === "queued") {
      res.json({ job });
      return;
    }
  }
  res.json({ job: null });
});

/**
 * GET /api/v1/print/jobs/:id/document
 * Tap-box downloads the actual document bytes here. Today we return a
 * synthetic PDF so the loop is testable end-to-end without a real CMS.
 *
 * Auth: x-tap-box-secret
 */
router.get("/v1/print/jobs/:id/document", requireTapBox, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  // Minimal valid one-page PDF with the doc name as content. Replace with a
  // real lookup against your school document store in production.
  const text = `KobeAI Print Job\n\nStudent: ${job.student_id}\nDocument: ${job.document_name}\nJob ID: ${job.id}\n`;
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const pdf = buildSimplePdf(escaped);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${job.id}.pdf"`);
  res.send(pdf);
});

/**
 * POST /api/v1/print/jobs/:id/status
 * Tap-box reports status transitions: downloading → printing → done|failed.
 *
 * Auth: x-tap-box-secret
 * Body: { status, message? }
 */
router.post("/v1/print/jobs/:id/status", requireTapBox, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  const { status, message } = req.body ?? {};
  const allowed: PrintJob["status"][] = ["downloading", "printing", "done", "failed"];
  if (!allowed.includes(status)) {
    res.status(400).json({ error: "invalid status" });
    return;
  }
  job.status = status;
  if (typeof message === "string") job.status_message = message;
  res.json({ ok: true, job });
});

// ---------------------------------------------------------------------------
// Tiny PDF generator (no external deps). Single-page, one line of text.
// ---------------------------------------------------------------------------
function buildSimplePdf(text: string): Buffer {
  const objects: string[] = [];
  const push = (s: string) => {
    objects.push(s);
    return objects.length;
  };

  push("<< /Type /Catalog /Pages 2 0 R >>");
  push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
  const stream = `BT /F1 14 Tf 72 720 Td (${text.split("\n").join(") Tj T* (")}) Tj ET`;
  push(`<< /Length ${stream.length} >> stream\n${stream}\nendstream`);
  push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, "binary"));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "binary");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, "binary");
}

export default router;
