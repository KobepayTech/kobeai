import { useState } from "react";
import { Link, useParams, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Printer } from "lucide-react";
import { apiErrorText, apiGet } from "@/lib/api";
import {
  DIVISION_SUBJECTS,
  LEVEL_LABEL,
  METHOD_LABEL,
  fmtScore,
  ordinal,
  useResultsStream,
  type ReportCard,
  type Term,
} from "@/lib/results";
import { GradeBadge } from "@/components/results/scoreboard-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function ReportCardPage() {
  const { studentId } = useParams<{ studentId: string }>();
  const search = new URLSearchParams(useSearch());
  const qc = useQueryClient();
  const [termId, setTermId] = useState<number | null>(() => Number(search.get("term_id")) || null);

  const terms = useQuery({ queryKey: ["results", "terms"], queryFn: () => apiGet<{ terms: Term[] }>("/v1/results/terms") });
  const card = useQuery({
    queryKey: ["results-card", studentId, termId],
    queryFn: () => apiGet<ReportCard>(`/v1/results/report-card/${studentId}${termId ? `?term_id=${termId}` : ""}`),
  });

  // Marks for this student refresh the card while it is open.
  useResultsStream(null, (event) => {
    if (event.student_id === Number(studentId)) qc.invalidateQueries({ queryKey: ["results-card", studentId] });
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/results">
          <Button variant="ghost">
            <ArrowLeft className="mr-2 h-4 w-4" /> Results
          </Button>
        </Link>
        <div className="flex items-center gap-3">
          <Select value={termId ? String(termId) : card.data?.term ? String(card.data.term.id) : ""} onValueChange={(v) => setTermId(Number(v))}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Term" />
            </SelectTrigger>
            <SelectContent>
              {(terms.data?.terms ?? []).map((t) => (
                <SelectItem key={t.id} value={String(t.id)}>
                  {t.name} {t.academic_year}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => window.print()} disabled={!card.data} data-testid="button-print-report">
            <Printer className="mr-2 h-4 w-4" /> Print
          </Button>
        </div>
      </div>

      {card.isLoading ? (
        <Skeleton className="h-[32rem] w-full" />
      ) : card.error || !card.data ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">{apiErrorText(card.error)}</CardContent>
        </Card>
      ) : (
        <ReportCardSheet card={card.data} />
      )}
    </div>
  );
}

function ReportCardSheet({ card }: { card: ReportCard }) {
  return (
    <Card className="print:border-0 print:shadow-none" data-testid="report-card">
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Student report card</div>
            <CardTitle className="mt-1 text-2xl">{card.student.name}</CardTitle>
            <div className="font-mono text-sm text-muted-foreground">{card.student.student_code}</div>
          </div>
          <div className="text-right text-sm">
            <div className="font-semibold">{card.term ? `${card.term.name} · ${card.term.academic_year}` : "—"}</div>
            <div className="text-muted-foreground">Issued {new Date().toLocaleDateString()}</div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-8 pt-6">
        {card.classes.length === 0 && <p className="text-center text-muted-foreground">This student is not enrolled in any class.</p>}
        {card.classes.map((entry) => {
          const needs = DIVISION_SUBJECTS[entry.level];
          return (
            <section key={entry.class.id} className="space-y-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">{entry.class.name}</h2>
                <span className="text-xs text-muted-foreground">
                  Scores: {METHOD_LABEL[entry.method]}
                  {entry.method === "weighted" && ` (CA ${entry.weights.ca}% · terminal ${entry.weights.exam}%)`}
                </span>
              </div>

              {entry.subjects.length === 0 ? (
                <p className="text-sm text-muted-foreground">No marks recorded for this term yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Subject</TableHead>
                      <TableHead className="text-right">CA</TableHead>
                      <TableHead className="text-right">Terminal</TableHead>
                      <TableHead className="text-right">Score</TableHead>
                      <TableHead className="text-center">Grade</TableHead>
                      <TableHead>Remark</TableHead>
                      <TableHead className="text-center">NECTA</TableHead>
                      <TableHead className="text-right">Position</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entry.subjects.map((s) => (
                      <TableRow key={s.subject}>
                        <TableCell className="font-medium">{s.subject}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtScore(s.scores.ca)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtScore(s.scores.terminal)}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{s.score}</TableCell>
                        <TableCell className="text-center">
                          <GradeBadge grade={s.school_grade} />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{s.school_remark ?? ""}</TableCell>
                        <TableCell className="text-center text-xs">
                          {s.necta_grade} · {s.necta_points} pt
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {ordinal(s.position)} of {s.out_of}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <Summary label="Total" value={fmtScore(entry.total)} />
                <Summary label="Average" value={fmtScore(entry.average)} />
                <Summary label="Grade" value={<GradeBadge grade={entry.school_grade} />} />
                <Summary label="Class position" value={entry.position ? `${ordinal(entry.position)} of ${entry.out_of}` : "—"} />
                <Summary
                  label="NECTA division"
                  value={entry.division ? `${entry.division.division} (${entry.division.points} pts)` : `Needs ${needs} subjects`}
                />
              </div>

              <div className="grid gap-3 text-xs text-muted-foreground md:grid-cols-2">
                <div>
                  <span className="font-medium text-foreground">{entry.school_scheme.name}: </span>
                  {entry.school_scheme.bands.map((b) => `${b.grade} ${b.min}+`).join(" · ")}
                </div>
                <div>
                  <span className="font-medium text-foreground">{LEVEL_LABEL[entry.level]}: </span>
                  {entry.necta_scale.map((b) => `${b.grade} ${b.min}+`).join(" · ")}
                </div>
              </div>
            </section>
          );
        })}

        <div className="grid grid-cols-2 gap-10 pt-10 text-sm">
          <div className="border-t pt-2 text-muted-foreground">Class teacher</div>
          <div className="border-t pt-2 text-muted-foreground">Head of school</div>
        </div>
      </CardContent>
    </Card>
  );
}

function Summary({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}
