import {
  db,
  usersTable,
  classMembershipsTable,
  documentAssignmentsTable,
  documentsTable,
} from "@workspace/db";
import { eq, inArray, and, or, isNull, lte, gt } from "drizzle-orm";

export type StudentDocument = {
  id: number;
  name: string;
  subject: string;
  size_bytes: number;
  pages: number;
  content_type: string;
  created_at: string;
};

/**
 * Resolve the document catalogue for a student by joining
 *   class_memberships -> document_assignments -> documents
 * for whichever classes the student is enrolled in.
 *
 * Used by:
 *   - the watch print picker (`/print/pairing/:id`)
 *   - the parent app "Assigned documents" page
 */
export async function listDocumentsForStudent(studentCode: string): Promise<StudentDocument[]> {
  const student = (
    await db.select().from(usersTable).where(eq(usersTable.student_code, studentCode))
  )[0];
  if (!student) return [];

  const memberships = await db
    .select()
    .from(classMembershipsTable)
    .where(eq(classMembershipsTable.student_id, student.id));
  if (memberships.length === 0) return [];

  const classIds = memberships.map((m) => m.class_id);
  const now = new Date();
  // Honour scheduled_at / expires_at: a row is visible when
  //   (scheduled_at IS NULL OR scheduled_at <= now) AND
  //   (expires_at   IS NULL OR expires_at   >  now)
  const assignments = await db
    .select()
    .from(documentAssignmentsTable)
    .where(
      and(
        inArray(documentAssignmentsTable.class_id, classIds),
        or(isNull(documentAssignmentsTable.scheduled_at), lte(documentAssignmentsTable.scheduled_at, now)),
        or(isNull(documentAssignmentsTable.expires_at), gt(documentAssignmentsTable.expires_at, now)),
      ),
    );
  if (assignments.length === 0) return [];

  const docIds = Array.from(new Set(assignments.map((a) => a.document_id)));
  const docs = await db
    .select()
    .from(documentsTable)
    .where(inArray(documentsTable.id, docIds));

  return docs.map((d) => ({
    id: d.id,
    name: d.name,
    subject: d.subject,
    size_bytes: d.size_bytes,
    pages: d.pages,
    content_type: d.content_type,
    created_at: (d.created_at as Date).toISOString(),
  }));
}
