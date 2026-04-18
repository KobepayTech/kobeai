import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPatch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Plus, Target, Lock, Trophy } from "lucide-react";

type Question = {
  id: number;
  subject: string;
  prompt: string;
  choices: string[];
  correct_index: number;
  kp_reward: number;
  status: string;
  active_locks: number;
  released_at: string;
  expires_at: string | null;
};

function statusBadge(status: string) {
  if (status === "open")
    return <Badge className="bg-emerald-500 hover:bg-emerald-500">Live</Badge>;
  if (status === "won") return <Badge className="bg-amber-500">Won</Badge>;
  if (status === "locked")
    return <Badge variant="outline">Locked</Badge>;
  return <Badge variant="secondary">{status}</Badge>;
}

const PRESET_REWARD = 500;
const LOCK_COST_HINT = 10;
const LOCK_WINDOW_HINT = "5 min";

export default function CentralMarket() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<string>("all");

  const { data, isLoading } = useQuery({
    queryKey: ["/central/v1/admin/market/questions"],
    queryFn: () =>
      apiGet<{ questions: Question[] }>("/central/v1/admin/market/questions"),
    refetchInterval: 10_000,
  });
  const questions = data?.questions ?? [];
  const visible = useMemo(
    () =>
      filter === "all" ? questions : questions.filter((q) => q.status === filter),
    [questions, filter],
  );

  const stats = useMemo(() => {
    const live = questions.filter((q) => q.status === "open").length;
    const won = questions.filter((q) => q.status === "won").length;
    const activeLocks = questions.reduce((s, q) => s + (q.active_locks || 0), 0);
    const totalReward = questions
      .filter((q) => q.status === "open")
      .reduce((s, q) => s + q.kp_reward, 0);
    return { live, won, activeLocks, totalReward };
  }, [questions]);

  const [form, setForm] = useState({
    subject: "math",
    prompt: "",
    choiceA: "",
    choiceB: "",
    choiceC: "",
    choiceD: "",
    correct_index: 0,
    kp_reward: PRESET_REWARD,
  });

  const createMut = useMutation({
    mutationFn: (body: typeof form) =>
      apiPost<{ question: Question }>("/central/v1/admin/market/questions", {
        subject: body.subject,
        prompt: body.prompt,
        choices: [body.choiceA, body.choiceB, body.choiceC, body.choiceD].filter(
          (c) => c.trim(),
        ),
        correct_index: body.correct_index,
        kp_reward: body.kp_reward,
      }),
    onSuccess: () => {
      toast({ title: "Question published", description: "Live to all schools" });
      setOpen(false);
      setForm({
        subject: "math",
        prompt: "",
        choiceA: "",
        choiceB: "",
        choiceC: "",
        choiceD: "",
        correct_index: 0,
        kp_reward: PRESET_REWARD,
      });
      qc.invalidateQueries({
        queryKey: ["/central/v1/admin/market/questions"],
      });
    },
    onError: (e: Error) => {
      toast({
        title: "Could not publish",
        description: e.message,
        variant: "destructive",
      });
    },
  });

  const archive = useMutation({
    mutationFn: (id: number) =>
      apiPatch<{ question: Question }>(
        `/central/v1/admin/market/questions/${id}`,
        { status: "expired" },
      ),
    onSuccess: () => {
      toast({ title: "Question archived" });
      qc.invalidateQueries({
        queryKey: ["/central/v1/admin/market/questions"],
      });
    },
    onError: (e: Error) => {
      toast({
        title: "Archive failed",
        description: e.message,
        variant: "destructive",
      });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Question Market</h1>
          <p className="text-sm text-muted-foreground">
            You author the questions · students across all schools lock for{" "}
            {LOCK_COST_HINT} KP and answer to win the reward
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-new-question">
              <Plus className="w-4 h-4 mr-2" /> New question
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>New market question</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Subject</Label>
                  <Input
                    value={form.subject}
                    onChange={(e) =>
                      setForm({ ...form, subject: e.target.value })
                    }
                    placeholder="math"
                  />
                </div>
                <div>
                  <Label>Reward (KP)</Label>
                  <Input
                    type="number"
                    value={form.kp_reward}
                    onChange={(e) =>
                      setForm({ ...form, kp_reward: Number(e.target.value) })
                    }
                  />
                </div>
              </div>
              <div>
                <Label>Question</Label>
                <Input
                  value={form.prompt}
                  onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                  placeholder="Solve for x: 2x + 3 = 11"
                />
              </div>
              {(["A", "B", "C", "D"] as const).map((letter, idx) => {
                const key = `choice${letter}` as keyof typeof form;
                return (
                  <div key={letter} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, correct_index: idx })}
                      className={`w-8 h-8 rounded-full border-2 text-xs font-bold flex-shrink-0 ${
                        form.correct_index === idx
                          ? "bg-emerald-500 border-emerald-500 text-white"
                          : "border-gray-300 text-gray-500"
                      }`}
                    >
                      {letter}
                    </button>
                    <Input
                      value={form[key] as string}
                      onChange={(e) =>
                        setForm({ ...form, [key]: e.target.value })
                      }
                      placeholder={`Option ${letter}${idx === 0 ? " (tap letter to mark correct)" : ""}`}
                    />
                  </div>
                );
              })}
            </div>
            <DialogFooter className="mt-3">
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => createMut.mutate(form)}
                disabled={createMut.isPending || !form.prompt || !form.choiceA || !form.choiceB}
              >
                {createMut.isPending ? "Publishing…" : "Publish"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase text-muted-foreground tracking-wide">
              Live questions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold flex items-center gap-2">
              <Target className="w-5 h-5 text-emerald-600" /> {stats.live}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase text-muted-foreground tracking-wide">
              Active locks
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold flex items-center gap-2">
              <Lock className="w-5 h-5 text-amber-600" /> {stats.activeLocks}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase text-muted-foreground tracking-wide">
              Resolved (won)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold flex items-center gap-2">
              <Trophy className="w-5 h-5 text-amber-500" /> {stats.won}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase text-muted-foreground tracking-wide">
              Reward pool (open)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">
              {stats.totalReward.toLocaleString()} KP
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">All questions</CardTitle>
            <div className="flex gap-2">
              {(["all", "open", "won", "expired"] as const).map((s) => (
                <Button
                  key={s}
                  variant={filter === s ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilter(s)}
                  className="capitalize"
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>
          <div className="text-xs text-muted-foreground pt-1">
            Lock cost: <strong>{LOCK_COST_HINT} KP</strong> · Reward: per question
            · Lock window: <strong>{LOCK_WINDOW_HINT}</strong>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              Loading…
            </div>
          ) : visible.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              No questions yet — click "New question" to publish your first one.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Question</TableHead>
                  <TableHead>Reward</TableHead>
                  <TableHead>Active locks</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((q) => (
                  <TableRow key={q.id} data-testid={`row-q-${q.id}`}>
                    <TableCell className="font-mono text-muted-foreground">
                      #{q.id}
                    </TableCell>
                    <TableCell className="capitalize">{q.subject}</TableCell>
                    <TableCell className="max-w-md truncate">
                      {q.prompt}
                    </TableCell>
                    <TableCell className="font-semibold text-emerald-600">
                      +{q.kp_reward} KP
                    </TableCell>
                    <TableCell>{q.active_locks}</TableCell>
                    <TableCell>{statusBadge(q.status)}</TableCell>
                    <TableCell className="text-right">
                      {q.status === "open" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => archive.mutate(q.id)}
                        >
                          Archive
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
