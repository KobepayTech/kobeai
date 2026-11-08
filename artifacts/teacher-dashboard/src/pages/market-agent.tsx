import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorText, apiGet, apiPatch, apiPost } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Bot, Play, Coins, Layers, CheckCircle2, XCircle } from "lucide-react";

// Operator console for the agent that runs the question market. It is the
// only place the reward band, the floor depth and the review mode can be
// changed, and it shows what the agent actually did on every cycle — the
// market pays real KP, so it is never a black box.

type Settings = {
  enabled: boolean;
  floor_per_subject: number;
  max_open_questions: number;
  cycle_minutes: number;
  stale_hours: number;
  reward_min: number;
  reward_max: number;
  human_review: boolean;
  subjects: string[];
};

type PlanItem = {
  subject: string;
  topic: string;
  difficulty: string;
  count: number;
  reason: string;
};

type Run = {
  id: number;
  trigger: string;
  status: string;
  model: string | null;
  generated: number;
  accepted: number;
  rejected: number;
  expired: number;
  locks_released: number;
  notes: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

type Console = {
  settings: Settings;
  floor: {
    total_open: number;
    by_subject: Record<string, number>;
    won_24h: Record<string, number>;
    roster_subjects: string[];
    weak_topics: string[];
  };
  next_plan: PlanItem[];
  payouts: { paid_24h: number; paid_7d: number; open_liability: number };
  pending_review: number;
  runs: Run[];
};

type PendingQuestion = {
  id: number;
  subject: string;
  topic: string | null;
  difficulty: string | null;
  prompt: string;
  choices: string[];
  correct_index: number;
  kp_reward: number;
  explanation: string | null;
};

const NUMERIC: Array<{ key: keyof Settings; label: string; hint: string }> = [
  { key: "floor_per_subject", label: "Floor per subject", hint: "Open questions the agent keeps stocked" },
  { key: "max_open_questions", label: "Max open questions", hint: "Hard ceiling on the whole floor" },
  { key: "cycle_minutes", label: "Cycle (minutes)", hint: "0 turns the timer off; manual runs still work" },
  { key: "stale_hours", label: "Stale after (hours)", hint: "Unsolved questions expire past this" },
  { key: "reward_min", label: "Reward floor (KP)", hint: "Cheapest question the agent may post" },
  { key: "reward_max", label: "Reward ceiling (KP)", hint: "Most it may ever pay for one" },
];

export default function MarketAgentPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState<Partial<Settings>>({});

  const { data, isLoading } = useQuery<Console>({
    queryKey: ["market-agent"],
    queryFn: () => apiGet("/central/v1/admin/market-agent"),
    refetchInterval: 30_000,
  });

  const review = useQuery<{ questions: PendingQuestion[] }>({
    queryKey: ["market-agent-review"],
    queryFn: () => apiGet("/central/v1/admin/market-agent/review"),
    enabled: !!data?.settings.human_review || (data?.pending_review ?? 0) > 0,
  });

  const save = useMutation({
    mutationFn: (patch: Partial<Settings>) => apiPatch("/central/v1/admin/market-agent", patch),
    onSuccess: () => {
      setDraft({});
      toast({ title: "Agent retuned" });
      qc.invalidateQueries({ queryKey: ["market-agent"] });
    },
    onError: (err) =>
      toast({ variant: "destructive", title: "Could not save", description: apiErrorText(err) }),
  });

  const run = useMutation({
    mutationFn: () => apiPost<{ run: Run }>("/central/v1/admin/market-agent/run", {}),
    onSuccess: (res) => {
      toast({
        title: "Cycle finished",
        description: `${res.run.accepted} posted, ${res.run.rejected} rejected, ${res.run.expired} expired.`,
      });
      qc.invalidateQueries({ queryKey: ["market-agent"] });
    },
    onError: (err) =>
      toast({ variant: "destructive", title: "Cycle failed", description: apiErrorText(err) }),
  });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "approve" | "reject" }) =>
      apiPost(`/central/v1/admin/market-agent/review/${id}`, { decision }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["market-agent-review"] });
      qc.invalidateQueries({ queryKey: ["market-agent"] });
    },
  });

  if (isLoading || !data) return <div className="text-muted-foreground">Loading the agent…</div>;

  const settings = { ...data.settings, ...draft };
  const dirty = Object.keys(draft).length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Bot className="h-6 w-6 text-primary" /> Question Market Agent
          </h1>
          <p className="text-sm text-muted-foreground">
            Writes, checks and prices the questions students answer, on the school's own models.
          </p>
        </div>
        <Button onClick={() => run.mutate()} disabled={run.isPending}>
          <Play className="mr-2 h-4 w-4" />
          {run.isPending ? "Running…" : "Run a cycle now"}
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Stat icon={Layers} label="On the floor" value={String(data.floor.total_open)} hint="Open questions" />
        <Stat
          icon={Coins}
          label="KP paid (24h)"
          value={data.payouts.paid_24h.toLocaleString()}
          hint={`${data.payouts.paid_7d.toLocaleString()} over 7 days`}
        />
        <Stat
          icon={Coins}
          label="Open liability"
          value={data.payouts.open_liability.toLocaleString()}
          hint="KP the floor would pay if every question were won"
        />
        <Stat
          icon={CheckCircle2}
          label="Awaiting review"
          value={String(data.pending_review)}
          hint={settings.human_review ? "Human review is on" : "Human review is off"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What the next cycle would do</CardTitle>
          <CardDescription>
            A dry run of the plan, with the agent's reason for each line. Weak topics come from
            students' learning profiles; the rest is curriculum rotation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.next_plan.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing to do — every subject is stocked to its floor.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>Topic</TableHead>
                  <TableHead>Difficulty</TableHead>
                  <TableHead>Count</TableHead>
                  <TableHead>Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.next_plan.map((item, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{item.subject}</TableCell>
                    <TableCell>{item.topic}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{item.difficulty}</Badge>
                    </TableCell>
                    <TableCell>{item.count}</TableCell>
                    <TableCell className="text-muted-foreground">{item.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>
            The reward band caps what the agent can ever pay for one question, and the ceiling
            caps the whole floor. Both are how the KP economy stays bounded.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Toggle
              label={settings.enabled ? "Agent is running" : "Agent is paused"}
              on={settings.enabled}
              onClick={() => setDraft({ ...draft, enabled: !settings.enabled })}
            />
            <Toggle
              label={settings.human_review ? "Human review on" : "Human review off"}
              on={settings.human_review}
              onClick={() => setDraft({ ...draft, human_review: !settings.human_review })}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {NUMERIC.map((field) => (
              <div key={field.key} className="space-y-2">
                <Label htmlFor={field.key}>{field.label}</Label>
                <Input
                  id={field.key}
                  type="number"
                  min={0}
                  value={String(settings[field.key] ?? 0)}
                  onChange={(e) => setDraft({ ...draft, [field.key]: Number(e.target.value) })}
                />
                <p className="text-xs text-muted-foreground">{field.hint}</p>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={() => setDraft({})}>
                Discard
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {(review.data?.questions.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Waiting for a human</CardTitle>
            <CardDescription>
              These passed the agent's own verification pass but are held back because human
              review is on.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {review.data!.questions.map((q) => (
              <div key={q.id} className="rounded-lg border p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">{q.subject}</Badge>
                  {q.topic && <span>{q.topic}</span>}
                  {q.difficulty && <Badge variant="secondary">{q.difficulty}</Badge>}
                  <span>{q.kp_reward} KP</span>
                </div>
                <p className="font-medium">{q.prompt}</p>
                <ul className="mt-2 space-y-1 text-sm">
                  {q.choices.map((c, i) => (
                    <li key={i} className={i === q.correct_index ? "font-semibold text-primary" : ""}>
                      {String.fromCharCode(65 + i)}. {c}
                    </li>
                  ))}
                </ul>
                {q.explanation && (
                  <p className="mt-2 text-sm text-muted-foreground">{q.explanation}</p>
                )}
                <div className="mt-3 flex gap-2">
                  <Button size="sm" onClick={() => decide.mutate({ id: q.id, decision: "approve" })}>
                    <CheckCircle2 className="mr-2 h-4 w-4" /> Put on the floor
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => decide.mutate({ id: q.id, decision: "reject" })}
                  >
                    <XCircle className="mr-2 h-4 w-4" /> Reject
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent cycles</CardTitle>
          <CardDescription>
            Every cycle is recorded: what it wrote, what it threw away, and why.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Posted</TableHead>
                <TableHead>Rejected</TableHead>
                <TableHead>Swept</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.runs.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-muted-foreground">
                    {new Date(r.started_at).toLocaleString()}
                  </TableCell>
                  <TableCell>{r.trigger}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        r.status === "ok" ? "default" : r.status === "failed" ? "destructive" : "secondary"
                      }
                    >
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{r.accepted}</TableCell>
                  <TableCell>{r.rejected}</TableCell>
                  <TableCell>
                    {r.expired} expired, {r.locks_released} locks
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.model ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{r.error ?? r.notes ?? "—"}</TableCell>
                </TableRow>
              ))}
              {data.runs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    The agent has not run yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <Button variant={on ? "default" : "outline"} size="sm" onClick={onClick}>
      {label}
    </Button>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Bot;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 pt-6">
        <div className="rounded-md bg-primary/10 p-3">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0">
          <div className="text-2xl font-bold leading-none">{value}</div>
          <div className="text-sm font-medium">{label}</div>
          <div className="truncate text-xs text-muted-foreground">{hint}</div>
        </div>
      </CardContent>
    </Card>
  );
}
