import { pool } from "@workspace/db";
import { k9RuntimePost } from "./k9-runtime";

// Enrolled student faces for Teacher Lens lookup. Each photo stores the SFace
// embedding of its largest face (from the K9 runtime); the K9 worker matches a
// lens frame against every student's embeddings by cosine similarity.

export class FaceGalleryError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Photos kept per student; enrolling more replaces the oldest. */
const MAX_FACES_PER_STUDENT = 10;

let tablesReady: Promise<void> | null = null;
export function ensureFaceTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS student_face_embeddings (
          id SERIAL PRIMARY KEY,
          student_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          embedding JSONB NOT NULL,
          source TEXT NOT NULL DEFAULT 'dashboard',
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS student_face_embeddings_student_idx
          ON student_face_embeddings (student_user_id)
      `);
    })().catch((err) => {
      tablesReady = null;
      throw err;
    });
  }
  return tablesReady;
}

type RuntimeFace = { box: number[]; score: number; embedding?: number[] };

const area = (box: number[]) => Math.max(0, (box[2] ?? 0) - (box[0] ?? 0)) * Math.max(0, (box[3] ?? 0) - (box[1] ?? 0));

async function findStudent(studentCode: string): Promise<{ id: number; name: string; student_code: string } | null> {
  const { rows } = await pool.query(`SELECT id, name, student_code FROM users WHERE student_code = $1 AND role = 'student'`, [
    studentCode,
  ]);
  return rows[0] ? { id: Number(rows[0].id), name: rows[0].name, student_code: rows[0].student_code } : null;
}

/** Finds the largest face in a photo and adds its embedding to the student's gallery. */
export async function enrollStudentFace(
  studentCode: string,
  image: Buffer,
  opts: { source: string; createdBy: number | null },
): Promise<{ student: { id: number; name: string; student_code: string }; faces_in_photo: number; enrolled: number }> {
  await ensureFaceTables();
  const student = await findStudent(studentCode);
  if (!student) throw new FaceGalleryError(404, "student not found");

  let faces: RuntimeFace[];
  try {
    ({ faces } = await k9RuntimePost<{ faces: RuntimeFace[] }>("/v1/faces", { image: image.toString("base64"), embed: true }));
  } catch (err) {
    throw new FaceGalleryError(503, `The K9 model runtime couldn't read the photo: ${err instanceof Error ? err.message : String(err)}`);
  }
  const embedded = (faces ?? []).filter((face) => Array.isArray(face.embedding) && face.embedding.length > 0);
  if (embedded.length === 0) {
    throw new FaceGalleryError(422, "No face found in the photo — use a clear photo of the student facing the camera.");
  }
  const largest = embedded.reduce((best, face) => (area(face.box) > area(best.box) ? face : best));

  await pool.query(
    `INSERT INTO student_face_embeddings (student_user_id, embedding, source, created_by) VALUES ($1, $2::jsonb, $3, $4)`,
    [student.id, JSON.stringify(largest.embedding), opts.source, opts.createdBy],
  );
  await pool.query(
    `DELETE FROM student_face_embeddings
     WHERE student_user_id = $1
       AND id NOT IN (
         SELECT id FROM student_face_embeddings WHERE student_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2
       )`,
    [student.id, MAX_FACES_PER_STUDENT],
  );
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM student_face_embeddings WHERE student_user_id = $1`, [student.id]);
  return { student, faces_in_photo: embedded.length, enrolled: Number(rows[0]?.n ?? 0) };
}

/** Enrolled photo count per student_code. */
export async function faceCounts(): Promise<Record<string, number>> {
  await ensureFaceTables();
  const { rows } = await pool.query(
    `SELECT u.student_code, COUNT(*)::int AS n
     FROM student_face_embeddings f JOIN users u ON u.id = f.student_user_id
     WHERE u.student_code IS NOT NULL
     GROUP BY u.student_code`,
  );
  return Object.fromEntries(rows.map((row) => [row.student_code, Number(row.n)]));
}

export async function removeStudentFaces(studentCode: string): Promise<number> {
  await ensureFaceTables();
  const { rowCount } = await pool.query(
    `DELETE FROM student_face_embeddings WHERE student_user_id IN (SELECT id FROM users WHERE student_code = $1)`,
    [studentCode],
  );
  return rowCount ?? 0;
}

/** Every enrolled student with their embeddings, for the worker's matcher. */
export async function faceGallery(): Promise<Array<{ student_code: string; name: string; embeddings: number[][] }>> {
  await ensureFaceTables();
  const { rows } = await pool.query(
    `SELECT u.student_code, u.name, json_agg(f.embedding ORDER BY f.id) AS embeddings
     FROM student_face_embeddings f JOIN users u ON u.id = f.student_user_id
     WHERE u.student_code IS NOT NULL
     GROUP BY u.student_code, u.name`,
  );
  return rows.map((row) => ({ student_code: row.student_code, name: row.name, embeddings: row.embeddings }));
}
