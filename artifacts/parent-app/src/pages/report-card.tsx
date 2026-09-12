import { useEffect, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, GraduationCap, Trophy } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";

type Term = { id: number; name: string; academic_year: string; is_current: boolean };

type SubjectRow = {
  subject: string;
  scores: { ca: number | null; terminal: number | null; average: number | null; weighted: number | null };
  score: number;
  school_grade: string;
  school_remark: string | null;
  necta_grade: string;
  necta_points: number;
  position: number;
  out_of: number;
};

type ClassCard = {
  class: { id: number; name: string; grade: string };
  level: "o_level" | "a_level";
  school_scheme: { name: string };
  subjects: SubjectRow[];
  total: number | null;
  average: number | null;
  school_grade: string | null;
  division: { division: string; points: number } | null;
  position: number | null;
  out_of: number;
};

type ReportCard = {
  student: { id: number; name: string; student_code: string | null };
  term: Term | null;
  classes: ClassCard[];
  terms: Term[];
};

const GRADE_STYLE: Record<string, string> = {
  A: "bg-emerald-100 text-emerald-700",
  B: "bg-green-100 text-green-700",
  C: "bg-sky-100 text-sky-700",
  D: "bg-amber-100 text-amber-700",
  E: "bg-orange-100 text-orange-700",
  S: "bg-orange-100 text-orange-700",
  F: "bg-rose-100 text-rose-700",
};

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

function Grade({ grade }: { grade: string | null }) {
  return (
    <span className={`inline-flex min-w-7 justify-center rounded-lg px-2 py-0.5 text-xs font-bold ${GRADE_STYLE[grade ?? ""] ?? "bg-gray-100 text-gray-600"}`}>
      {grade ?? "—"}
    </span>
  );
}

export default function ReportCardPage() {
  const [, setLocation] = useLocation();
  const { token } = useAuth();
  const { childId } = useParams<{ childId: string }>();
  const [termId, setTermId] = useState<number | null>(null);

  useEffect(() => {
    if (!token) setLocation("/login");
  }, [token, setLocation]);

  // Teachers' marks land within seconds, so the card refreshes while open.
  const { data, isLoading, error } = useQuery({
    queryKey: ["report-card", childId, termId],
    queryFn: () => apiGet<ReportCard>(`/v1/parent/child/${childId}/report-card${termId ? `?term_id=${termId}` : ""}`),
    enabled: !!token && !!childId,
    refetchInterval: 30_000,
  });

  if (!token) return null;

  return (
    <Layout>
      <div className="px-6 pt-12 pb-6 bg-primary text-white rounded-b-[40px] shadow-sm">
        <button onClick={() => setLocation("/dashboard")} className="flex items-center gap-1 text-sm text-primary-foreground/80 mb-3">
          <ChevronLeft className="w-4 h-4" />
          Back
        </button>
        <h1 className="text-2xl font-bold">{data?.student?.name ? `${data.student.name}'s report card` : "Report card"}</h1>
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-sm text-primary-foreground/80">Updates as teachers mark papers.</p>
          {data && data.terms.length > 0 && (
            <select
              value={termId ?? data.term?.id ?? ""}
              onChange={(e) => setTermId(Number(e.target.value))}
              className="rounded-xl bg-white/15 px-3 py-1.5 text-sm text-white outline-none"
            >
              {data.terms.map((t) => (
                <option key={t.id} value={t.id} className="text-gray-900">
                  {t.name} {t.academic_year}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="px-6 -mt-4 relative z-10 space-y-4 pb-8">
        {isLoading && (
          <Card className="p-6 rounded-3xl shadow-sm border-none">
            <div className="h-40 bg-gray-100 animate-pulse rounded-xl" />
          </Card>
        )}

        {error && (
          <Card className="p-6 rounded-3xl border-none">
            <p className="text-sm text-gray-600">No results have been published for this term yet.</p>
          </Card>
        )}

        {data?.classes.map((entry) => (
          <div key={entry.class.id} className="space-y-3">
            <Card className="p-5 rounded-3xl border-none shadow-sm">
              <div className="flex items-center gap-2 mb-4">
                <Trophy className="w-4 h-4 text-primary" />
                <p className="text-sm font-semibold text-gray-900">
                  {entry.class.name} · {data.term ? `${data.term.name} ${data.term.academic_year}` : ""}
                </p>
              </div>
              {entry.average === null ? (
                <p className="text-sm text-gray-600">No marks recorded yet this term.</p>
              ) : (
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-2xl bg-gray-50 p-3">
                    <p className="text-xs text-gray-500">Average</p>
                    <p className="text-xl font-bold text-gray-900">{entry.average}</p>
                    <Grade grade={entry.school_grade} />
                  </div>
                  <div className="rounded-2xl bg-gray-50 p-3">
                    <p className="text-xs text-gray-500">Position</p>
                    <p className="text-xl font-bold text-gray-900">{entry.position ? ordinal(entry.position) : "—"}</p>
                    <p className="text-xs text-gray-500">of {entry.out_of}</p>
                  </div>
                  <div className="rounded-2xl bg-gray-50 p-3">
                    <p className="text-xs text-gray-500">NECTA division</p>
                    <p className="text-xl font-bold text-gray-900">{entry.division?.division ?? "—"}</p>
                    <p className="text-xs text-gray-500">
                      {entry.division ? `${entry.division.points} points` : `needs ${entry.level === "a_level" ? 3 : 7} subjects`}
                    </p>
                  </div>
                </div>
              )}
            </Card>

            {entry.subjects.map((s) => (
              <Card key={s.subject} className="p-4 rounded-3xl border-none shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 shrink-0 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
                      <GraduationCap className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{s.subject}</p>
                      <p className="text-xs text-gray-500">
                        {ordinal(s.position)} of {s.out_of}
                        {s.school_remark ? ` · ${s.school_remark}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-lg font-bold text-gray-900">{s.score}</p>
                    <div className="flex items-center justify-end gap-1">
                      <Grade grade={s.school_grade} />
                      <span className="text-[10px] text-gray-500">NECTA {s.necta_grade}</span>
                    </div>
                  </div>
                </div>
              </Card>
            ))}

            {entry.subjects.length > 0 && (
              <p className="px-1 text-xs text-gray-500">
                Grades follow the school's {entry.school_scheme.name}; NECTA grades show where your child would stand nationally.
              </p>
            )}
          </div>
        ))}

        {data && data.classes.length === 0 && (
          <Card className="p-6 rounded-3xl border-none">
            <p className="text-sm text-gray-600">Your child isn't enrolled in a class yet.</p>
          </Card>
        )}
      </div>
    </Layout>
  );
}
