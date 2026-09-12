import { useEffect, useRef, useState } from "react";
import { authHeader } from "@/lib/api";

// Types and helpers shared by the Results pages. Shapes mirror
// artifacts/api-server/src/lib/results.ts.

export type ScoreMethod = "weighted" | "average" | "terminal";
export const SCORE_METHODS: ScoreMethod[] = ["weighted", "average", "terminal"];
export const METHOD_LABEL: Record<ScoreMethod, string> = {
  weighted: "Weighted CA + terminal",
  average: "Average of all papers",
  terminal: "Terminal exam only",
};

export type GradeBand = { grade: string; min: number; points?: number; remark?: string };
export type GradingScheme = { id: number; name: string; bands: GradeBand[] };
export type TvScoreboardMode = "off" | "top5" | "full";

export type ResultsSettings = {
  official_method: ScoreMethod;
  ca_weight: number;
  exam_weight: number;
  tv_scoreboard: TvScoreboardMode;
  primary_scheme: GradingScheme | null;
};

export type Term = {
  id: number;
  name: string;
  academic_year: string;
  starts_on: string | null;
  ends_on: string | null;
  is_current: boolean;
};

export type ClassRow = { id: number; name: string; grade: string };

export type Exam = {
  id: number;
  term_id: number;
  class_id: number;
  subject: string;
  title: string;
  kind: "ca" | "terminal";
  total_marks: number;
  held_on: string | null;
  status: "open" | "closed";
  class_name?: string;
  term_name?: string;
  results_recorded?: number;
};

export type SheetRow = {
  student_id: number;
  name: string;
  student_code: string | null;
  marks: number | null;
  percent: number | null;
  source: string | null;
  recorded_at: string | null;
};

export type SubjectScores = { ca: number | null; terminal: number | null; average: number | null; weighted: number | null };

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

export type Division = { division: string; points: number; subjects_counted: number };

export type OverallResult = {
  student_id: number;
  student_code: string | null;
  name: string;
  subjects_sat: number;
  total: number;
  average: number;
  school_grade: string;
  division: Division | null;
  position: number;
};

export type ClassResults = {
  class: ClassRow;
  term: Term;
  level: "o_level" | "a_level";
  method: ScoreMethod;
  official_method: ScoreMethod;
  methods: ScoreMethod[];
  weights: { ca: number; exam: number };
  school_scheme: { name: string; bands: GradeBand[] };
  necta_scale: GradeBand[];
  exams: Exam[];
  students_in_class: number;
  subjects: Array<{ subject: string; sat: number; rows: SubjectResult[] }>;
  overall: OverallResult[];
};

export type ReportCardClass = {
  class: ClassRow;
  level: "o_level" | "a_level";
  method: ScoreMethod;
  official_method: ScoreMethod;
  weights: { ca: number; exam: number };
  school_scheme: { name: string; bands: GradeBand[] };
  necta_scale: GradeBand[];
  subjects: Array<Omit<SubjectResult, "student_id" | "student_code" | "name"> & { subject: string; out_of: number }>;
  total: number | null;
  average: number | null;
  school_grade: string | null;
  division: Division | null;
  position: number | null;
  out_of: number;
  students_in_class: number;
};

export type ReportCard = {
  student: { id: number; name: string; student_code: string | null };
  term: Term | null;
  classes: ReportCardClass[];
};

export type ResultEvent = {
  type: "result_recorded" | "result_removed";
  exam_id: number;
  class_id: number;
  term_id: number;
  subject: string;
  exam_title: string;
  student_id: number;
  student_code: string | null;
  student_name: string | null;
  marks: number | null;
  percent: number | null;
  total_marks: number;
  at: string;
};

export const LEVEL_LABEL = { o_level: "NECTA O-level (CSEE)", a_level: "NECTA A-level (ACSEE)" } as const;
/** Subjects NECTA counts towards a division. */
export const DIVISION_SUBJECTS = { o_level: 7, a_level: 3 } as const;

export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

export function gradeTone(grade: string | null | undefined): string {
  switch (grade) {
    case "A":
      return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "B":
      return "bg-green-100 text-green-800 border-green-200";
    case "C":
      return "bg-sky-100 text-sky-800 border-sky-200";
    case "D":
      return "bg-amber-100 text-amber-800 border-amber-200";
    case "E":
    case "S":
      return "bg-orange-100 text-orange-800 border-orange-200";
    case "F":
      return "bg-rose-100 text-rose-800 border-rose-200";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

export function fmtScore(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value}`;
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Role from the signed-in staff token; the server still enforces every permission. */
export function tokenRole(token: string | null): string | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1] ?? "";
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).role ?? null;
  } catch {
    return null;
  }
}

/**
 * Live results over server-sent events. Read with fetch() so the bearer
 * token stays in a header; reconnects after drops. `classId` null streams
 * every class.
 */
export function useResultsStream(classId: number | null, onEvent: (event: ResultEvent) => void, enabled = true): boolean {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let retry: number | undefined;

    const connect = async () => {
      try {
        const query = classId ? `?class_id=${classId}` : "";
        const res = await fetch(`${import.meta.env.BASE_URL}api/v1/results/stream${query}`, {
          headers: authHeader(),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        setLive(true);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let split: number;
          while ((split = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const lines = block.split("\n");
            const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
            const data = lines
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            if (event !== "result" || !data) continue;
            try {
              handler.current(JSON.parse(data) as ResultEvent);
            } catch {
              // ignore a malformed event
            }
          }
        }
      } catch {
        // dropped or refused — reconnect below
      }
      setLive(false);
      if (!controller.signal.aborted) retry = window.setTimeout(connect, 3000);
    };

    connect();
    return () => {
      controller.abort();
      window.clearTimeout(retry);
      setLive(false);
    };
  }, [classId, enabled]);

  return live;
}
