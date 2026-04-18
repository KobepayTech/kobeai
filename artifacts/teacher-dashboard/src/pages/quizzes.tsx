import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { BookOpen, Clock, Target, Plus, Trophy, Trash2, X } from "lucide-react";

type AuthoredQuiz = {
  id: string;
  title: string;
  subject: string;
  questions_count: number;
  points_possible: number;
  duration_minutes: number;
  class_id: number | null;
  created_at: string;
};

type LeaderboardRow = {
  student_code: string;
  student_name: string;
  best_score: number;
  best_points: number;
  attempts: number;
  last_at: string;
};

type DraftQuestion = {
  text: string;
  options: string[];
  correct_letter: string;
  points: number;
};

function authHeader(): HeadersInit {
  const token = localStorage.getItem("teacher_token") ?? "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchTeacherQuizzes(): Promise<AuthoredQuiz[]> {
  const res = await fetch("/api/v1/teacher/quizzes", { headers: authHeader() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body.quizzes ?? [];
}

async function fetchLeaderboard(quizId: string): Promise<LeaderboardRow[]> {
  const res = await fetch(`/api/v1/teacher/quizzes/${quizId}/leaderboard`, { headers: authHeader() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body.leaderboard ?? [];
}

const SUBJECTS = ["Mathematics", "Science", "History", "English", "Kiswahili", "Geography", "Biology", "Chemistry", "Physics"];

export default function Quizzes() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: quizzes, isLoading } = useQuery({
    queryKey: ["teacher-quizzes"],
    queryFn: fetchTeacherQuizzes,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [leaderboardQuiz, setLeaderboardQuiz] = useState<AuthoredQuiz | null>(null);

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/v1/teacher/quizzes/${id}`, {
        method: "DELETE",
        headers: authHeader(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      toast({ title: "Quiz deleted" });
      void queryClient.invalidateQueries({ queryKey: ["teacher-quizzes"] });
    },
    onError: () => toast({ title: "Could not delete quiz", variant: "destructive" }),
  });

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Quizzes</h1>
          <p className="text-muted-foreground mt-1">Author quizzes and watch how your students rank.</p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="h-4 w-4" /> New quiz</Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
            <NewQuizForm onCreated={() => { setCreateOpen(false); void queryClient.invalidateQueries({ queryKey: ["teacher-quizzes"] }); }} />
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader><Skeleton className="h-6 w-2/3" /><Skeleton className="h-4 w-1/3" /></CardHeader>
              <CardContent><Skeleton className="h-20 w-full" /></CardContent>
              <CardFooter><Skeleton className="h-10 w-full" /></CardFooter>
            </Card>
          ))
        ) : quizzes && quizzes.length > 0 ? (
          quizzes.map((quiz) => (
            <Card key={quiz.id} className="flex flex-col hover:border-primary/50 transition-colors">
              <CardHeader>
                <div className="flex justify-between items-start">
                  <Badge variant="outline" className="mb-2 bg-secondary">{quiz.subject}</Badge>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      if (confirm(`Delete "${quiz.title}"? This removes all attempts too.`)) deleteMutation.mutate(quiz.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <CardTitle className="line-clamp-2 leading-tight">{quiz.title}</CardTitle>
                <CardDescription>Created {new Date(quiz.created_at).toLocaleDateString()}</CardDescription>
              </CardHeader>
              <CardContent className="flex-1">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <BookOpen className="h-4 w-4" /> <span>{quiz.questions_count} Questions</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Clock className="h-4 w-4" /> <span>{quiz.duration_minutes} Mins</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground col-span-2">
                    <Target className="h-4 w-4" /> <span>{quiz.points_possible} Points Possible</span>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="pt-4 border-t">
                <Button className="w-full gap-2" variant="outline" onClick={() => setLeaderboardQuiz(quiz)}>
                  <Trophy className="h-4 w-4" /> Leaderboard
                </Button>
              </CardFooter>
            </Card>
          ))
        ) : (
          <Card className="col-span-full">
            <CardContent className="py-12 text-center text-muted-foreground">
              No quizzes yet. Click <strong>New quiz</strong> to create your first one — your students will see it on their watches immediately.
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={!!leaderboardQuiz} onOpenChange={(open) => !open && setLeaderboardQuiz(null)}>
        <DialogContent className="sm:max-w-2xl">
          {leaderboardQuiz && <LeaderboardView quiz={leaderboardQuiz} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LeaderboardView({ quiz }: { quiz: AuthoredQuiz }) {
  const { data, isLoading } = useQuery({
    queryKey: ["quiz-leaderboard", quiz.id],
    queryFn: () => fetchLeaderboard(quiz.id),
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Trophy className="h-5 w-5 text-primary" /> {quiz.title}</DialogTitle>
        <DialogDescription>Best score per student. Re-takes never lower a rank.</DialogDescription>
      </DialogHeader>
      {isLoading ? (
        <div className="py-8 text-center text-muted-foreground">Loading…</div>
      ) : !data || data.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">No attempts yet.</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Student</TableHead>
              <TableHead className="text-right">Score</TableHead>
              <TableHead className="text-right">Points</TableHead>
              <TableHead className="text-right">Attempts</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row, i) => (
              <TableRow key={row.student_code}>
                <TableCell className="font-bold text-muted-foreground">{i + 1}</TableCell>
                <TableCell>
                  <div className="font-medium">{row.student_name}</div>
                  <div className="text-xs text-muted-foreground">{row.student_code}</div>
                </TableCell>
                <TableCell className="text-right font-bold">{row.best_score}%</TableCell>
                <TableCell className="text-right">{row.best_points}</TableCell>
                <TableCell className="text-right text-muted-foreground">{row.attempts}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

function blankQuestion(): DraftQuestion {
  return { text: "", options: ["", ""], correct_letter: "A", points: 10 };
}

function NewQuizForm({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("Mathematics");
  const [duration, setDuration] = useState(15);
  const [questions, setQuestions] = useState<DraftQuestion[]>([blankQuestion()]);
  const [submitting, setSubmitting] = useState(false);

  function updateQuestion(idx: number, patch: Partial<DraftQuestion>) {
    setQuestions((prev) => prev.map((q, i) => (i === idx ? { ...q, ...patch } : q)));
  }
  function setOption(qIdx: number, optIdx: number, value: string) {
    setQuestions((prev) =>
      prev.map((q, i) => (i === qIdx ? { ...q, options: q.options.map((o, oi) => (oi === optIdx ? value : o)) } : q)),
    );
  }
  function addOption(qIdx: number) {
    setQuestions((prev) => prev.map((q, i) => (i === qIdx && q.options.length < 6 ? { ...q, options: [...q.options, ""] } : q)));
  }
  function removeOption(qIdx: number, optIdx: number) {
    setQuestions((prev) =>
      prev.map((q, i) => {
        if (i !== qIdx || q.options.length <= 2) return q;
        const newOpts = q.options.filter((_, oi) => oi !== optIdx);
        const removedLetter = String.fromCharCode(65 + optIdx);
        // If we just removed the currently-correct option, snap back to A.
        const newCorrect = q.correct_letter === removedLetter || q.correct_letter.charCodeAt(0) - 65 >= newOpts.length ? "A" : q.correct_letter;
        return { ...q, options: newOpts, correct_letter: newCorrect };
      }),
    );
  }

  async function submit() {
    if (!title.trim() || !subject.trim()) {
      toast({ title: "Title and subject are required", variant: "destructive" });
      return;
    }
    if (questions.some((q) => !q.text.trim() || q.options.some((o) => !o.trim()))) {
      toast({ title: "Fill in every question and option", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/teacher/quizzes", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader() },
        body: JSON.stringify({ title, subject, duration_minutes: duration, questions }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      toast({ title: "Quiz published", description: "Your students will see it on their watches now." });
      onCreated();
    } catch (e) {
      toast({ title: "Could not save quiz", description: String((e as Error).message), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>New quiz</DialogTitle>
        <DialogDescription>Authored quizzes appear on every enrolled student's watch within a few seconds.</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="quiz-title">Title</Label>
            <Input id="quiz-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Algebra Refresh" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quiz-subject">Subject</Label>
            <Select value={subject} onValueChange={setSubject}>
              <SelectTrigger id="quiz-subject"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SUBJECTS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5 max-w-[200px]">
          <Label htmlFor="quiz-duration">Duration (minutes)</Label>
          <Input id="quiz-duration" type="number" min={1} max={120} value={duration} onChange={(e) => setDuration(Number(e.target.value) || 15)} />
        </div>

        <div className="space-y-3 pt-2">
          <div className="flex items-center justify-between">
            <Label>Questions ({questions.length})</Label>
            <Button size="sm" variant="outline" onClick={() => setQuestions((p) => [...p, blankQuestion()])}>
              <Plus className="h-3 w-3 mr-1" /> Add question
            </Button>
          </div>
          {questions.map((q, qi) => (
            <Card key={qi} className="p-4 space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm font-semibold">Question {qi + 1}</span>
                {questions.length > 1 && (
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setQuestions((p) => p.filter((_, i) => i !== qi))}>
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <Textarea value={q.text} onChange={(e) => updateQuestion(qi, { text: e.target.value })} placeholder="What is 2 + 2?" rows={2} />
              <div className="space-y-2">
                {q.options.map((opt, oi) => {
                  const letter = String.fromCharCode(65 + oi);
                  const isCorrect = q.correct_letter === letter;
                  return (
                    <div key={oi} className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={isCorrect ? "default" : "outline"}
                        className="w-9 h-9 p-0 shrink-0"
                        onClick={() => updateQuestion(qi, { correct_letter: letter })}
                        title={isCorrect ? "Correct answer" : "Mark as correct"}
                      >
                        {letter}
                      </Button>
                      <Input value={opt} onChange={(e) => setOption(qi, oi, e.target.value)} placeholder={`Option ${letter}`} />
                      {q.options.length > 2 && (
                        <Button size="icon" variant="ghost" className="h-9 w-9 shrink-0" onClick={() => removeOption(qi, oi)}>
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  );
                })}
                {q.options.length < 6 && (
                  <Button size="sm" variant="ghost" onClick={() => addOption(qi)}>
                    <Plus className="h-3 w-3 mr-1" /> Add option
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2 max-w-[180px]">
                <Label htmlFor={`pts-${qi}`} className="text-xs text-muted-foreground shrink-0">Points</Label>
                <Input id={`pts-${qi}`} type="number" min={1} max={100} value={q.points} onChange={(e) => updateQuestion(qi, { points: Number(e.target.value) || 10 })} />
              </div>
            </Card>
          ))}
        </div>
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={submitting}>{submitting ? "Publishing…" : "Publish quiz"}</Button>
      </DialogFooter>
    </>
  );
}
