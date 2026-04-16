import { db, usersTable, classesTable, classMembershipsTable, documentsTable, documentAssignmentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import { ObjectStorageService } from "./objectStorage";

/**
 * Idempotent demo seed. Ensures the pilot fixtures (one teacher, one class,
 * the legacy TEST001 student, two sample documents) exist so the print
 * picker has real data to show on a fresh database.
 */
export async function seedDemoData(): Promise<void> {
  // --- demo teacher -------------------------------------------------------
  let teacher = (await db.select().from(usersTable).where(eq(usersTable.email, "teacher@school.tz")))[0];
  if (!teacher) {
    [teacher] = await db.insert(usersTable).values({
      role: "teacher",
      name: "Ms. Sarah Kamau",
      email: "teacher@school.tz",
      password_hash: hashPin("teacher123"),
    }).returning();
  }

  // --- demo admin (so both demo logins issue real JWTs) -------------------
  const admin = (await db.select().from(usersTable).where(eq(usersTable.email, "admin@school.tz")))[0];
  if (!admin) {
    await db.insert(usersTable).values({
      role: "admin",
      name: "Admin User",
      email: "admin@school.tz",
      password_hash: hashPin("admin123"),
    });
  }

  // --- demo student TEST001 ----------------------------------------------
  let student = (await db.select().from(usersTable).where(eq(usersTable.student_code, "TEST001")))[0];
  if (!student) {
    [student] = await db.insert(usersTable).values({
      role: "student",
      name: "John Doe",
      student_code: "TEST001",
      grade: "Form 1",
    }).returning();
  }

  // --- demo class + membership -------------------------------------------
  let cls = (await db.select().from(classesTable).where(eq(classesTable.name, "Form 1A")))[0];
  if (!cls) {
    [cls] = await db.insert(classesTable).values({
      name: "Form 1A",
      grade: "Form 1",
      teacher_id: teacher.id,
    }).returning();
  }
  const memberships = await db.select().from(classMembershipsTable).where(eq(classMembershipsTable.class_id, cls.id));
  if (!memberships.find((m) => m.student_id === student.id)) {
    await db.insert(classMembershipsTable).values({ class_id: cls.id, student_id: student.id });
  }

  // --- demo documents -----------------------------------------------------
  // Each demo doc is a real PDF blob written to object storage so the
  // tap-box `/document` endpoint serves real bytes end-to-end.
  const docs = [
    { name: "Mathematics Homework Week 12", subject: "Mathematics", body: "Math Homework Week 12\n\n1. Solve for x: 2x + 5 = 17\n2. What is the area of a rectangle 6 by 8?\n" },
    { name: "Biology Class Notes - Cells", subject: "Science", body: "Biology Notes — Cells\n\nCells are the basic unit of life. Plant and animal cells differ in...\n" },
  ];
  const objStore = new ObjectStorageService();

  for (const d of docs) {
    const existing = (await db.select().from(documentsTable).where(eq(documentsTable.name, d.name)))[0];
    let doc = existing;
    if (!doc) {
      const pdf = buildSimplePdf(d.body);
      const objectPath = await uploadDemoPdf(objStore, pdf);
      [doc] = await db.insert(documentsTable).values({
        name: d.name,
        subject: d.subject,
        pages: 1,
        size_bytes: pdf.length,
        content_type: "application/pdf",
        object_path: objectPath,
        uploaded_by: teacher.id,
      }).returning();
    }
    const assignments = await db.select().from(documentAssignmentsTable).where(eq(documentAssignmentsTable.document_id, doc.id));
    if (!assignments.find((a) => a.class_id === cls.id)) {
      await db.insert(documentAssignmentsTable).values({ document_id: doc.id, class_id: cls.id });
    }
  }
}

function hashPin(pin: string): string {
  // Simple salted SHA-256 — for the demo creds only. A real auth flow should
  // use bcrypt/argon2; out of scope for this task per the brief.
  return crypto.createHash("sha256").update(`kobeai:${pin}`).digest("hex");
}

export function checkPin(pin: string, hash: string | null | undefined): boolean {
  if (!hash) return false;
  return crypto.timingSafeEqual(Buffer.from(hashPin(pin)), Buffer.from(hash));
}

async function uploadDemoPdf(svc: ObjectStorageService, pdf: Buffer): Promise<string> {
  // Use a presigned URL to push the bytes into the private object dir, then
  // normalize the GCS URL back to our /objects/<id> path.
  const uploadUrl = await svc.getObjectEntityUploadURL();
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: pdf,
  });
  if (!res.ok) throw new Error(`seed upload failed: ${res.status}`);
  return svc.normalizeObjectEntityPath(uploadUrl.split("?")[0]!);
}

function buildSimplePdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects: string[] = [];
  const push = (s: string) => objects.push(s);
  push("<< /Type /Catalog /Pages 2 0 R >>");
  push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
  const stream = `BT /F1 14 Tf 72 720 Td (${escaped.split("\n").join(") Tj T* (")}) Tj ET`;
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
