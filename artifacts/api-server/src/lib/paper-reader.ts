import { brainGenerate, brainJson } from "./kobe-brain";
import { k9RuntimeUrl } from "./k9-runtime";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Paper reader — turns a phone photo of a printed sheet into rows.
//
// Tanzanian secondary schools already run on paper: the class list comes out
// of the office as a printed sheet, and the Form 3 subject options come back
// as a ruled sheet the students signed. Retyping either one into a computer
// is the single most tedious part of setting a school up, and it is exactly
// the kind of work a vision model does in seconds.
//
// So the teacher photographs the sheet and K9 does the typing:
//
//   photo ──► read()  ──────► raw text   (vision model, on-prem)
//         ──► parseRoster()        ─┐
//         ──► parseSubjectSheet()  ─┴─► rows the teacher checks and commits
//
// Two rules hold everywhere in here:
//
//   1. **Nothing is ever written straight through.** Every function returns a
//      proposal with a per-row confidence. A human presses Commit.
//   2. **There is always a path without a model.** When no vision model is
//      installed, `read()` returns null and the teacher types or pastes the
//      list instead; the line parsers below are plain regex and run on that
//      text identically. A school with no GPU still gets onboarded.
// ---------------------------------------------------------------------------

export type RosterRow = {
  name: string;
  student_code?: string;
  sex?: "M" | "F";
  stream?: string;
  /** 0-100. Below ~70 the UI highlights the row for the teacher to check. */
  confidence: number;
};

export type SubjectRow = {
  name: string;
  subjects: string[];
  confidence: number;
};

export type ReadResult = { text: string; model: string };

const OCR_INSTRUCTION =
  "Read every line of text in this photograph of a printed school document. " +
  "Reproduce it exactly, one line per line, keeping the column order. " +
  "Do not translate, summarise, correct spelling, or add any commentary. " +
  "If a line is unreadable, write it as <unclear>.";

/**
 * Read the text off a photographed sheet. Tries the on-prem vision brain
 * first, then the K9 runtime's own OCR endpoint, then gives up and returns
 * null so the caller can fall back to manual entry.
 */
export async function readPaper(image: Buffer): Promise<ReadResult | null> {
  const viaBrain = await brainGenerate(OCR_INSTRUCTION, {
    tag: "paper-reader:ocr",
    images: [image.toString("base64")],
    maxTokens: 2000,
    temperature: 0.1,
    timeoutMs: 180_000,
  });
  if (viaBrain && viaBrain.text.length > 8) return viaBrain;

  const viaRuntime = await readViaK9Runtime(image);
  if (viaRuntime) return viaRuntime;

  return null;
}

/** The K9 runtime exposes the registry's OCR model over multipart at /v1/ocr. */
async function readViaK9Runtime(image: Buffer): Promise<ReadResult | null> {
  try {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "page.jpg");
    const secret = process.env["K9_RUNTIME_SECRET"];
    const res = await fetch(`${k9RuntimeUrl()}/v1/ocr`, {
      method: "POST",
      body: form,
      headers: secret ? { "x-k9-runtime-secret": secret } : {},
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { text?: string; model?: string };
    const text = (body.text ?? "").trim();
    if (!text) return null;
    return { text, model: body.model ?? "k9-runtime-ocr" };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "paper-reader: K9 runtime OCR unavailable",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Structuring
// ---------------------------------------------------------------------------

const ROSTER_SYSTEM =
  "You convert scanned Tanzanian school class lists into JSON. You never " +
  "invent students and never drop one. Output JSON only.";

/**
 * Turn read-back text into student rows. The model pass handles the messy
 * real cases — a two-column sheet, a header band, an "S/N" gutter, a name
 * written SURNAME first. `parseRosterLines` is the deterministic fallback and
 * also the floor: if the model returns fewer rows than the regex found, we
 * keep the regex rows, because a silently dropped student is the one failure
 * mode a teacher will not catch.
 */
export async function parseRoster(text: string): Promise<{ rows: RosterRow[]; model: string | null }> {
  const baseline = parseRosterLines(text);
  const out = await brainJson<{ students?: RosterRow[] }>(
    `Convert this class list into JSON.\n\n` +
      `Return {"students":[{"name":"…","student_code":"…"|null,"sex":"M"|"F"|null,` +
      `"stream":"…"|null,"confidence":0-100}]}\n\n` +
      `Rules:\n` +
      `- One entry per student, in sheet order. Keep every student.\n` +
      `- "name" is the student's full name in Title Case, no numbering, no titles.\n` +
      `- student_code only if the sheet actually prints one (e.g. "S0231"). Never make one up.\n` +
      `- confidence is how clearly you could read that line: 100 crisp, 40 smudged.\n` +
      `- Ignore headers, page numbers, totals and signature lines.\n\n` +
      `SHEET:\n${text.slice(0, 8000)}`,
    { tag: "paper-reader:roster", system: ROSTER_SYSTEM, maxTokens: 3000, temperature: 0.1 },
  );

  const modelRows = sanitizeRoster(out?.value?.students);
  if (modelRows.length >= baseline.length && modelRows.length > 0) {
    return { rows: modelRows, model: out!.model };
  }
  if (modelRows.length > 0) {
    logger.warn(
      { model_rows: modelRows.length, regex_rows: baseline.length },
      "paper-reader: model dropped students, keeping the line parse",
    );
  }
  return { rows: baseline, model: null };
}

/**
 * Deterministic line parse: strip an "S/N" gutter, drop obvious furniture,
 * and take what is left as a name. Deliberately generous — a wrong row the
 * teacher deletes in the preview costs a tap; a missing row costs a student.
 */
export function parseRosterLines(text: string): RosterRow[] {
  const rows: RosterRow[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || line.length < 3) continue;
    if (/^<unclear>$/i.test(line)) continue;
    if (isFurniture(line)) continue;

    // Leading "12." / "12)" / "12 " serial number.
    let rest = line.replace(/^\d{1,3}\s*[.)\-:]?\s+/, "");
    // A trailing admission number, e.g. "ASHA JUMA   S0231".
    let code: string | undefined;
    const codeMatch = rest.match(/\s+([A-Z]{1,4}[-/]?\d{2,6})\s*$/);
    if (codeMatch) {
      code = codeMatch[1];
      rest = rest.slice(0, codeMatch.index).trim();
    }
    // A trailing lone M / F sex column.
    let sex: "M" | "F" | undefined;
    const sexMatch = rest.match(/\s+([MF])\s*$/);
    if (sexMatch) {
      sex = sexMatch[1] as "M" | "F";
      rest = rest.slice(0, sexMatch.index).trim();
    }

    const name = titleCase(rest.replace(/[.,;:]+$/, "").trim());
    if (!isPlausibleName(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      name,
      ...(code ? { student_code: code } : {}),
      ...(sex ? { sex } : {}),
      // A line the regex had to guess at is flagged lower for the teacher.
      confidence: /[<>?*]/.test(raw) ? 55 : 80,
    });
  }
  return rows;
}

const SUBJECT_SYSTEM =
  "You convert Tanzanian secondary-school subject-option sheets into JSON. " +
  "Output JSON only.";

/**
 * Read a subject-option sheet: the ruled page where each student signs
 * against the subjects they take. From Form 3 the school splits into science
 * and arts streams, so this is what stops K9 quizzing a student on a paper
 * they dropped two years ago.
 */
export async function parseSubjectSheet(
  text: string,
  knownSubjects: string[],
): Promise<{ rows: SubjectRow[]; model: string | null }> {
  const out = await brainJson<{ students?: SubjectRow[] }>(
    `Convert this subject-option sheet into JSON.\n\n` +
      `Return {"students":[{"name":"…","subjects":["…"],"confidence":0-100}]}\n\n` +
      `Rules:\n` +
      `- One entry per student named on the sheet.\n` +
      `- "subjects" lists only the subjects that student is marked as taking ` +
      `(a tick, an X, a signature or the subject written next to the name).\n` +
      `- Use these subject names exactly where they match: ${knownSubjects.join(", ") || "(none supplied)"}.\n` +
      `- Never guess a subject a student is not marked against. An empty list is a valid answer.\n\n` +
      `SHEET:\n${text.slice(0, 8000)}`,
    { tag: "paper-reader:subjects", system: SUBJECT_SYSTEM, maxTokens: 3000, temperature: 0.1 },
  );

  const rows = sanitizeSubjects(out?.value?.students, knownSubjects);
  if (rows.length > 0) return { rows, model: out!.model };
  return { rows: parseSubjectLines(text, knownSubjects), model: null };
}

/**
 * Fallback line parse for a subject sheet: a name, then any known subject
 * named on the same line. Works on the common "ASHA JUMA — Physics, Chemistry,
 * Biology" layout and on a ticked grid once the reader has flattened it.
 */
export function parseSubjectLines(text: string, knownSubjects: string[]): SubjectRow[] {
  const needles = knownSubjects.map((s) => ({ subject: s, needle: s.toLowerCase() }));
  const rows: SubjectRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || isFurniture(line)) continue;
    const hits = needles.filter((n) => line.toLowerCase().includes(n.needle)).map((n) => n.subject);
    if (hits.length === 0) continue;
    // The name is whatever precedes the first subject mention.
    const firstAt = Math.min(
      ...hits.map((s) => line.toLowerCase().indexOf(s.toLowerCase())).filter((i) => i >= 0),
    );
    const namePart = line
      .slice(0, firstAt)
      .replace(/^\d{1,3}\s*[.)\-:]?\s+/, "")
      .replace(/[-–—:,]+\s*$/, "")
      .trim();
    const name = titleCase(namePart);
    if (!isPlausibleName(name)) continue;
    rows.push({ name, subjects: [...new Set(hits)], confidence: 70 });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const FURNITURE =
  /^(s\/?n|no\.?|name|jina|namba|class|darasa|form|kidato|total|jumla|page|ukurasa|signature|sahihi|date|tarehe|teacher|mwalimu|school|shule|admission|list|orodha)\b/i;

function isFurniture(line: string): boolean {
  if (FURNITURE.test(line)) return true;
  // A rule, a row of dots, or a line with no letters at all.
  if (!/[a-z]/i.test(line)) return true;
  return false;
}

/** Two to five words, letters only (Tanzanian names carry no digits). */
function isPlausibleName(name: string): boolean {
  if (name.length < 4 || name.length > 60) return false;
  if (/\d/.test(name)) return false;
  const words = name.split(" ").filter(Boolean);
  return words.length >= 2 && words.length <= 5 && words.every((w) => /^[A-Za-z'’\-.]{2,}$/.test(w));
}

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function clampConfidence(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 60;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function sanitizeRoster(rows: unknown): RosterRow[] {
  if (!Array.isArray(rows)) return [];
  const out: RosterRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const name = titleCase(String(r?.["name"] ?? "").replace(/\s+/g, " ").trim());
    if (!isPlausibleName(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const code = String(r?.["student_code"] ?? "").trim();
    const sex = String(r?.["sex"] ?? "").trim().toUpperCase();
    const stream = String(r?.["stream"] ?? "").trim();
    out.push({
      name,
      ...(code && code !== "null" && /^[A-Za-z0-9\-/]{2,16}$/.test(code) ? { student_code: code } : {}),
      ...(sex === "M" || sex === "F" ? { sex: sex as "M" | "F" } : {}),
      ...(stream && stream !== "null" ? { stream } : {}),
      confidence: clampConfidence(r?.["confidence"]),
    });
  }
  return out;
}

function sanitizeSubjects(rows: unknown, known: string[]): SubjectRow[] {
  if (!Array.isArray(rows)) return [];
  // Only subjects the school actually teaches survive — a model that invents
  // "Further Mathematics" for a school that doesn't offer it must not create
  // a subject out of thin air.
  const allow = new Map(known.map((s) => [s.toLowerCase(), s]));
  const out: SubjectRow[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const name = titleCase(String(r?.["name"] ?? "").replace(/\s+/g, " ").trim());
    if (!isPlausibleName(name)) continue;
    const raw = Array.isArray(r?.["subjects"]) ? (r["subjects"] as unknown[]) : [];
    const subjects = [
      ...new Set(
        raw
          .map((s) => allow.get(String(s).trim().toLowerCase()))
          .filter((s): s is string => !!s),
      ),
    ];
    out.push({ name, subjects, confidence: clampConfidence(r?.["confidence"]) });
  }
  return out;
}

/**
 * Match a name off a sheet to a name already in the database. Exact match
 * first, then same-surname-and-first-name in either order (sheets print
 * SURNAME First as often as First SURNAME), then nothing — an unmatched row
 * is reported to the teacher, never guessed at.
 */
export function matchName<T extends { id: number; name: string }>(
  candidate: string,
  people: T[],
): T | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  const target = norm(candidate);
  if (!target) return null;
  const exact = people.find((p) => norm(p.name) === target);
  if (exact) return exact;
  const targetWords = [...target.split(" ")].sort().join(" ");
  const reordered = people.filter((p) => [...norm(p.name).split(" ")].sort().join(" ") === targetWords);
  return reordered.length === 1 ? reordered[0]! : null;
}
