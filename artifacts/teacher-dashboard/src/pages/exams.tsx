import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Timer, Play, Pause, Plus, Square } from "lucide-react";

type Exam = {
  id: number;
  class_id: number;
  title: string;
  status: "scheduled" | "active" | "paused" | "finished";
  initial_seconds: number;
  seconds_added: number;
  remaining_seconds: number;
  ends_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  supervisor_user_id: number;
};
type ClassRow = { id: number; name: string };

function authHeader(): HeadersInit {
  const token = localStorage.getItem("teacher_token") ?? "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}
function fmtMMSS(total: number): string {
  total = Math.max(0, Math.floor(total));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}

async function fetchClasses(): Promise<ClassRow[]> {
  const res = await fetch("/api/v1/teacher/classes", { headers: authHeader() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).classes ?? [];
}
async function fetchExams(): Promise<Exam[]> {
  const res = await fetch("/api/v1/teacher/exams", { headers: authHeader() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).exams ?? [];
}

/** Live MM:SS that ticks every second based on `ends_at` for active exams. */
function useLiveRemaining(exam: Exam): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (exam.status !== "active") return;
    const i = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(i);
  }, [exam.status]);
  if (exam.status === "active" && exam.ends_at) {
    return Math.max(0, Math.floor((new Date(exam.ends_at).getTime() - now) / 1000));
  }
  return exam.remaining_seconds;
}

function ExamCard({ exam, className }: { exam: Exam; className: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const remaining = useLiveRemaining(exam);

  const action = useMutation({
    mutationFn: async ({ verb, body }: { verb: string; body?: unknown }) => {
      const res = await fetch(`/api/v1/teacher/exams/${exam.id}/${verb}`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      return await res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["exams"] }),
    onError: (e: Error) => toast({ title: "Action failed", description: e.message, variant: "destructive" }),
  });

  const statusColor = {
    scheduled: "bg-blue-500",
    active: "bg-green-500 animate-pulse",
    paused: "bg-amber-500",
    finished: "bg-gray-400",
  }[exam.status];

  return (
    <Card data-testid={`card-exam-${exam.id}`}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{exam.title}</CardTitle>
            <CardDescription>
              {className} · started from {Math.floor(exam.initial_seconds / 60)} min
              {exam.seconds_added !== 0 && (
                <> · supervisor added {exam.seconds_added > 0 ? "+" : ""}{Math.round(exam.seconds_added / 60)} min</>
              )}
            </CardDescription>
          </div>
          <Badge className={statusColor}>{exam.status}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-center py-6 bg-muted rounded-lg">
          <div className="text-6xl font-mono font-bold tracking-tighter" data-testid={`text-remaining-${exam.id}`}>
            {fmtMMSS(remaining)}
          </div>
          <div className="text-xs text-muted-foreground mt-1 uppercase tracking-wider">remaining</div>
        </div>

        {exam.status !== "finished" && (
          <>
            <div className="grid grid-cols-4 gap-2">
              {[60, 300, 600, 900].map((s) => (
                <Button
                  key={s}
                  variant="outline"
                  size="sm"
                  onClick={() => action.mutate({ verb: "add-time", body: { seconds: s } })}
                  data-testid={`button-add-${s}`}
                >
                  +{s / 60}m
                </Button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => action.mutate({ verb: "add-time", body: { seconds: -60 } })}
                data-testid={`button-sub-60-${exam.id}`}
              >
                −1 min
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => action.mutate({ verb: "add-time", body: { seconds: -300 } })}
                data-testid={`button-sub-300-${exam.id}`}
              >
                −5 min
              </Button>
            </div>
            <div className="flex gap-2">
              {exam.status === "scheduled" && (
                <Button className="flex-1" onClick={() => action.mutate({ verb: "start" })} data-testid={`button-start-${exam.id}`}>
                  <Play className="h-4 w-4 mr-2" /> Start
                </Button>
              )}
              {exam.status === "active" && (
                <Button className="flex-1" variant="secondary" onClick={() => action.mutate({ verb: "pause" })} data-testid={`button-pause-${exam.id}`}>
                  <Pause className="h-4 w-4 mr-2" /> Pause
                </Button>
              )}
              {exam.status === "paused" && (
                <Button className="flex-1" onClick={() => action.mutate({ verb: "resume" })} data-testid={`button-resume-${exam.id}`}>
                  <Play className="h-4 w-4 mr-2" /> Resume
                </Button>
              )}
              <Button variant="destructive" onClick={() => action.mutate({ verb: "finish" })} data-testid={`button-finish-${exam.id}`}>
                <Square className="h-4 w-4 mr-2" /> Finish
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function ExamsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draftClassId, setDraftClassId] = useState<number | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftMinutes, setDraftMinutes] = useState(60);

  const classesQ = useQuery({ queryKey: ["classes"], queryFn: fetchClasses });
  const examsQ = useQuery({ queryKey: ["exams"], queryFn: fetchExams, refetchInterval: 5000 });

  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/v1/teacher/exams", {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          class_id: draftClassId,
          title: draftTitle,
          duration_minutes: draftMinutes,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      return await res.json();
    },
    onSuccess: () => {
      toast({ title: "Exam session created", description: "Press Start to send the countdown to all student watches." });
      qc.invalidateQueries({ queryKey: ["exams"] });
      setOpen(false);
      setDraftTitle("");
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const classNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of classesQ.data ?? []) m.set(c.id, c.name);
    return m;
  }, [classesQ.data]);

  const open_ = (examsQ.data ?? []).filter((e) => e.status !== "finished");
  const finished = (examsQ.data ?? []).filter((e) => e.status === "finished");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Timer className="h-6 w-6 text-primary" />
            Exam Mode (Master Supervisor)
          </h1>
          <p className="text-sm text-muted-foreground">
            Start a countdown that takes over every student watch in the class. Use the buttons below to add or remove time mid-exam.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-new-exam"><Plus className="h-4 w-4 mr-2" />New exam session</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New exam session</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3">
              <div>
                <Label>Class</Label>
                <Select value={draftClassId ? String(draftClassId) : ""} onValueChange={(v) => setDraftClassId(Number(v))}>
                  <SelectTrigger data-testid="select-exam-class"><SelectValue placeholder="Select class" /></SelectTrigger>
                  <SelectContent>
                    {(classesQ.data ?? []).map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Title</Label>
                <Input data-testid="input-exam-title" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="Mid-term Mathematics" />
              </div>
              <div>
                <Label>Duration (minutes)</Label>
                <Input type="number" min={1} max={600} value={draftMinutes} onChange={(e) => setDraftMinutes(Number(e.target.value))} data-testid="input-exam-minutes" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={() => create.mutate()} disabled={create.isPending} data-testid="button-create-exam">
                {create.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {examsQ.isLoading ? (
        <Skeleton className="h-72 w-full" />
      ) : open_.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No active exam sessions. Create one to push a countdown to every watch in a class.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {open_.map((e) => (
            <ExamCard key={e.id} exam={e} className={classNameById.get(e.class_id) ?? `Class ${e.class_id}`} />
          ))}
        </div>
      )}

      {finished.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">Finished</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {finished.slice(0, 6).map((e) => (
              <Card key={e.id} className="opacity-70">
                <CardContent className="py-3 text-sm">
                  <div className="font-semibold">{e.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {classNameById.get(e.class_id) ?? `Class ${e.class_id}`} ·{" "}
                    {Math.floor((e.initial_seconds + e.seconds_added) / 60)} min total
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
