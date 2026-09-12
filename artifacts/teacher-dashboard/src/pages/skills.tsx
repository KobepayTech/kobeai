import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Brain, TrendingDown, TrendingUp, Target, ScanLine, School } from "lucide-react";

// Skill profiles — what the teacher's own marking says about each student.
//
// The distinction this page exists to make: a score is not a diagnosis. Two
// students on 62% can need opposite interventions, and only the per-skill
// breakdown shows which.

type SkillRow = {
  skill_id: number;
  code: string;
  name: string;
  subject: string;
  strand: string | null;
  mastery: number;
  confidence: number;
  trend: number;
  attempts: number;
  dominant_error: string | null;
  priority: number;
};

type Profile = {
  student: { id: number; name: string; student_code: string | null; grade: string | null };
  subjects: Array<{ subject: string; average: number; skills: SkillRow[] }>;
  priority: SkillRow[];
};

type Gap = {
  skill_id: number;
  code: string;
  name: string;
  subject: string;
  students: number;
  struggling: number;
  share: number;
  average: number;
};

type Agreement = {
  total: number;
  agreed: number;
  agreement_rate: number;
  by_subject: Array<{ subject: string | null; total: number; rate: number }>;
};

type Meta = {
  error_types: Array<{ code: string; label: string }>;
  thresholds: { weak: number; strong: number };
};

const FORMS = ["", "Form 1", "Form 2", "Form 3", "Form 4"];

function masteryColour(m: number, weak: number, strong: number): string {
  if (m >= strong) return "bg-emerald-500";
  if (m >= weak) return "bg-amber-500";
  return "bg-destructive";
}

function Bar({ value, weak, strong }: { value: number; weak: number; strong: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-32 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full ${masteryColour(value, weak, strong)}`}
          style={{ width: `${Math.max(2, value)}%` }}
        />
      </div>
      <span className="w-10 text-right text-sm tabular-nums">{value}%</span>
    </div>
  );
}

export default function SkillsPage() {
  const [code, setCode] = useState("");
  const [lookup, setLookup] = useState("");
  const [form, setForm] = useState("");

  const meta = useQuery<Meta>({ queryKey: ["skills-meta"], queryFn: () => apiGet("/v1/skills") });
  const profile = useQuery<Profile>({
    queryKey: ["skill-profile", lookup],
    queryFn: () => apiGet(`/v1/skills/students/${encodeURIComponent(lookup)}`),
    enabled: lookup.length > 0,
    retry: false,
  });
  const gaps = useQuery<{ gaps: Gap[] }>({
    queryKey: ["skill-gaps", form],
    queryFn: () => apiGet(`/v1/skills/gaps${form ? `?form_level=${encodeURIComponent(form)}` : ""}`),
  });
  const agreement = useQuery<Agreement>({
    queryKey: ["skill-agreement"],
    queryFn: () => apiGet("/v1/skills/agreement"),
  });

  const weak = meta.data?.thresholds.weak ?? 50;
  const strong = meta.data?.thresholds.strong ?? 75;
  const errorLabel = (c: string | null) =>
    c ? (meta.data?.error_types.find((e) => e.code === c)?.label ?? c) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Brain className="h-6 w-6 text-primary" /> Skill profiles
        </h1>
        <p className="text-sm text-muted-foreground">
          Built from your own marking. K9 marks nothing — it reads the ticks, crosses and part
          marks you already gave, and works out which skill each one was about.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" /> One student
          </CardTitle>
          <CardDescription>
            Not "62% in Chemistry" — which parts of Chemistry, how sure we are, and what to do
            next.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setLookup(code.trim());
            }}
          >
            <Input
              className="w-56"
              placeholder="Student code, e.g. STU0007"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button type="submit" disabled={code.trim().length === 0}>
              Look up
            </Button>
          </form>

          {profile.isError && lookup && (
            <p className="text-sm text-muted-foreground">
              No profile for {lookup} yet. It fills in as their papers are marked.
            </p>
          )}

          {profile.data && (
            <div className="space-y-5">
              <div>
                <div className="text-lg font-semibold">{profile.data.student.name}</div>
                <div className="text-xs text-muted-foreground">
                  {profile.data.student.student_code} · {profile.data.student.grade ?? "—"}
                </div>
              </div>

              {profile.data.priority.length > 0 && (
                <div className="rounded-lg border bg-muted/40 p-4">
                  <div className="mb-2 text-sm font-semibold">Help with these first</div>
                  <ol className="space-y-1 text-sm">
                    {profile.data.priority.map((s, i) => (
                      <li key={s.skill_id} className="flex flex-wrap items-center gap-2">
                        <span className="text-muted-foreground">{i + 1}.</span>
                        <span className="font-medium">{s.name}</span>
                        <span className="text-muted-foreground">({s.subject})</span>
                        <Badge variant="outline">{s.mastery}%</Badge>
                        {s.dominant_error && (
                          <span className="text-xs text-muted-foreground">
                            mostly: {errorLabel(s.dominant_error)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {profile.data.subjects.map((subject) => (
                <div key={subject.subject}>
                  <div className="mb-2 flex items-baseline gap-2">
                    <h3 className="font-semibold">{subject.subject}</h3>
                    <span className="text-sm text-muted-foreground">
                      average {subject.average}%
                    </span>
                  </div>
                  <div className="space-y-1">
                    {subject.skills.map((s) => (
                      <div
                        key={s.skill_id}
                        className="flex flex-wrap items-center gap-3 rounded-md px-2 py-1 hover:bg-muted/50"
                      >
                        <span className="w-56 text-sm">{s.name}</span>
                        <Bar value={s.mastery} weak={weak} strong={strong} />
                        {s.trend > 5 && (
                          <span className="flex items-center gap-1 text-xs text-emerald-600">
                            <TrendingUp className="h-3 w-3" />+{s.trend}
                          </span>
                        )}
                        {s.trend < -5 && (
                          <span className="flex items-center gap-1 text-xs text-destructive">
                            <TrendingDown className="h-3 w-3" />
                            {s.trend}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {s.attempts} question{s.attempts === 1 ? "" : "s"}
                        </span>
                        {s.confidence < 40 && (
                          <Badge variant="outline" className="text-xs">
                            not much evidence yet
                          </Badge>
                        )}
                        {s.dominant_error && s.mastery < strong && (
                          <span className="text-xs text-muted-foreground">
                            {errorLabel(s.dominant_error)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {profile.data.subjects.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No marked papers for this student yet.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <School className="h-5 w-5" /> Where a whole form is stuck
            </CardTitle>
            <CardDescription>
              Skills most of a form is below {weak}% on. This is what a remedial lesson gets
              timetabled against — before the exam, not after it.
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-1">
            {FORMS.map((f) => (
              <Button
                key={f || "all"}
                size="sm"
                variant={form === f ? "default" : "outline"}
                onClick={() => setForm(f)}
              >
                {f || "All"}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Skill</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead className="text-right">Struggling</TableHead>
                <TableHead className="text-right">Share</TableHead>
                <TableHead className="text-right">Form average</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(gaps.data?.gaps ?? []).slice(0, 25).map((g) => (
                <TableRow key={g.skill_id}>
                  <TableCell className="font-medium">{g.name}</TableCell>
                  <TableCell className="text-muted-foreground">{g.subject}</TableCell>
                  <TableCell className="text-right">
                    {g.struggling} of {g.students}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant={g.share >= 50 ? "destructive" : "secondary"}>{g.share}%</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{g.average}%</TableCell>
                </TableRow>
              ))}
              {(gaps.data?.gaps.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    Not enough marked papers yet to see a pattern.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {(agreement.data?.total ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScanLine className="h-5 w-5" /> Where K9 read a paper differently
            </CardTitle>
            <CardDescription>
              When a scan proposed a mark and you awarded a different one, yours stands — always.
              This is only the record of how far apart the two were.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-2xl font-bold">
              {agreement.data!.agreement_rate}%
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                agreement across {agreement.data!.total} marked questions
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {agreement.data!.by_subject.map((s) => (
                <Badge key={s.subject ?? "none"} variant="secondary">
                  {s.subject ?? "unspecified"}: {s.rate}% of {s.total}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
