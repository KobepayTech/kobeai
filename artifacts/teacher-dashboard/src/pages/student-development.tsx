import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Cake,
  ClipboardList,
  Eye,
  FlaskConical,
  Lightbulb,
  Printer,
  Search,
  Timer,
} from "lucide-react";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

type Note = {
  id: number;
  topic: string;
  subject: string | null;
  student_answer: string | null;
  ideal_answer: string | null;
  body_markdown: string;
  status: string;
  created_at: string;
};

type Retest = {
  id: number;
  strategy: string;
  status: string;
  subject: string | null;
  difficulty_level: number;
  score_percent: number | null;
  generated_at: string;
  administered_at: string | null;
  items:
    | Array<{
        id: number;
        topic: string;
        question_text: string;
        expected_answer: string | null;
        difficulty_level: number;
      }>
    | null;
};

type Observation = {
  id: number;
  camera_id: string | null;
  category: string;
  confidence: number;
  description: string | null;
  subject: string | null;
  captured_at: string;
};

type BehaviorSummary = { category: string; n: number };

type LessonPlan = {
  id: number;
  week_start: string;
  plan_markdown: string;
  snapshot: unknown;
  generator: string;
  generated_at: string;
};

const CATEGORY_COLOR: Record<string, string> = {
  attentive: "bg-emerald-100 text-emerald-700",
  reading: "bg-emerald-100 text-emerald-700",
  writing: "bg-emerald-100 text-emerald-700",
  collaborating: "bg-emerald-100 text-emerald-700",
  drawing: "bg-amber-100 text-amber-700",
  idle: "bg-gray-200 text-gray-700",
  restless: "bg-amber-100 text-amber-700",
  distracted: "bg-rose-100 text-rose-700",
  sleeping: "bg-rose-100 text-rose-700",
};

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function useStudentCode() {
  const params = new URLSearchParams(window.location.search);
  return params.get("student") ?? "";
}

function setStudentCode(code: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("student", code);
  window.history.replaceState({}, "", url.toString());
}

export default function StudentDevelopment() {
  const initial = useStudentCode();
  const [studentCode, setStudentCodeState] = useState<string>(initial);
  const [input, setInput] = useState<string>(initial);
  const [tab, setTab] = useState<"notes" | "retests" | "behavior" | "plan">("notes");
  const { toast } = useToast();
  const qc = useQueryClient();

  const applyStudent = (v: string) => {
    const trimmed = v.trim();
    if (!trimmed) return;
    setStudentCodeState(trimmed);
    setStudentCode(trimmed);
  };

  const notes = useQuery({
    queryKey: ["notes", studentCode],
    enabled: !!studentCode,
    queryFn: () => apiGet<{ notes: Note[] }>(`/v1/staff/curated-notes/${studentCode}`),
  });
  const retests = useQuery({
    queryKey: ["retests", studentCode],
    enabled: !!studentCode,
    queryFn: () => apiGet<{ retests: Retest[] }>(`/v1/staff/retests/${studentCode}`),
  });
  const behavior = useQuery({
    queryKey: ["behavior", studentCode],
    enabled: !!studentCode,
    queryFn: () =>
      apiGet<{ observations: Observation[]; summary: BehaviorSummary[] }>(
        `/v1/staff/behavior/${studentCode}?since_hours=168`,
      ),
  });
  const plan = useQuery({
    queryKey: ["plan", studentCode],
    enabled: !!studentCode,
    queryFn: () =>
      apiGet<{ plan: LessonPlan }>(`/v1/staff/lesson-plans/${studentCode}/latest`).catch(() => null),
  });

  const recordRetest = useMutation({
    mutationFn: async ({ id, score }: { id: number; score: number }) =>
      apiPost(`/v1/staff/retests/${id}/record`, { score_percent: score }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["retests", studentCode] }),
    onError: (err) =>
      toast({
        title: "Couldn't record retest",
        description: err instanceof ApiError ? err.message : "unknown error",
        variant: "destructive",
      }),
  });

  const regeneratePlan = useMutation({
    mutationFn: async () =>
      apiPost(`/v1/staff/lesson-plans/generate`, { student_code: studentCode }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plan", studentCode] }),
  });

  const printPlan = () => {
    const md = plan.data?.plan?.plan_markdown ?? "";
    if (!md) return;
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>Lesson plan · ${studentCode}</title>` +
        `<style>body{font-family:Georgia,serif;max-width:640px;margin:2em auto;padding:0 1em;line-height:1.55}` +
        `h1{border-bottom:2px solid #00A86B;padding-bottom:.3em}h2{color:#00A86B;margin-top:2em}` +
        `code{background:#f2f2f2;padding:1px 4px;border-radius:3px}</style></head><body>`,
    );
    // Extremely small md-to-html: headings + emphasis + line breaks. The plan
    // markdown we produce doesn't use anything richer.
    let html = md
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/^# (.+)$/gm, "<h1>$1</h1>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^- (.+)$/gm, "<li>$1</li>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/_([^_]+)_/g, "<em>$1</em>");
    // Group consecutive <li>s under a <ul>.
    html = html.replace(/(<li>[\s\S]*?<\/li>(\n)?)+/g, (m) => `<ul>${m}</ul>`);
    html = html.replace(/\n\n/g, "</p><p>");
    win.document.write(`<p>${html}</p>`);
    win.document.write(`</body></html>`);
    win.document.close();
    win.print();
  };

  const behaviorSummary = useMemo(() => behavior.data?.summary ?? [], [behavior.data]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Student development</h1>
        <p className="text-muted-foreground mt-1">
          Curated notes, adaptive retests, prep-time behavior, and a printable lesson plan — everything
          the AI has learned about one student from marking + cameras.
        </p>
      </div>

      <Card>
        <CardContent className="p-4 flex items-center gap-3">
          <Search className="w-5 h-5 text-muted-foreground" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyStudent(input)}
            placeholder="Student code (e.g. K9-001)"
            className="flex-1 border rounded-md px-3 py-2 text-sm"
          />
          <Button onClick={() => applyStudent(input)}>Open</Button>
        </CardContent>
      </Card>

      {!studentCode && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Enter a student code above to see everything the AI has for them.
          </CardContent>
        </Card>
      )}

      {studentCode && (
        <>
          <div className="flex flex-wrap gap-2">
            {(["notes", "retests", "behavior", "plan"] as const).map((t) => (
              <Button key={t} variant={tab === t ? "default" : "outline"} size="sm" onClick={() => setTab(t)}>
                {t === "notes" ? "Curated notes" : t === "retests" ? "Retests" : t === "behavior" ? "Behavior" : "Lesson plan"}
              </Button>
            ))}
          </div>

          {tab === "notes" && (
            <div className="space-y-3">
              {notes.isLoading && <p className="text-sm text-muted-foreground">Loading notes…</p>}
              {notes.data && notes.data.notes.length === 0 && (
                <Card>
                  <CardContent className="py-8 text-center text-muted-foreground">
                    No curated notes yet. Mark a paper via the teacher lens and they'll auto-generate.
                  </CardContent>
                </Card>
              )}
              {notes.data?.notes.map((n) => (
                <Card key={n.id}>
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="flex items-center gap-2 text-lg">
                          <BookOpen className="w-4 h-4" /> {n.topic}
                        </CardTitle>
                        <CardDescription>
                          {n.subject ?? "General"} · {fmt(n.created_at)}
                        </CardDescription>
                      </div>
                      <Badge variant="outline">{n.status}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {n.student_answer && (
                      <p className="text-xs text-muted-foreground mb-1">
                        <strong>Student wrote:</strong> {n.student_answer}
                      </p>
                    )}
                    {n.ideal_answer && (
                      <p className="text-xs text-muted-foreground mb-3">
                        <strong>A stronger answer:</strong> {n.ideal_answer}
                      </p>
                    )}
                    <pre className="whitespace-pre-wrap text-sm font-sans leading-relaxed">
                      {n.body_markdown}
                    </pre>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {tab === "retests" && (
            <div className="space-y-3">
              {retests.isLoading && <p className="text-sm text-muted-foreground">Loading retests…</p>}
              {retests.data && retests.data.retests.length === 0 && (
                <Card>
                  <CardContent className="py-8 text-center text-muted-foreground">
                    No retests for this student yet.
                  </CardContent>
                </Card>
              )}
              {retests.data?.retests.map((r) => {
                const scored = r.status === "passed" || r.status === "failed";
                const promptScore = () => {
                  const raw = window.prompt("Score %?", "80");
                  const n = Number(raw);
                  if (!Number.isFinite(n) || n < 0 || n > 100) return;
                  recordRetest.mutate({ id: r.id, score: Math.round(n) });
                };
                return (
                  <Card key={r.id}>
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div>
                          <CardTitle className="flex items-center gap-2 text-lg">
                            <FlaskConical className="w-4 h-4" /> Retest #{r.id}
                          </CardTitle>
                          <CardDescription>
                            {r.subject ?? "General"} · difficulty {r.difficulty_level} · strategy {r.strategy}
                          </CardDescription>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant={
                              r.status === "passed"
                                ? "default"
                                : r.status === "failed"
                                  ? "destructive"
                                  : "outline"
                            }
                          >
                            {r.status}
                            {r.score_percent != null ? ` · ${r.score_percent}%` : ""}
                          </Badge>
                          {!scored && (
                            <Button size="sm" onClick={promptScore} disabled={recordRetest.isPending}>
                              Record score
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <ol className="list-decimal ml-5 space-y-2 text-sm">
                        {(r.items ?? []).map((it) => (
                          <li key={it.id}>
                            <div className="font-medium">{it.question_text}</div>
                            <div className="text-xs text-muted-foreground">
                              Topic: {it.topic}
                              {it.expected_answer ? ` · expects: ${it.expected_answer}` : ""}
                            </div>
                          </li>
                        ))}
                      </ol>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          {tab === "behavior" && (
            <div className="space-y-4">
              {behaviorSummary.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Eye className="w-4 h-4" /> Habit summary (7 days)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {behaviorSummary.map((s) => (
                        <span
                          key={s.category}
                          className={`px-3 py-1 rounded-full text-sm font-medium ${
                            CATEGORY_COLOR[s.category] ?? "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {s.category} · {s.n}
                        </span>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
              {behavior.data && behavior.data.observations.length === 0 && (
                <Card>
                  <CardContent className="py-8 text-center text-muted-foreground">
                    No behavior observations yet. The Youtu-VL worker fills these once running.
                  </CardContent>
                </Card>
              )}
              {behavior.data && behavior.data.observations.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Timer className="w-4 h-4" /> Recent observations
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="divide-y divide-border">
                      {behavior.data.observations.map((o) => (
                        <li key={o.id} className="py-2 flex items-center gap-3">
                          <span
                            className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                              CATEGORY_COLOR[o.category] ?? "bg-gray-100 text-gray-600"
                            }`}
                          >
                            {o.category}
                          </span>
                          <div className="flex-1 text-sm">
                            {o.description ?? "no description"}
                            {o.subject && <span className="text-muted-foreground"> · {o.subject}</span>}
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {o.confidence}% · {fmt(o.captured_at)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {tab === "plan" && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => regeneratePlan.mutate()}
                  disabled={regeneratePlan.isPending}
                >
                  <Lightbulb className="w-4 h-4 mr-2" />
                  {plan.data?.plan ? "Regenerate this week" : "Generate lesson plan"}
                </Button>
                {plan.data?.plan && (
                  <Button onClick={printPlan}>
                    <Printer className="w-4 h-4 mr-2" />
                    Print
                  </Button>
                )}
              </div>
              {plan.data?.plan ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <ClipboardList className="w-4 h-4" /> Week of {plan.data.plan.week_start}
                    </CardTitle>
                    <CardDescription>
                      Generated {fmt(plan.data.plan.generated_at)} by {plan.data.plan.generator}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans">
                      {plan.data.plan.plan_markdown}
                    </pre>
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="py-8 text-center text-muted-foreground">
                    No lesson plan yet. Click "Generate lesson plan" — the AI aggregates the learning
                    profile, wrong-answer history, and prep-time behavior into a printable page.
                  </CardContent>
                </Card>
              )}
              {plan.data?.plan?.week_start && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Cake className="w-3.5 h-3.5" /> Weekly cadence is automated — this page just shows the
                  latest plan on disk.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
