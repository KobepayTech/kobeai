import { existsSync } from "node:fs";
import PDFDocument from "pdfkit";
export type Proof = {
  id: number;
  paper_id: number;
  question_number: number | null;
  question_text: string | null;
  question_topic: string | null;
  student_answer: string | null;
  expected_answer: string | null;
  is_correct: boolean;
  marks_awarded: number | null;
  marks_possible: number | null;
  paper_image_key: string | null;
  metadata: Record<string, unknown>;
  paper_metadata: Record<string, unknown>;
};
export type Lesson = {
  evidence_id: number;
  explanation: string;
  example: string;
  question: string;
};
export type PackContent = {
  name: string;
  code: string;
  grade: string;
  subject: string;
  title: string;
  kind: "quick" | "extended";
  proof: Proof[];
  lessons: Lesson[];
  generator: string;
};
export function classColour(grade: string): string {
  const form = grade
    .toLowerCase()
    .match(/form\s*(one|two|three|four|[1-4])/i)?.[1];
  return (
    (
      {
        one: "#15803d",
        "1": "#15803d",
        two: "#2563eb",
        "2": "#2563eb",
        three: "#dc2626",
        "3": "#dc2626",
        four: "#eab308",
        "4": "#eab308",
      } as Record<string, string>
    )[form ?? ""] ?? "#475569"
  );
}
export function proofProblems(rows: Proof[]): string[] {
  const problems = new Set<string>();
  const questions = new Set<number>();
  if (!rows.length) problems.add("No marked questions captured");
  for (const r of rows) {
    if (r.question_number == null || questions.has(r.question_number))
      problems.add("Missing or duplicate question numbers");
    if (r.question_number != null) questions.add(r.question_number);
    if (!r.question_text || !r.student_answer)
      problems.add("Question or student answer needs review");
    if (!r.metadata.source_image_key && !r.paper_image_key)
      problems.add("Source photograph is missing");
    if (r.paper_metadata.paper_complete !== true)
      problems.add("Paper is not confirmed complete");
    if (
      !Number.isFinite(
        Number(r.paper_metadata.profile_attachment_confidence),
      ) ||
      Number(r.paper_metadata.profile_attachment_confidence ?? 0) < 0.9
    )
      problems.add("Student identity needs confirmation");
    if (
      !Number.isFinite(Number(r.metadata.marking_confidence)) ||
      Number(r.metadata.marking_confidence ?? 0) < 0.9
    )
      problems.add("Teacher marking needs confirmation");
    if (
      r.marks_awarded == null ||
      r.marks_possible == null ||
      r.marks_awarded < 0 ||
      r.marks_possible <= 0 ||
      r.marks_awarded > r.marks_possible
    )
      problems.add("Written marks need confirmation");
    if (
      !r.expected_answer ||
      !["answer_key", "teacher_verified"].includes(
        String(r.metadata.expected_answer_source),
      )
    )
      problems.add("Correct answer needs teacher verification");
  }
  return [...problems];
}
export function parseLessons(
  raw: string,
  proof: Proof[],
  limit: number,
): Lesson[] {
  const parsed = JSON.parse(
    raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""),
  );
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > limit)
    throw new Error("Invalid lesson count");
  const ids = new Set<number>();
  return parsed.map((l: Lesson) => {
    if (!proof.some((p) => p.id === l.evidence_id) || ids.has(l.evidence_id))
      throw new Error("Invalid evidence reference");
    ids.add(l.evidence_id);
    for (const key of ["explanation", "example", "question"] as const)
      if (typeof l[key] !== "string" || !l[key].trim() || l[key].length > 500)
        throw new Error("Lesson does not fit print layout");
    return {
      evidence_id: l.evidence_id,
      explanation: l.explanation,
      example: l.example,
      question: l.question,
    };
  });
}
/** Reject overflow instead of clipping text, shrinking it or silently billing extra pages. */
export async function renderPack(
  content: PackContent,
  packId: number,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 40, autoFirstPage: false });
  const fontPath = [
    process.env.K9_PRINT_FONT_PATH,
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
  ].find((p) => p && existsSync(p));
  const boldPath = [
    process.env.K9_PRINT_BOLD_FONT_PATH,
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
  ].find((p) => p && existsSync(p));
  if (fontPath) doc.registerFont("PackRegular", fontPath);
  if (boldPath || fontPath) doc.registerFont("PackBold", boldPath || fontPath!);
  const regular = fontPath ? "PackRegular" : "Helvetica";
  const boldFont = boldPath || fontPath ? "PackBold" : "Helvetica-Bold";
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (b) => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  function text(value: string, bold = false, size = 11) {
    if (!fontPath && /[^\x20-\x7e\n]/.test(value))
      throw new Error(
        "Install a Unicode print font (K9_PRINT_FONT_PATH) before printing this content",
      );
    doc.font(bold ? boldFont : regular).fontSize(size);
    if (doc.y + doc.heightOfString(value, { width: 515, lineGap: 3 }) > 780)
      throw new Error("Pack exceeds readable page budget; shorten content");
    doc.text(value, { width: 515, lineGap: 3 });
    doc.moveDown(0.5);
  }
  function page(label: string) {
    doc.addPage();
    doc.rect(0, 0, 595.28, 14).fill(classColour(content.grade));
    doc.fillColor("#17251d");
    doc.y = 36;
    doc.x = 40;
    text(`${content.grade} | ${label}`, true, 16);
    text(`${content.name} (${content.code})`, true);
    text(`${content.subject} | ${content.title}`);
    text(
      `K9 Pack ${packId} | ${content.kind === "quick" ? "1 A4 sheet / 2 sides" : "3 A4 sheets / 6 sides"}`,
    );
  }
  try {
    const groups =
      content.kind === "quick"
        ? [content.lessons]
        : [
            content.lessons.slice(0, 2),
            content.lessons.slice(2, 4),
            content.lessons.slice(4, 6),
          ];
    for (const group of groups) {
      page("Understand");
      for (const l of group) {
        const p = content.proof.find((p) => p.id === l.evidence_id)!;
        text(
          `Question ${p.question_number ?? "?"}: ${p.question_topic ?? "Review"}`,
          true,
        );
        text(
          `Teacher's mark: ${p.is_correct ? "Correct" : "Incorrect"} | ${p.marks_awarded ?? "?"}/${p.marks_possible ?? "?"}`,
        );
        text(l.explanation);
        text(`Example: ${l.example}`);
      }
      page("Practise");
      for (const [i, l] of group.entries()) {
        text(`${i + 1}. ${l.question}`, true);
        text(
          "Answer: __________________________________________________\n\n_________________________________________________________",
        );
      }
      text(
        "Check: Can I explain my steps? Have I checked my answer?\nAsk your teacher about anything you still find difficult.",
      );
    }
    doc.end();
  } catch (err) {
    doc.end();
    await result;
    throw err;
  }
  return result;
}
