import crypto from "node:crypto";
import express, { Router } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  classMembershipsTable,
  classesTable,
  paperImportsTable,
  schoolSetupTable,
  staffProfilesTable,
  studentSubjectsTable,
  teacherInvitesTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, signToken } from "../lib/auth";
import { logger } from "../lib/logger";
import { rateLimit } from "../lib/rate-limit";
import { hashPin } from "../lib/seed";
import { ensureFaceTables } from "../lib/face-gallery";
import { pool } from "@workspace/db";
import {
  matchName,
  parseRoster,
  parseSubjectSheet,
  readPaper,
  titleCase,
  type RosterRow,
  type SubjectRow,
} from "../lib/paper-reader";

// ===========================================================================
// Staff and student onboarding.
//
// The whole point of this file is that nobody types a list into a computer.
//
//   1. The administrator prints a sheet of QR codes.
//   2. A teacher scans one with their own phone. The QR opens a form: their
//      name, their age band, the subjects and classes they teach, the
//      language they want K9 to speak to them in, and the nickname they want
//      K9 to call them. Submitting it mints their account — personalised
//      before they have signed in once.
//   3. The same phone then photographs the printed class list from the
//      office. The vision model reads it, the teacher checks the rows on
//      screen, and Commit creates the students.
//   4. K9 then walks the teacher down that list one student at a time:
//      it shows a name, the teacher calls that student over, the camera
//      opens, one photo, next. That is the face gallery filled in a single
//      period, which is what makes camera presence work at all.
//   5. Finally the Form 3+ subject-option sheet — the ruled page the
//      students signed — gets the same photo-read-check-commit treatment, so
//      K9 knows who takes Physics and who dropped it.
//
// Every read is a proposal. `commit` is the only thing that writes students.
// ===========================================================================

const router = Router();

const staff = requireAuth(["teacher", "admin", "super_admin"]);
const admin = requireAuth(["admin", "super_admin"]);
// The claim endpoints are unauthenticated by design — the QR token IS the
// credential — so they are throttled like a login surface.
const claimLimiter = rateLimit({ windowMs: 60_000, max: 12, name: "onboarding-claim" });

const AGE_BANDS = ["18-24", "25-34", "35-44", "45-54", "55+"];
const TEACHING_STYLES = ["examples", "drill", "discussion", "visual"];
const BRIEFING_LENGTHS = ["short", "normal", "detailed"];
const LANGUAGES = ["sw", "en"];

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

async function schoolName(): Promise<string> {
  const [row] = await db.select({ name: schoolSetupTable.school_name }).from(schoolSetupTable).limit(1);
  return row?.name ?? process.env["SCHOOL_NAME"] ?? "This school";
}

// ---------------------------------------------------------------------------
// Invites (administrator side)
// ---------------------------------------------------------------------------

/**
 * POST /v1/onboarding/invites
 * Body: { label?, role?, expires_hours?, max_uses? }
 * Returns the token ONCE. Only its hash is stored, so this response is the
 * only chance to print it — same rule as the parent claim codes.
 */
router.post("/v1/onboarding/invites", admin, async (req, res) => {
  const label = String(req.body?.label ?? "").trim().slice(0, 80);
  const role = req.body?.role === "admin" ? "admin" : "teacher";
  const hours = Math.min(24 * 30, Math.max(1, Number(req.body?.expires_hours ?? 72)));
  const maxUses = Math.min(200, Math.max(1, Number(req.body?.max_uses ?? 1)));

  // 160 bits in URL-safe base64 — short enough for a phone-camera QR at a
  // comfortable error-correction level, long enough that guessing is hopeless.
  const token = crypto.randomBytes(20).toString("base64url");
  const [invite] = await db
    .insert(teacherInvitesTable)
    .values({
      token_hash: hashToken(token),
      label: label || null,
      role,
      issued_by: req.auth!.user_id,
      max_uses: maxUses,
      expires_at: new Date(Date.now() + hours * 3_600_000),
    })
    .returning();

  res.status(201).json({
    invite: { ...invite, token_hash: undefined },
    token,
    // The dashboard renders this into a QR the teacher scans. It resolves to
    // the Lens PWA, which is already installed on staff phones.
    claim_path: `/lens/#/onboard/${token}`,
  });
});

/** GET /v1/onboarding/invites — outstanding invites, never their tokens. */
router.get("/v1/onboarding/invites", admin, async (_req, res) => {
  const invites = await db
    .select({
      id: teacherInvitesTable.id,
      label: teacherInvitesTable.label,
      role: teacherInvitesTable.role,
      max_uses: teacherInvitesTable.max_uses,
      uses: teacherInvitesTable.uses,
      expires_at: teacherInvitesTable.expires_at,
      revoked_at: teacherInvitesTable.revoked_at,
      last_used_at: teacherInvitesTable.last_used_at,
      created_at: teacherInvitesTable.created_at,
    })
    .from(teacherInvitesTable)
    .orderBy(desc(teacherInvitesTable.created_at))
    .limit(100);
  res.json({ invites });
});

/** POST /v1/onboarding/invites/:id/revoke — kill a QR that walked off site. */
router.post("/v1/onboarding/invites/:id/revoke", admin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return void res.status(400).json({ error: "bad id" });
  const [updated] = await db
    .update(teacherInvitesTable)
    .set({ revoked_at: new Date() })
    .where(and(eq(teacherInvitesTable.id, id), isNull(teacherInvitesTable.revoked_at)))
    .returning({ id: teacherInvitesTable.id });
  if (!updated) return void res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Claiming an invite (the scanned QR, on the teacher's own phone)
// ---------------------------------------------------------------------------

async function liveInvite(token: string) {
  if (!token || token.length < 10) return null;
  const [invite] = await db
    .select()
    .from(teacherInvitesTable)
    .where(eq(teacherInvitesTable.token_hash, hashToken(token)))
    .limit(1);
  if (!invite) return null;
  if (invite.revoked_at) return null;
  if (invite.expires_at <= new Date()) return null;
  if (invite.uses >= invite.max_uses) return null;
  return invite;
}

/**
 * GET /v1/onboarding/invites/:token/form — public.
 * What the phone shows after the scan: who the school is, and the choices
 * the teacher is being asked to make. The subject and class lists come from
 * what the school already has, so the teacher taps instead of typing.
 */
router.get("/v1/onboarding/invites/:token/form", claimLimiter, async (req, res) => {
  const invite = await liveInvite(String(req.params.token));
  if (!invite) {
    res.status(404).json({ error: "This code is not valid any more. Ask for a new one." });
    return;
  }
  const classes = await db.select({ name: classesTable.name }).from(classesTable).orderBy(classesTable.name);
  const subjects = await db
    .select({ subject: studentSubjectsTable.subject })
    .from(studentSubjectsTable)
    .groupBy(studentSubjectsTable.subject);
  res.json({
    school_name: await schoolName(),
    label: invite.label,
    role: invite.role,
    options: {
      subjects: subjects.map((s) => s.subject),
      classes: classes.map((c) => c.name),
      age_bands: AGE_BANDS,
      teaching_styles: TEACHING_STYLES,
      briefing_lengths: BRIEFING_LENGTHS,
      languages: LANGUAGES,
    },
  });
});

/**
 * POST /v1/onboarding/invites/:token/claim — public.
 * Body: { full_name, email, password, nickname?, age_band?, language?,
 *         teaching_style?, subjects?, classes?, briefing_length? }
 *
 * Mints the account and signs the phone straight in, so the teacher goes
 * from scanning a QR to photographing their class list without ever seeing
 * a login screen.
 */
router.post("/v1/onboarding/invites/:token/claim", claimLimiter, async (req, res) => {
  const token = String(req.params.token);
  const invite = await liveInvite(token);
  if (!invite) {
    res.status(404).json({ error: "This code is not valid any more. Ask for a new one." });
    return;
  }

  const fullName = titleCase(String(req.body?.full_name ?? "").replace(/\s+/g, " ").trim());
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  if (fullName.length < 4) {
    res.status(400).json({ error: "Enter your full name." });
    return;
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: "Enter a valid email address." });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Choose a password of at least 8 characters." });
    return;
  }

  const pick = (value: unknown, allowed: string[], fallback: string) => {
    const v = String(value ?? "").trim();
    return allowed.includes(v) ? v : fallback;
  };
  const list = (value: unknown) =>
    Array.isArray(value)
      ? [...new Set(value.map((v) => String(v).trim()).filter((v) => v && v.length <= 60))].slice(0, 20)
      : [];

  try {
    const result = await db.transaction(async (tx) => {
      // Re-check use count inside the transaction: two teachers scanning the
      // same single-use QR at the same moment must not both get an account.
      const claimed = await tx
        .update(teacherInvitesTable)
        .set({ uses: sql`${teacherInvitesTable.uses} + 1`, last_used_at: new Date() })
        .where(
          and(
            eq(teacherInvitesTable.id, invite.id),
            isNull(teacherInvitesTable.revoked_at),
            sql`${teacherInvitesTable.uses} < ${teacherInvitesTable.max_uses}`,
          ),
        )
        .returning({ id: teacherInvitesTable.id, uses: teacherInvitesTable.uses });
      if (claimed.length === 0) throw new Error("INVITE_SPENT");

      const [user] = await tx
        .insert(usersTable)
        .values({
          role: invite.role,
          name: fullName,
          email,
          password_hash: hashPin(password),
        })
        .returning();

      const [profile] = await tx
        .insert(staffProfilesTable)
        .values({
          user_id: user!.id,
          nickname: String(req.body?.nickname ?? "").trim().slice(0, 60) || fullName.split(" ")[0]!,
          age_band: pick(req.body?.age_band, AGE_BANDS, ""),
          language: pick(req.body?.language, LANGUAGES, "sw"),
          teaching_style: pick(req.body?.teaching_style, TEACHING_STYLES, "examples"),
          subjects: list(req.body?.subjects),
          classes: list(req.body?.classes),
          briefing_length: pick(req.body?.briefing_length, BRIEFING_LENGTHS, "short"),
          onboarding_step: "roster",
          invite_id: invite.id,
        })
        .returning();
      return { user: user!, profile: profile! };
    });

    const accessToken = signToken({
      role: result.user.role as "teacher" | "admin",
      user_id: result.user.id,
      email: result.user.email ?? undefined,
      name: result.user.name,
    });
    logger.info({ user_id: result.user.id, invite_id: invite.id }, "teacher claimed an invite");
    res.status(201).json({
      access_token: accessToken,
      token_type: "bearer",
      teacher_name: result.user.name,
      role: result.user.role,
      profile: result.profile,
      next_step: "roster",
    });
  } catch (err) {
    if (err instanceof Error && err.message === "INVITE_SPENT") {
      res.status(409).json({ error: "This code has already been used." });
      return;
    }
    if (String((err as { code?: string })?.code) === "23505") {
      res.status(409).json({ error: "That email already has an account. Sign in instead." });
      return;
    }
    logger.error({ err }, "invite claim failed");
    res.status(500).json({ error: "Could not create the account." });
  }
});

// ---------------------------------------------------------------------------
// The teacher's own profile and progress
// ---------------------------------------------------------------------------

/** GET /v1/onboarding/me — profile, current step, and what is left to do. */
router.get("/v1/onboarding/me", staff, async (req, res) => {
  const userId = req.auth!.user_id;
  const [profile] = await db
    .select()
    .from(staffProfilesTable)
    .where(eq(staffProfilesTable.user_id, userId))
    .limit(1);
  const [counts] = await db
    .select({ students: sql<number>`count(*) FILTER (WHERE role = 'student')::int` })
    .from(usersTable);
  const faces = await enrolledFaceCount();
  res.json({
    profile: profile ?? null,
    progress: {
      students: counts?.students ?? 0,
      students_with_face: faces,
      students_without_face: Math.max(0, (counts?.students ?? 0) - faces),
    },
  });
});

/** PATCH /v1/onboarding/me — change the personalisation later. */
router.patch("/v1/onboarding/me", staff, async (req, res) => {
  const userId = req.auth!.user_id;
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.nickname === "string") patch["nickname"] = req.body.nickname.trim().slice(0, 60);
  if (AGE_BANDS.includes(req.body?.age_band)) patch["age_band"] = req.body.age_band;
  if (LANGUAGES.includes(req.body?.language)) patch["language"] = req.body.language;
  if (TEACHING_STYLES.includes(req.body?.teaching_style)) patch["teaching_style"] = req.body.teaching_style;
  if (BRIEFING_LENGTHS.includes(req.body?.briefing_length)) patch["briefing_length"] = req.body.briefing_length;
  if (Array.isArray(req.body?.subjects)) {
    patch["subjects"] = [...new Set(req.body.subjects.map((s: unknown) => String(s).trim()).filter(Boolean))];
  }
  if (Array.isArray(req.body?.classes)) {
    patch["classes"] = [...new Set(req.body.classes.map((s: unknown) => String(s).trim()).filter(Boolean))];
  }
  if (["profile", "roster", "faces", "subjects", "done"].includes(req.body?.onboarding_step)) {
    patch["onboarding_step"] = req.body.onboarding_step;
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "nothing to update" });
    return;
  }
  const [updated] = await db
    .insert(staffProfilesTable)
    .values({ user_id: userId, ...patch })
    .onConflictDoUpdate({
      target: staffProfilesTable.user_id,
      set: { ...patch, updated_at: new Date() },
    })
    .returning();
  res.json({ profile: updated });
});

// ---------------------------------------------------------------------------
// Paper intake — class lists and subject-option sheets
// ---------------------------------------------------------------------------

/**
 * POST /v1/onboarding/papers?kind=roster|subjects&class_name=Form%202A
 * Body: a JPEG or PNG photo of the sheet.
 *
 * Reads it and answers with the rows it found. Writes nothing into `users`.
 */
router.post(
  "/v1/onboarding/papers",
  // Auth runs before the body parser so an unauthenticated caller is refused
  // on its headers instead of after we have buffered 12 MB of it.
  staff,
  express.raw({ type: ["image/jpeg", "image/png", "application/octet-stream"], limit: "12mb" }),
  async (req, res) => {
    const kind = String(req.query["kind"] ?? "roster");
    if (kind !== "roster" && kind !== "subjects") {
      res.status(400).json({ error: "kind must be 'roster' or 'subjects'" });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length < 1024) {
      res.status(400).json({ error: "Send a photo of the sheet as the request body." });
      return;
    }
    const className = String(req.query["class_name"] ?? "").trim().slice(0, 40);
    const formLevel = String(req.query["form_level"] ?? "").trim().slice(0, 20);

    const [created] = await db
      .insert(paperImportsTable)
      .values({
        kind,
        status: "reading",
        uploaded_by: req.auth!.user_id,
        class_name: className || null,
        form_level: formLevel || null,
      })
      .returning();
    const importId = created!.id;

    try {
      const read = await readPaper(req.body);
      if (!read) {
        await db
          .update(paperImportsTable)
          .set({
            status: "failed",
            error: "No vision model is available on this server.",
          })
          .where(eq(paperImportsTable.id, importId));
        res.status(503).json({
          id: importId,
          error:
            "This server has no model that can read a photo. Type the names in, " +
            "or paste the list as text instead.",
        });
        return;
      }

      const parsed =
        kind === "roster"
          ? await parseRoster(read.text)
          : await parseSubjectSheet(read.text, await knownSubjects());
      const [updated] = await db
        .update(paperImportsTable)
        .set({
          status: "parsed",
          ocr_text: read.text.slice(0, 20_000),
          parsed: parsed.rows,
          model: parsed.model ?? read.model,
        })
        .where(eq(paperImportsTable.id, importId))
        .returning();
      res.status(201).json({ import: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, importId }, "paper import failed");
      await db
        .update(paperImportsTable)
        .set({ status: "failed", error: message.slice(0, 500) })
        .where(eq(paperImportsTable.id, importId));
      res.status(500).json({ id: importId, error: "Could not read that photo." });
    }
  },
);

/**
 * POST /v1/onboarding/papers/text
 * Body: { kind, text, class_name?, form_level? }
 * The same pipeline without a camera — for a school with no vision model, or
 * a list that arrived as a WhatsApp message. The parsers are identical.
 */
router.post("/v1/onboarding/papers/text", staff, async (req, res) => {
  const kind = String(req.body?.kind ?? "roster");
  const text = String(req.body?.text ?? "");
  if (kind !== "roster" && kind !== "subjects") {
    res.status(400).json({ error: "kind must be 'roster' or 'subjects'" });
    return;
  }
  if (text.trim().length < 8) {
    res.status(400).json({ error: "Paste the list first." });
    return;
  }
  const parsed =
    kind === "roster" ? await parseRoster(text) : await parseSubjectSheet(text, await knownSubjects());
  const [created] = await db
    .insert(paperImportsTable)
    .values({
      kind,
      status: "parsed",
      uploaded_by: req.auth!.user_id,
      class_name: String(req.body?.class_name ?? "").trim() || null,
      form_level: String(req.body?.form_level ?? "").trim() || null,
      ocr_text: text.slice(0, 20_000),
      parsed: parsed.rows,
      model: parsed.model,
    })
    .returning();
  res.status(201).json({ import: created });
});

/** GET /v1/onboarding/papers — recent imports. */
router.get("/v1/onboarding/papers", staff, async (req, res) => {
  const kind = String(req.query["kind"] ?? "").trim();
  const rows = await db
    .select()
    .from(paperImportsTable)
    .where(kind ? eq(paperImportsTable.kind, kind) : (sql`true` as never))
    .orderBy(desc(paperImportsTable.created_at))
    .limit(50);
  res.json({ imports: rows });
});

/** GET /v1/onboarding/papers/:id */
router.get("/v1/onboarding/papers/:id", staff, async (req, res) => {
  const row = await loadImport(Number(req.params.id));
  if (!row) return void res.status(404).json({ error: "not found" });
  res.json({ import: row });
});

/**
 * PATCH /v1/onboarding/papers/:id
 * Body: { parsed: [...], class_name?, form_level? }
 * The teacher's corrections to the proposal, before committing.
 */
router.patch("/v1/onboarding/papers/:id", staff, async (req, res) => {
  const row = await loadImport(Number(req.params.id));
  if (!row) return void res.status(404).json({ error: "not found" });
  if (row.committed_at) return void res.status(409).json({ error: "already committed" });
  const patch: Record<string, unknown> = {};
  if (Array.isArray(req.body?.parsed)) patch["parsed"] = req.body.parsed;
  if (typeof req.body?.class_name === "string") patch["class_name"] = req.body.class_name.trim() || null;
  if (typeof req.body?.form_level === "string") patch["form_level"] = req.body.form_level.trim() || null;
  if (Object.keys(patch).length === 0) return void res.status(400).json({ error: "nothing to update" });
  const [updated] = await db
    .update(paperImportsTable)
    .set(patch)
    .where(eq(paperImportsTable.id, row.id))
    .returning();
  res.json({ import: updated });
});

/**
 * POST /v1/onboarding/papers/:id/commit
 * The only endpoint that writes students. Idempotent by name: a student who
 * already exists is enrolled into the class rather than duplicated, so
 * re-committing a re-photographed sheet is safe.
 */
router.post("/v1/onboarding/papers/:id/commit", staff, async (req, res) => {
  const row = await loadImport(Number(req.params.id));
  if (!row) return void res.status(404).json({ error: "not found" });
  if (row.committed_at) return void res.status(409).json({ error: "already committed" });
  if (row.status === "failed") return void res.status(409).json({ error: "this import failed to read" });

  try {
    const outcome =
      row.kind === "roster"
        ? await commitRoster(row.parsed as RosterRow[], row.class_name, row.form_level, row.id)
        : await commitSubjects(row.parsed as SubjectRow[], row.id);
    const [updated] = await db
      .update(paperImportsTable)
      .set({
        status: "committed",
        committed_at: new Date(),
        created_count: outcome.created,
        updated_count: outcome.updated,
      })
      .where(eq(paperImportsTable.id, row.id))
      .returning();
    res.json({ import: updated, ...outcome });
  } catch (err) {
    logger.error({ err, id: row.id }, "paper import commit failed");
    res.status(500).json({ error: "Could not save those rows." });
  }
});

// ---------------------------------------------------------------------------
// Face capture walk
// ---------------------------------------------------------------------------

/**
 * GET /v1/onboarding/face-queue?class_name=Form%202A
 * The students who still have no enrolled photo, in register order. The Lens
 * walks this list: show a name, teacher calls the student, camera opens, one
 * photo, next. Photos are uploaded to POST /v1/faces/students/:studentCode.
 */
router.get("/v1/onboarding/face-queue", staff, async (req, res) => {
  await ensureFaceTables();
  const className = String(req.query["class_name"] ?? "").trim();
  const params: unknown[] = [];
  let classFilter = "";
  if (className) {
    params.push(className);
    classFilter = `
      AND EXISTS (
        SELECT 1 FROM class_memberships cm
        JOIN classes c ON c.id = cm.class_id
        WHERE cm.student_id = u.id AND c.name = $${params.length}
      )`;
  }
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.student_code, u.grade,
            COALESCE(f.n, 0)::int AS photos
       FROM users u
       LEFT JOIN (
         SELECT student_user_id, COUNT(*) AS n
           FROM student_face_embeddings
          GROUP BY student_user_id
       ) f ON f.student_user_id = u.id
      WHERE u.role = 'student' ${classFilter}
      ORDER BY (COALESCE(f.n, 0) > 0), u.name
      LIMIT 500`,
    params,
  );
  res.json({
    students: rows.map((r: Record<string, unknown>) => ({
      id: Number(r["id"]),
      name: String(r["name"]),
      student_code: r["student_code"] ?? null,
      grade: r["grade"] ?? null,
      photos: Number(r["photos"] ?? 0),
    })),
    remaining: rows.filter((r: Record<string, unknown>) => Number(r["photos"] ?? 0) === 0).length,
  });
});

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

/** GET /v1/onboarding/subjects — who takes what, summarised. */
router.get("/v1/onboarding/subjects", staff, async (_req, res) => {
  const rows = await db
    .select({ subject: studentSubjectsTable.subject, students: sql<number>`count(*)::int` })
    .from(studentSubjectsTable)
    .groupBy(studentSubjectsTable.subject)
    .orderBy(desc(sql`count(*)`));
  res.json({ subjects: rows });
});

/**
 * POST /v1/onboarding/students/:id/subjects
 * Body: { subjects: string[] }
 * Replaces one student's subject list — the manual correction path for a
 * student the sheet missed or misread.
 */
router.post("/v1/onboarding/students/:id/subjects", staff, async (req, res) => {
  const studentId = Number(req.params.id);
  if (!Number.isInteger(studentId)) return void res.status(400).json({ error: "bad id" });
  if (!Array.isArray(req.body?.subjects)) {
    res.status(400).json({ error: "subjects must be an array" });
    return;
  }
  const subjects = [
    ...new Set(
      (req.body.subjects as unknown[]).map((s) => String(s).trim()).filter((s) => s && s.length <= 60),
    ),
  ];
  const [student] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.id, studentId), eq(usersTable.role, "student")))
    .limit(1);
  if (!student) return void res.status(404).json({ error: "no such student" });

  await db.transaction(async (tx) => {
    await tx.delete(studentSubjectsTable).where(eq(studentSubjectsTable.student_id, studentId));
    if (subjects.length > 0) {
      await tx
        .insert(studentSubjectsTable)
        .values(subjects.map((subject) => ({ student_id: studentId, subject, source: "manual" })));
    }
  });
  res.json({ ok: true, subjects });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadImport(id: number) {
  if (!Number.isInteger(id)) return null;
  const [row] = await db.select().from(paperImportsTable).where(eq(paperImportsTable.id, id)).limit(1);
  return row ?? null;
}

async function enrolledFaceCount(): Promise<number> {
  await ensureFaceTables();
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT student_user_id)::int AS n FROM student_face_embeddings`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Subjects this school teaches: what students are already recorded as
 * taking, plus what staff say they teach. Used to constrain what a subject
 * sheet is allowed to read back.
 */
async function knownSubjects(): Promise<string[]> {
  const fromStudents = await db
    .select({ subject: studentSubjectsTable.subject })
    .from(studentSubjectsTable)
    .groupBy(studentSubjectsTable.subject);
  const staffRows = await db.select({ subjects: staffProfilesTable.subjects }).from(staffProfilesTable);
  const set = new Set(fromStudents.map((r) => r.subject));
  for (const row of staffRows) {
    for (const s of Array.isArray(row.subjects) ? (row.subjects as unknown[]) : []) {
      const v = String(s).trim();
      if (v) set.add(v);
    }
  }
  if (set.size === 0) {
    // Day one: the school has told us nothing yet, so fall back to the
    // O-level core rather than letting the reader invent subject names.
    return [
      "Mathematics",
      "Physics",
      "Chemistry",
      "Biology",
      "Geography",
      "History",
      "Civics",
      "English",
      "Kiswahili",
      "Commerce",
      "Book-keeping",
      "Agriculture",
      "Computer Studies",
    ];
  }
  return [...set];
}

/** Next free student code in the school's own series, e.g. STU0043. */
async function nextStudentCode(): Promise<() => string> {
  const rows = await db
    .select({ code: usersTable.student_code })
    .from(usersTable)
    .where(eq(usersTable.role, "student"));
  let max = 0;
  for (const r of rows) {
    const m = /(\d+)\s*$/.exec(r.code ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max;
  return () => {
    n += 1;
    return `STU${String(n).padStart(4, "0")}`;
  };
}

async function commitRoster(
  rows: RosterRow[],
  className: string | null,
  formLevel: string | null,
  importId: number,
): Promise<{ created: number; updated: number; students: Array<{ id: number; name: string; student_code: string | null }> }> {
  const existing = await db
    .select({ id: usersTable.id, name: usersTable.name, student_code: usersTable.student_code })
    .from(usersTable)
    .where(eq(usersTable.role, "student"));
  const nextCode = await nextStudentCode();

  let classId: number | null = null;
  if (className) {
    const [found] = await db.select().from(classesTable).where(eq(classesTable.name, className)).limit(1);
    if (found) classId = found.id;
    else {
      const [made] = await db
        .insert(classesTable)
        .values({ name: className, grade: formLevel ?? className })
        .returning({ id: classesTable.id });
      classId = made!.id;
    }
  }

  let created = 0;
  let updated = 0;
  const students: Array<{ id: number; name: string; student_code: string | null }> = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const name = titleCase(String(row?.name ?? "").replace(/\s+/g, " ").trim());
    if (name.length < 4) continue;
    // A student the school already has keeps their id, their history and
    // their enrolled face — a re-photographed sheet must never fork them.
    const match = matchName(name, existing);
    let studentId: number;
    let code: string | null;
    if (match) {
      studentId = match.id;
      code = match.student_code;
      updated += 1;
    } else {
      const [inserted] = await db
        .insert(usersTable)
        .values({
          role: "student",
          name,
          student_code: row.student_code?.trim() || nextCode(),
          grade: formLevel ?? className ?? null,
        })
        .returning({ id: usersTable.id, student_code: usersTable.student_code });
      studentId = inserted!.id;
      code = inserted!.student_code;
      existing.push({ id: studentId, name, student_code: code });
      created += 1;
    }
    if (classId != null) {
      await db
        .insert(classMembershipsTable)
        .values({ class_id: classId, student_id: studentId })
        .onConflictDoNothing();
    }
    students.push({ id: studentId, name, student_code: code });
  }

  logger.info({ importId, created, updated, className }, "roster import committed");
  return { created, updated, students };
}

async function commitSubjects(
  rows: SubjectRow[],
  importId: number,
): Promise<{ created: number; updated: number; unmatched: string[] }> {
  const students = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.role, "student"));

  let created = 0;
  let updated = 0;
  const unmatched: string[] = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const name = String(row?.name ?? "").trim();
    const match = matchName(name, students);
    if (!match) {
      // Reported back to the teacher rather than guessed at — the wrong
      // student dropped from Physics is a term of wrong lessons.
      unmatched.push(name);
      continue;
    }
    const subjects = Array.isArray(row.subjects)
      ? [...new Set(row.subjects.map((s) => String(s).trim()).filter(Boolean))]
      : [];
    if (subjects.length === 0) continue;
    const before = await db
      .select({ subject: studentSubjectsTable.subject })
      .from(studentSubjectsTable)
      .where(eq(studentSubjectsTable.student_id, match.id));
    await db
      .insert(studentSubjectsTable)
      .values(
        subjects.map((subject) => ({
          student_id: match.id,
          subject,
          source: "paper",
          paper_import_id: importId,
          confidence: row.confidence ?? null,
        })),
      )
      .onConflictDoNothing();
    if (before.length === 0) created += 1;
    else updated += 1;
  }

  logger.info({ importId, created, updated, unmatched: unmatched.length }, "subject sheet committed");
  return { created, updated, unmatched };
}

/** GET /v1/onboarding/classes — the classes the roster import created. */
router.get("/v1/onboarding/classes", staff, async (_req, res) => {
  const rows = await db
    .select({
      id: classesTable.id,
      name: classesTable.name,
      grade: classesTable.grade,
      students: sql<number>`count(${classMembershipsTable.student_id})::int`,
    })
    .from(classesTable)
    .leftJoin(classMembershipsTable, eq(classMembershipsTable.class_id, classesTable.id))
    .groupBy(classesTable.id)
    .orderBy(classesTable.name);
  res.json({ classes: rows });
});

export default router;
