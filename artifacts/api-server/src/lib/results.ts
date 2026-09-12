import { pool } from "@workspace/db";
import {
  NECTA_O_LEVEL,
  SCORE_METHODS,
  gradeFor,
  levelForClassGrade,
  nectaDivision,
  nectaScale,
  officialScore,
  rankPositions,
  round1,
  subjectScores,
  validateBands,
  type ExamScore,
  type GradeBand,
  type ScoreMethod,
  type SubjectScores,
} from "./grading";
import { publishResult } from "./results-events";

export { ordinal } from "./grading";

// Exam results, report cards and scoreboards.
//
// Teachers set up exams (class, subject, term, total marks, CA or terminal).
// Every marked paper — from Teacher Lens glasses, the dashboard, or later an
// MCQ attempt — upserts one exam_results row and is published live. Report
// cards and scoreboards are computed on read, so they always reflect the latest
// mark and the school's current grading settings.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
export type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: Row[] }> };

export class ResultsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ResultsError";
    this.status = status;
  }
}

export type TvScoreboardMode = "off" | "top5" | "full";
export const TV_SCOREBOARD_MODES: TvScoreboardMode[] = ["off", "top5", "full"];
const DEFAULT_SCHEME_NAME = "School scale";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let tablesReady: Promise<void> | null = null;

export function ensureResultsTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS academic_terms (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          academic_year TEXT NOT NULL,
          starts_on DATE,
          ends_on DATE,
          is_current BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (academic_year, name)
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS grading_schemes (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          bands JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS results_settings (
          id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          primary_scheme_id INTEGER REFERENCES grading_schemes(id) ON DELETE SET NULL,
          official_method TEXT NOT NULL DEFAULT 'weighted',
          ca_weight NUMERIC NOT NULL DEFAULT 30,
          exam_weight NUMERIC NOT NULL DEFAULT 70,
          tv_scoreboard TEXT NOT NULL DEFAULT 'top5',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS result_exams (
          id SERIAL PRIMARY KEY,
          term_id INTEGER NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
          class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
          subject TEXT NOT NULL,
          title TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('ca', 'terminal')),
          total_marks NUMERIC NOT NULL CHECK (total_marks > 0),
          held_on DATE,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS result_exams_class_term_idx ON result_exams (class_id, term_id)`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS exam_results (
          id SERIAL PRIMARY KEY,
          exam_id INTEGER NOT NULL REFERENCES result_exams(id) ON DELETE CASCADE,
          student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          marks NUMERIC NOT NULL CHECK (marks >= 0),
          percent NUMERIC NOT NULL,
          source TEXT NOT NULL,
          graded_paper_id INTEGER,
          recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (exam_id, student_id)
        )
      `);
      await pool.query(
        `INSERT INTO grading_schemes (name, bands) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO NOTHING`,
        [DEFAULT_SCHEME_NAME, JSON.stringify(NECTA_O_LEVEL)],
      );
      await pool.query(
        `INSERT INTO results_settings (id, primary_scheme_id)
         VALUES (1, (SELECT id FROM grading_schemes WHERE name = $1))
         ON CONFLICT (id) DO NOTHING`,
        [DEFAULT_SCHEME_NAME],
      );
    })().catch((err) => {
      tablesReady = null;
      throw err;
    });
  }
  return tablesReady;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !DATE_RE.test(value)) throw new ResultsError(400, `${field} must be YYYY-MM-DD`);
  return value;
}

// ---------------------------------------------------------------------------
// Settings and grading schemes
// ---------------------------------------------------------------------------

export type ResultsSettings = {
  official_method: ScoreMethod;
  ca_weight: number;
  exam_weight: number;
  tv_scoreboard: TvScoreboardMode;
  primary_scheme: { id: number; name: string; bands: GradeBand[] } | null;
};

export async function getResultsSettings(): Promise<ResultsSettings> {
  await ensureResultsTables();
  const { rows } = await pool.query(
    `SELECT s.official_method, s.ca_weight, s.exam_weight, s.tv_scoreboard,
            g.id AS scheme_id, g.name AS scheme_name, g.bands
     FROM results_settings s
     LEFT JOIN grading_schemes g ON g.id = s.primary_scheme_id
     WHERE s.id = 1`,
  );
  const row: Row = rows[0] ?? {};
  return {
    official_method: SCORE_METHODS.includes(row.official_method) ? row.official_method : "weighted",
    ca_weight: Number(row.ca_weight ?? 30),
    exam_weight: Number(row.exam_weight ?? 70),
    tv_scoreboard: TV_SCOREBOARD_MODES.includes(row.tv_scoreboard) ? row.tv_scoreboard : "top5",
    primary_scheme: row.scheme_id ? { id: Number(row.scheme_id), name: row.scheme_name, bands: row.bands } : null,
  };
}

export async function updateResultsSettings(patch: Row): Promise<ResultsSettings> {
  await ensureResultsTables();
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.official_method !== undefined) {
    if (!SCORE_METHODS.includes(patch.official_method)) {
      throw new ResultsError(400, `official_method must be one of: ${SCORE_METHODS.join(", ")}`);
    }
    set("official_method", patch.official_method);
  }
  for (const key of ["ca_weight", "exam_weight"]) {
    if (patch[key] === undefined) continue;
    const value = Number(patch[key]);
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new ResultsError(400, `${key} must be from 0 to 100`);
    set(key, value);
  }
  if (patch.tv_scoreboard !== undefined) {
    if (!TV_SCOREBOARD_MODES.includes(patch.tv_scoreboard)) {
      throw new ResultsError(400, `tv_scoreboard must be one of: ${TV_SCOREBOARD_MODES.join(", ")}`);
    }
    set("tv_scoreboard", patch.tv_scoreboard);
  }
  if (patch.primary_scheme_id !== undefined) {
    const id = positiveInt(patch.primary_scheme_id);
    const { rows } = await pool.query(`SELECT id FROM grading_schemes WHERE id = $1`, [id]);
    if (!rows[0]) throw new ResultsError(404, "grading scheme not found");
    set("primary_scheme_id", id);
  }
  if (sets.length > 0) {
    await pool.query(`UPDATE results_settings SET ${sets.join(", ")}, updated_at = NOW() WHERE id = 1`, values);
  }
  return getResultsSettings();
}

export async function listGradingSchemes(): Promise<Row[]> {
  await ensureResultsTables();
  return (await pool.query(`SELECT id, name, bands, created_at FROM grading_schemes ORDER BY id`)).rows;
}

export async function saveGradingScheme(id: number | null, input: Row): Promise<Row> {
  await ensureResultsTables();
  const name = input.name === undefined && id !== null ? undefined : text(input.name, 80);
  if (name === null) throw new ResultsError(400, "name is required (up to 80 characters)");
  let bands: GradeBand[] | undefined;
  if (input.bands !== undefined || id === null) {
    const problem = validateBands(input.bands);
    if (problem) throw new ResultsError(400, problem);
    bands = (input.bands as GradeBand[])
      .map((band) => ({
        grade: band.grade.trim(),
        min: band.min,
        ...(band.points !== undefined ? { points: band.points } : {}),
        ...(band.remark ? { remark: String(band.remark).slice(0, 60) } : {}),
      }))
      .sort((a, b) => b.min - a.min);
  }
  if (id === null) {
    return (
      await pool.query(`INSERT INTO grading_schemes (name, bands) VALUES ($1, $2::jsonb) RETURNING *`, [name, JSON.stringify(bands)])
    ).rows[0]!;
  }
  const { rows } = await pool.query(
    `UPDATE grading_schemes
     SET name = COALESCE($2, name), bands = COALESCE($3::jsonb, bands)
     WHERE id = $1 RETURNING *`,
    [id, name ?? null, bands ? JSON.stringify(bands) : null],
  );
  if (!rows[0]) throw new ResultsError(404, "grading scheme not found");
  return rows[0];
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

export async function listTerms(): Promise<Row[]> {
  await ensureResultsTables();
  return (
    await pool.query(`SELECT * FROM academic_terms ORDER BY is_current DESC, academic_year DESC, starts_on DESC NULLS LAST, id DESC`)
  ).rows;
}

export async function createTerm(input: Row): Promise<Row> {
  await ensureResultsTables();
  const name = text(input.name, 60);
  const year = text(input.academic_year, 20);
  if (!name || !year) throw new ResultsError(400, "name and academic_year are required");
  const startsOn = optionalDate(input.starts_on, "starts_on");
  const endsOn = optionalDate(input.ends_on, "ends_on");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.is_current === true) await client.query(`UPDATE academic_terms SET is_current = FALSE WHERE is_current`);
    const { rows } = await client.query(
      `INSERT INTO academic_terms (name, academic_year, starts_on, ends_on, is_current)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, year, startsOn, endsOn, input.is_current === true],
    );
    await client.query("COMMIT");
    return rows[0]!;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function setCurrentTerm(id: number): Promise<Row> {
  await ensureResultsTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE academic_terms SET is_current = FALSE WHERE is_current`);
    const { rows } = await client.query(`UPDATE academic_terms SET is_current = TRUE WHERE id = $1 RETURNING *`, [id]);
    if (!rows[0]) throw new ResultsError(404, "term not found");
    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** The requested term, else the current term, else the most recent one. */
export async function resolveTermId(requested?: unknown): Promise<number> {
  await ensureResultsTables();
  const id = positiveInt(requested);
  if (id !== null) {
    const { rows } = await pool.query(`SELECT id FROM academic_terms WHERE id = $1`, [id]);
    if (!rows[0]) throw new ResultsError(404, "term not found");
    return id;
  }
  const { rows } = await pool.query(
    `SELECT id FROM academic_terms ORDER BY is_current DESC, starts_on DESC NULLS LAST, id DESC LIMIT 1`,
  );
  if (!rows[0]) throw new ResultsError(404, "No academic term yet — create one under Results settings first.");
  return Number(rows[0].id);
}

// ---------------------------------------------------------------------------
// Exams and results
// ---------------------------------------------------------------------------

export type ExamRow = {
  id: number;
  term_id: number;
  class_id: number;
  subject: string;
  title: string;
  kind: "ca" | "terminal";
  total_marks: number;
  held_on: string | null;
  status: "open" | "closed";
  created_by: number | null;
  class_name?: string;
  term_name?: string;
  results_recorded?: number;
};

function toExam(row: Row): ExamRow {
  return {
    ...row,
    id: Number(row.id),
    term_id: Number(row.term_id),
    class_id: Number(row.class_id),
    total_marks: Number(row.total_marks),
    ...(row.results_recorded !== undefined ? { results_recorded: Number(row.results_recorded) } : {}),
  } as ExamRow;
}

export async function listExams(filter: { classId?: number | null; termId?: number | null; status?: string | null }): Promise<ExamRow[]> {
  await ensureResultsTables();
  const where: string[] = [];
  const values: unknown[] = [];
  if (filter.classId) {
    values.push(filter.classId);
    where.push(`e.class_id = $${values.length}`);
  }
  if (filter.termId) {
    values.push(filter.termId);
    where.push(`e.term_id = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    where.push(`e.status = $${values.length}`);
  }
  const { rows } = await pool.query(
    `SELECT e.*, c.name AS class_name, t.name AS term_name,
            (SELECT COUNT(*) FROM exam_results r WHERE r.exam_id = e.id) AS results_recorded
     FROM result_exams e
     JOIN classes c ON c.id = e.class_id
     JOIN academic_terms t ON t.id = e.term_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY e.status, e.held_on DESC NULLS LAST, e.id DESC`,
    values,
  );
  return rows.map(toExam);
}

export async function getExam(id: number, db: Queryable = pool): Promise<ExamRow | null> {
  await ensureResultsTables();
  const { rows } = await db.query(
    `SELECT e.*, c.name AS class_name, t.name AS term_name
     FROM result_exams e JOIN classes c ON c.id = e.class_id JOIN academic_terms t ON t.id = e.term_id
     WHERE e.id = $1`,
    [id],
  );
  return rows[0] ? toExam(rows[0]) : null;
}

export async function createExam(input: Row, createdBy: number | null): Promise<ExamRow> {
  await ensureResultsTables();
  const classId = positiveInt(input.class_id);
  if (classId === null) throw new ResultsError(400, "class_id is required");
  const { rows: classRows } = await pool.query(`SELECT id FROM classes WHERE id = $1`, [classId]);
  if (!classRows[0]) throw new ResultsError(404, "class not found");
  const termId = await resolveTermId(input.term_id);
  const subject = text(input.subject, 100);
  const title = text(input.title, 200);
  if (!subject || !title) throw new ResultsError(400, "subject and title are required");
  if (input.kind !== "ca" && input.kind !== "terminal") throw new ResultsError(400, "kind must be ca or terminal");
  const totalMarks = Number(input.total_marks);
  if (!Number.isFinite(totalMarks) || totalMarks <= 0 || totalMarks > 1000) {
    throw new ResultsError(400, "total_marks must be more than 0 and at most 1000");
  }
  const { rows } = await pool.query(
    `INSERT INTO result_exams (term_id, class_id, subject, title, kind, total_marks, held_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [termId, classId, subject, title, input.kind, totalMarks, optionalDate(input.held_on, "held_on"), createdBy],
  );
  return (await getExam(Number(rows[0]!.id)))!;
}

export async function updateExam(id: number, patch: Row): Promise<ExamRow> {
  const exam = await getExam(id);
  if (!exam) throw new ResultsError(404, "exam not found");
  const title = patch.title === undefined ? exam.title : text(patch.title, 200);
  if (!title) throw new ResultsError(400, "title must be 1–200 characters");
  let totalMarks = exam.total_marks;
  if (patch.total_marks !== undefined) {
    totalMarks = Number(patch.total_marks);
    if (!Number.isFinite(totalMarks) || totalMarks <= 0 || totalMarks > 1000) {
      throw new ResultsError(400, "total_marks must be more than 0 and at most 1000");
    }
    const { rows } = await pool.query(`SELECT MAX(marks) AS top FROM exam_results WHERE exam_id = $1`, [id]);
    if (rows[0]?.top !== null && Number(rows[0]?.top) > totalMarks) {
      throw new ResultsError(409, `a recorded result already has ${rows[0]!.top} marks`);
    }
  }
  const status = patch.status === undefined ? exam.status : patch.status;
  if (status !== "open" && status !== "closed") throw new ResultsError(400, "status must be open or closed");
  const heldOn = patch.held_on === undefined ? exam.held_on : optionalDate(patch.held_on, "held_on");
  await pool.query(
    `UPDATE result_exams SET title = $2, total_marks = $3, status = $4, held_on = $5 WHERE id = $1`,
    [id, title, totalMarks, status, heldOn],
  );
  // Percentages follow the exam total.
  await pool.query(`UPDATE exam_results SET percent = ROUND(marks / $2 * 1000) / 10 WHERE exam_id = $1`, [id, totalMarks]);
  return (await getExam(id))!;
}

export async function findClassStudent(
  classId: number,
  studentCode: string,
): Promise<{ id: number; name: string; student_code: string } | null> {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.student_code
     FROM class_memberships m JOIN users u ON u.id = m.student_id
     WHERE m.class_id = $1 AND u.student_code = $2`,
    [classId, studentCode],
  );
  return rows[0] ? { id: Number(rows[0].id), name: rows[0].name, student_code: rows[0].student_code } : null;
}

/** The exam and every student in its class, with their result if recorded. */
export async function examResultSheet(examId: number): Promise<{ exam: ExamRow; students: Row[] }> {
  const exam = await getExam(examId);
  if (!exam) throw new ResultsError(404, "exam not found");
  const { rows } = await pool.query(
    `SELECT u.id AS student_id, u.name, u.student_code, r.marks, r.percent, r.source, r.recorded_at
     FROM class_memberships m
     JOIN users u ON u.id = m.student_id
     LEFT JOIN exam_results r ON r.exam_id = $1 AND r.student_id = u.id
     WHERE m.class_id = $2
     ORDER BY u.name`,
    [examId, exam.class_id],
  );
  return {
    exam,
    students: rows.map((row) => ({
      ...row,
      student_id: Number(row.student_id),
      marks: row.marks === null ? null : Number(row.marks),
      percent: row.percent === null ? null : Number(row.percent),
    })),
  };
}

export async function recordExamResult(
  db: Queryable,
  args: { examId: number; studentId: number; marks: number; source: string; gradedPaperId?: number | null; recordedBy?: number | null },
): Promise<{ exam: ExamRow; result: Row }> {
  await ensureResultsTables();
  const exam = await getExam(args.examId, db);
  if (!exam) throw new ResultsError(404, "exam not found");
  if (exam.status !== "open") throw new ResultsError(409, "exam is closed — reopen it to record results");
  const { rows: member } = await db.query(`SELECT 1 FROM class_memberships WHERE class_id = $1 AND student_id = $2`, [
    exam.class_id,
    args.studentId,
  ]);
  if (!member[0]) throw new ResultsError(400, "student is not in this exam's class");
  if (!Number.isFinite(args.marks) || args.marks < 0 || args.marks > exam.total_marks) {
    throw new ResultsError(400, `marks must be from 0 to ${exam.total_marks}`);
  }
  const percent = round1((args.marks / exam.total_marks) * 100);
  const { rows } = await db.query(
    `INSERT INTO exam_results (exam_id, student_id, marks, percent, source, graded_paper_id, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (exam_id, student_id) DO UPDATE
       SET marks = EXCLUDED.marks, percent = EXCLUDED.percent, source = EXCLUDED.source,
           graded_paper_id = EXCLUDED.graded_paper_id, recorded_by = EXCLUDED.recorded_by, recorded_at = NOW()
     RETURNING *`,
    [args.examId, args.studentId, args.marks, percent, args.source, args.gradedPaperId ?? null, args.recordedBy ?? null],
  );
  const result = rows[0]!;
  return { exam, result: { ...result, marks: Number(result.marks), percent: Number(result.percent) } };
}

export async function removeExamResult(examId: number, studentId: number): Promise<ExamRow> {
  const exam = await getExam(examId);
  if (!exam) throw new ResultsError(404, "exam not found");
  if (exam.status !== "open") throw new ResultsError(409, "exam is closed — reopen it to change results");
  const { rows } = await pool.query(`DELETE FROM exam_results WHERE exam_id = $1 AND student_id = $2 RETURNING id`, [
    examId,
    studentId,
  ]);
  if (!rows[0]) throw new ResultsError(404, "no result recorded for this student");
  return exam;
}

/** Publishes a change so live scoreboards update. Call after the write is committed. */
export function announceResult(
  exam: ExamRow,
  student: { id: number; name: string | null; student_code: string | null },
  result: { marks: number; percent: number } | null,
): void {
  publishResult({
    type: result ? "result_recorded" : "result_removed",
    exam_id: exam.id,
    class_id: exam.class_id,
    term_id: exam.term_id,
    subject: exam.subject,
    exam_title: exam.title,
    student_id: student.id,
    student_code: student.student_code,
    student_name: student.name,
    marks: result ? result.marks : null,
    percent: result ? result.percent : null,
    total_marks: exam.total_marks,
    at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Report cards and scoreboards
// ---------------------------------------------------------------------------

export type SubjectResult = {
  student_id: number;
  student_code: string | null;
  name: string;
  scores: SubjectScores;
  score: number;
  school_grade: string;
  school_remark: string | null;
  necta_grade: string;
  necta_points: number;
  position: number;
};

export type OverallResult = {
  student_id: number;
  student_code: string | null;
  name: string;
  subjects_sat: number;
  total: number;
  average: number;
  school_grade: string;
  division: { division: string; points: number; subjects_counted: number } | null;
  position: number;
};

export type ClassResults = {
  class: { id: number; name: string; grade: string };
  term: Row;
  level: "o_level" | "a_level";
  method: ScoreMethod;
  official_method: ScoreMethod;
  methods: ScoreMethod[];
  weights: { ca: number; exam: number };
  school_scheme: { name: string; bands: GradeBand[] };
  necta_scale: GradeBand[];
  exams: ExamRow[];
  students_in_class: number;
  subjects: Array<{ subject: string; sat: number; rows: SubjectResult[] }>;
  overall: OverallResult[];
};

export async function computeClassResults(classId: number, termId: number, methodOverride?: ScoreMethod): Promise<ClassResults> {
  await ensureResultsTables();
  const settings = await getResultsSettings();
  const method = methodOverride ?? settings.official_method;
  const { rows: classRows } = await pool.query(`SELECT id, name, grade FROM classes WHERE id = $1`, [classId]);
  if (!classRows[0]) throw new ResultsError(404, "class not found");
  const { rows: termRows } = await pool.query(`SELECT * FROM academic_terms WHERE id = $1`, [termId]);
  if (!termRows[0]) throw new ResultsError(404, "term not found");

  const level = levelForClassGrade(classRows[0].grade);
  const nectaBands = nectaScale(level);
  const schoolBands = settings.primary_scheme?.bands ?? NECTA_O_LEVEL;
  const weights = { ca: settings.ca_weight, exam: settings.exam_weight };

  const { rows: students } = await pool.query(
    `SELECT u.id, u.name, u.student_code FROM class_memberships m JOIN users u ON u.id = m.student_id
     WHERE m.class_id = $1 ORDER BY u.name`,
    [classId],
  );
  const exams = await listExams({ classId, termId });
  const { rows: marks } = await pool.query(
    `SELECT e.subject, e.kind, r.student_id, r.percent
     FROM result_exams e JOIN exam_results r ON r.exam_id = e.id
     WHERE e.class_id = $1 AND e.term_id = $2`,
    [classId, termId],
  );

  const bySubject = new Map<string, Map<number, ExamScore[]>>();
  for (const row of marks) {
    const perStudent = bySubject.get(row.subject) ?? new Map<number, ExamScore[]>();
    const list = perStudent.get(Number(row.student_id)) ?? [];
    list.push({ kind: row.kind, percent: Number(row.percent) });
    perStudent.set(Number(row.student_id), list);
    bySubject.set(row.subject, perStudent);
  }

  const subjects = [...new Set(exams.map((exam) => exam.subject))].sort((a, b) => a.localeCompare(b)).map((subject) => {
    const entries = students
      .map((student) => {
        const scores = subjectScores(bySubject.get(subject)?.get(Number(student.id)) ?? [], weights);
        return { student, scores, score: officialScore(scores, method) };
      })
      .filter((entry): entry is { student: Row; scores: SubjectScores; score: number } => entry.score !== null);
    const positions = rankPositions(entries.map((entry) => ({ key: Number(entry.student.id), score: entry.score })));
    const rows: SubjectResult[] = entries
      .map((entry) => {
        const school = gradeFor(entry.score, schoolBands);
        const necta = gradeFor(entry.score, nectaBands);
        return {
          student_id: Number(entry.student.id),
          student_code: entry.student.student_code,
          name: entry.student.name,
          scores: entry.scores,
          score: entry.score,
          school_grade: school.grade,
          school_remark: school.remark ?? null,
          necta_grade: necta.grade,
          necta_points: necta.points ?? 0,
          position: positions.get(Number(entry.student.id))!,
        };
      })
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    return { subject, sat: rows.length, rows };
  });

  const overallEntries = students
    .map((student) => {
      const results = subjects
        .map((board) => board.rows.find((row) => row.student_id === Number(student.id)))
        .filter((row): row is SubjectResult => row !== undefined);
      if (results.length === 0) return null;
      const total = results.reduce((sum, row) => sum + row.score, 0);
      const average = round1(total / results.length);
      return {
        student_id: Number(student.id),
        student_code: student.student_code,
        name: student.name,
        subjects_sat: results.length,
        total: round1(total),
        average,
        school_grade: gradeFor(average, schoolBands).grade,
        division: nectaDivision(level, results.map((row) => row.necta_points)),
      };
    })
    .filter((entry): entry is Omit<OverallResult, "position"> => entry !== null);
  const overallPositions = rankPositions(overallEntries.map((entry) => ({ key: entry.student_id, score: entry.average })));
  const overall = overallEntries
    .map((entry) => ({ ...entry, position: overallPositions.get(entry.student_id)! }))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

  return {
    class: { id: Number(classRows[0].id), name: classRows[0].name, grade: classRows[0].grade },
    term: termRows[0],
    level,
    method,
    official_method: settings.official_method,
    methods: SCORE_METHODS,
    weights,
    school_scheme: { name: settings.primary_scheme?.name ?? "NECTA O-level", bands: schoolBands },
    necta_scale: nectaBands,
    exams,
    students_in_class: students.length,
    subjects,
    overall,
  };
}

/** One student's report card: per class, their subjects, total, average, grades and positions. */
export async function studentReportCard(studentId: number, termId: number, method?: ScoreMethod): Promise<Row> {
  await ensureResultsTables();
  const { rows: studentRows } = await pool.query(`SELECT id, name, student_code, grade FROM users WHERE id = $1 AND role = 'student'`, [
    studentId,
  ]);
  if (!studentRows[0]) throw new ResultsError(404, "student not found");
  const { rows: memberships } = await pool.query(`SELECT class_id FROM class_memberships WHERE student_id = $1 ORDER BY class_id`, [
    studentId,
  ]);
  const classes = [];
  let term: Row | null = null;
  for (const membership of memberships) {
    const board = await computeClassResults(Number(membership.class_id), termId, method);
    term = board.term;
    const overall = board.overall.find((row) => row.student_id === studentId) ?? null;
    classes.push({
      class: board.class,
      level: board.level,
      method: board.method,
      official_method: board.official_method,
      weights: board.weights,
      school_scheme: board.school_scheme,
      necta_scale: board.necta_scale,
      subjects: board.subjects.flatMap((subject) => {
        const row = subject.rows.find((r) => r.student_id === studentId);
        if (!row) return [];
        const { student_id: _id, student_code: _code, name: _name, ...result } = row;
        return [{ subject: subject.subject, ...result, out_of: subject.sat }];
      }),
      total: overall?.total ?? null,
      average: overall?.average ?? null,
      school_grade: overall?.school_grade ?? null,
      division: overall?.division ?? null,
      position: overall?.position ?? null,
      out_of: board.overall.length,
      students_in_class: board.students_in_class,
    });
  }
  if (!term) term = (await pool.query(`SELECT * FROM academic_terms WHERE id = $1`, [termId])).rows[0] ?? null;
  return {
    student: { id: Number(studentRows[0].id), name: studentRows[0].name, student_code: studentRows[0].student_code },
    term,
    classes,
  };
}

/** A student's grade and positions right after a mark is recorded (for the glasses whisper). */
export async function studentStanding(
  classId: number,
  termId: number,
  studentId: number,
  subject: string,
): Promise<{ score: number; school_grade: string; necta_grade: string; subject_position: number; subject_out_of: number; overall_position: number | null; overall_out_of: number } | null> {
  const board = await computeClassResults(classId, termId);
  const subjectBoard = board.subjects.find((entry) => entry.subject === subject);
  const row = subjectBoard?.rows.find((entry) => entry.student_id === studentId);
  if (!subjectBoard || !row) return null;
  const overall = board.overall.find((entry) => entry.student_id === studentId);
  return {
    score: row.score,
    school_grade: row.school_grade,
    necta_grade: row.necta_grade,
    subject_position: row.position,
    subject_out_of: subjectBoard.sat,
    overall_position: overall?.position ?? null,
    overall_out_of: board.overall.length,
  };
}

/** What the classroom TV may show, following the school's tv_scoreboard setting. */
export async function classroomScoreboard(classId: number, termId: number): Promise<Row> {
  const settings = await getResultsSettings();
  if (settings.tv_scoreboard === "off") return { enabled: false, mode: "off" };
  const board = await computeClassResults(classId, termId);
  const limit = settings.tv_scoreboard === "top5" ? 5 : Number.POSITIVE_INFINITY;
  const publicRow = (row: { position: number; name: string; school_grade: string }, score: number) => ({
    position: row.position,
    name: row.name,
    score,
    grade: row.school_grade,
  });
  return {
    enabled: true,
    mode: settings.tv_scoreboard,
    class: board.class,
    term: { id: board.term.id, name: board.term.name, academic_year: board.term.academic_year },
    method: board.method,
    subjects: board.subjects.map((subject) => ({
      subject: subject.subject,
      rows: subject.rows.slice(0, limit).map((row) => publicRow(row, row.score)),
    })),
    overall: board.overall.slice(0, limit).map((row) => publicRow(row, row.average)),
  };
}
