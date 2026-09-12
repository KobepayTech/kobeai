import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Glasses, Medal, Radio } from "lucide-react";
import { apiErrorText, apiGet } from "@/lib/api";
import {
  DIVISION_SUBJECTS,
  LEVEL_LABEL,
  METHOD_LABEL,
  SCORE_METHODS,
  fmtScore,
  gradeTone,
  type ClassResults,
  type ResultEvent,
  type ScoreMethod,
} from "@/lib/results";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function GradeBadge({ grade }: { grade: string | null | undefined }) {
  return (
    <span className={`inline-flex min-w-8 justify-center rounded-md border px-2 py-0.5 text-xs font-bold ${gradeTone(grade)}`}>
      {grade ?? "—"}
    </span>
  );
}

function Position({ value }: { value: number }) {
  if (value <= 3) {
    const tone = value === 1 ? "text-amber-500" : value === 2 ? "text-slate-400" : "text-orange-600";
    return (
      <span className="inline-flex items-center gap-1 font-semibold">
        <Medal className={`h-4 w-4 ${tone}`} />
        {value}
      </span>
    );
  }
  return <span className="font-semibold text-muted-foreground">{value}</span>;
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

export function ScoreboardPanel({ classId, termId, feed }: { classId: number; termId: number | null; feed: ResultEvent[] }) {
  const [method, setMethod] = useState<ScoreMethod | "official">("official");
  const params = new URLSearchParams({ class_id: String(classId) });
  if (termId) params.set("term_id", String(termId));
  if (method !== "official") params.set("method", method);

  const board = useQuery({
    queryKey: ["results-board", classId, termId, method],
    queryFn: () => apiGet<ClassResults>(`/v1/results/scoreboard?${params}`),
  });

  if (board.isLoading) return <Skeleton className="h-96 w-full" />;
  if (board.error || !board.data) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground">{apiErrorText(board.error)}</CardContent>
      </Card>
    );
  }

  const data = board.data;
  const divisionNeeds = DIVISION_SUBJECTS[data.level];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">How scores are calculated</CardTitle>
            <CardDescription>
              Official: <strong>{METHOD_LABEL[data.official_method]}</strong>
              {data.official_method === "weighted" && ` (CA ${data.weights.ca}% · terminal ${data.weights.exam}%)`}. Grades use the{" "}
              <strong>{data.school_scheme.name}</strong>, with {LEVEL_LABEL[data.level]} grades alongside.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">View scores as</span>
            <Select value={method} onValueChange={(value) => setMethod(value as ScoreMethod | "official")}>
              <SelectTrigger className="w-72" data-testid="select-score-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="official">Official — {METHOD_LABEL[data.official_method]}</SelectItem>
                {SCORE_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">
              {data.exams.length} exam{data.exams.length === 1 ? "" : "s"} · {data.students_in_class} students
            </span>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Radio className="h-4 w-4 text-green-600" /> Live marks
            </CardTitle>
            <CardDescription>Marks from the glasses and the dashboard appear here as they are recorded.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {feed.length === 0 ? (
              <p className="text-sm text-muted-foreground">Waiting for the next mark…</p>
            ) : (
              feed.map((event, i) => (
                <div key={`${event.at}-${i}`} className="flex items-start justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{event.student_name ?? event.student_code}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {event.subject} · {event.exam_title}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-semibold">
                      {event.type === "result_removed" ? "removed" : `${event.marks}/${event.total_marks}`}
                    </div>
                    <div className="text-xs text-muted-foreground">{timeAgo(event.at)}</div>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Overall ranking</CardTitle>
          <CardDescription>
            Average of each student's subject scores. NECTA division uses the best {divisionNeeds} subjects and appears once a student has{" "}
            {divisionNeeds}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.overall.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {data.exams.length === 0
                ? "No exams for this class and term yet — create one under Exams & marks."
                : "No marks recorded yet. They appear here the moment a teacher marks a paper."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Pos</TableHead>
                  <TableHead>Student</TableHead>
                  <TableHead className="text-right">Subjects</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Average</TableHead>
                  <TableHead className="text-center">School grade</TableHead>
                  <TableHead className="text-center">NECTA division</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.overall.map((row) => (
                  <TableRow key={row.student_id} data-testid={`row-overall-${row.student_id}`}>
                    <TableCell>
                      <Position value={row.position} />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{row.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{row.student_code}</div>
                    </TableCell>
                    <TableCell className="text-right">{row.subjects_sat}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.total}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{row.average}</TableCell>
                    <TableCell className="text-center">
                      <GradeBadge grade={row.school_grade} />
                    </TableCell>
                    <TableCell className="text-center text-sm">
                      {row.division ? (
                        <span>
                          Division <strong>{row.division.division}</strong> · {row.division.points} pts
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          {row.subjects_sat}/{divisionNeeds} subjects
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link href={`/results/report-card/${row.student_id}${termId ? `?term_id=${termId}` : ""}`}>
                        <span className="cursor-pointer text-sm font-medium text-primary hover:underline">Report card</span>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        {data.subjects.map((subject) => (
          <Card key={subject.subject} data-testid={`card-subject-${subject.subject}`}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{subject.subject}</CardTitle>
                <Badge variant="secondary">
                  {subject.sat} of {data.students_in_class} marked
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              {subject.rows.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">No marks yet for this method.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-14">Pos</TableHead>
                      <TableHead>Student</TableHead>
                      <TableHead className="text-right">CA</TableHead>
                      <TableHead className="text-right">Terminal</TableHead>
                      <TableHead className="text-right">Score</TableHead>
                      <TableHead className="text-center">School</TableHead>
                      <TableHead className="text-center">NECTA</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {subject.rows.map((row) => (
                      <TableRow key={row.student_id}>
                        <TableCell>
                          <Position value={row.position} />
                        </TableCell>
                        <TableCell className="font-medium">{row.name}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{fmtScore(row.scores.ca)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{fmtScore(row.scores.terminal)}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{row.score}</TableCell>
                        <TableCell className="text-center">
                          <GradeBadge grade={row.school_grade} />
                        </TableCell>
                        <TableCell className="text-center text-xs">
                          <GradeBadge grade={row.necta_grade} /> <span className="text-muted-foreground">{row.necta_points} pt</span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {data.subjects.length > 0 && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Glasses className="h-3.5 w-3.5" /> Teachers marking with KobeAI glasses pick an open exam; each mark updates this board instantly.
        </p>
      )}
    </div>
  );
}
