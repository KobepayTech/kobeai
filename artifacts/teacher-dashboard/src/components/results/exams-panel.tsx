import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Glasses, Lock, LockOpen, PencilLine, Plus, X } from "lucide-react";
import { apiDelete, apiErrorText, apiGet, apiPatch, apiPost, apiPut } from "@/lib/api";
import { fmtDate, type Exam, type SheetRow } from "@/lib/results";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const KIND_LABEL = { ca: "Continuous assessment", terminal: "Terminal exam" } as const;

function invalidateResults(qc: ReturnType<typeof useQueryClient>) {
  for (const key of ["results-exams", "results-sheet", "results-board", "results-card"]) {
    qc.invalidateQueries({ queryKey: [key] });
  }
}

function CreateExamDialog({
  open,
  onOpenChange,
  classId,
  termId,
  subjects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  classId: number;
  termId: number | null;
  subjects: string[];
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ subject: "", title: "", kind: "terminal", total_marks: "100", held_on: "" });

  useEffect(() => {
    if (open) setForm({ subject: "", title: "", kind: "terminal", total_marks: "100", held_on: "" });
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      apiPost<{ exam: Exam }>("/v1/results/exams", {
        class_id: classId,
        term_id: termId ?? undefined,
        subject: form.subject,
        title: form.title,
        kind: form.kind,
        total_marks: Number(form.total_marks),
        held_on: form.held_on || undefined,
      }),
    onSuccess: ({ exam }) => {
      invalidateResults(qc);
      toast({ title: "Exam created", description: `${exam.subject} · ${exam.title} is open for marking.` });
      onOpenChange(false);
    },
    onError: (err) => toast({ title: "Couldn't create the exam", description: apiErrorText(err), variant: "destructive" }),
  });

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New exam</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="exam-subject">Subject</Label>
              <Input id="exam-subject" list="exam-subjects" value={form.subject} onChange={set("subject")} placeholder="Mathematics" required />
              <datalist id="exam-subjects">
                {subjects.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={form.kind} onValueChange={(kind) => setForm((f) => ({ ...f, kind }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ca">{KIND_LABEL.ca}</SelectItem>
                  <SelectItem value="terminal">{KIND_LABEL.terminal}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="exam-title">Title</Label>
            <Input id="exam-title" value={form.title} onChange={set("title")} placeholder="Mid-term test" required />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="exam-total">Out of (marks)</Label>
              <Input id="exam-total" type="number" min={1} max={1000} step="any" value={form.total_marks} onChange={set("total_marks")} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="exam-date">Date</Label>
              <Input id="exam-date" type="date" value={form.held_on} onChange={set("held_on")} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create exam"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MarksSheet({ examId, onClose }: { examId: number; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const sheet = useQuery({
    queryKey: ["results-sheet", examId],
    queryFn: () => apiGet<{ exam: Exam; students: SheetRow[] }>(`/v1/results/exams/${examId}/results`),
  });

  const save = useMutation({
    mutationFn: ({ studentId, value }: { studentId: number; value: string }) =>
      value === ""
        ? apiDelete(`/v1/results/exams/${examId}/results/${studentId}`)
        : apiPut(`/v1/results/exams/${examId}/results/${studentId}`, { marks: Number(value) }),
    onSuccess: (_data, { studentId }) => {
      setDrafts(({ [studentId]: _saved, ...rest }) => rest);
      invalidateResults(qc);
    },
    onError: (err) => toast({ title: "Mark not saved", description: apiErrorText(err), variant: "destructive" }),
  });

  if (sheet.isLoading || !sheet.data) return <Skeleton className="h-64 w-full" />;
  const { exam, students } = sheet.data;
  const closed = exam.status === "closed";
  const marked = students.filter((s) => s.marks !== null).length;

  const commit = (row: SheetRow) => {
    const draft = drafts[row.student_id];
    if (draft === undefined) return;
    const value = draft.trim();
    const current = row.marks === null ? "" : String(row.marks);
    if (value === current) {
      setDrafts(({ [row.student_id]: _same, ...rest }) => rest);
      return;
    }
    const n = Number(value);
    if (value !== "" && (!Number.isFinite(n) || n < 0 || n > exam.total_marks)) {
      toast({ title: "Check the mark", description: `Marks must be from 0 to ${exam.total_marks}.`, variant: "destructive" });
      return;
    }
    save.mutate({ studentId: row.student_id, value });
  };

  return (
    <Card className="border-primary/40" data-testid={`marks-sheet-${exam.id}`}>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <PencilLine className="h-5 w-5" /> {exam.subject} · {exam.title}
          </CardTitle>
          <CardDescription>
            Out of {exam.total_marks} · {marked} of {students.length} marked · Enter saves and moves down; clear a box to remove a mark.
            {closed && " This exam is closed — reopen it to change marks."}
          </CardDescription>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close marks sheet">
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Student</TableHead>
              <TableHead className="w-40">Marks / {exam.total_marks}</TableHead>
              <TableHead className="text-right">%</TableHead>
              <TableHead>Recorded</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {students.map((row, index) => (
              <TableRow key={row.student_id}>
                <TableCell>
                  <div className="font-medium">{row.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">{row.student_code}</div>
                </TableCell>
                <TableCell>
                  <Input
                    data-mark-index={index}
                    data-testid={`input-mark-${row.student_id}`}
                    inputMode="decimal"
                    className="h-8"
                    disabled={closed}
                    value={drafts[row.student_id] ?? (row.marks === null ? "" : String(row.marks))}
                    onChange={(e) => setDrafts((d) => ({ ...d, [row.student_id]: e.target.value }))}
                    onBlur={() => commit(row)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      commit(row);
                      document.querySelector<HTMLInputElement>(`[data-mark-index="${index + 1}"]`)?.focus();
                    }}
                  />
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.percent === null ? "—" : `${row.percent}%`}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {row.source === "lens" ? (
                    <span className="inline-flex items-center gap-1">
                      <Glasses className="h-3.5 w-3.5" /> glasses
                    </span>
                  ) : (
                    row.source ?? "—"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {students.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No students are enrolled in this class.</p>}
      </CardContent>
    </Card>
  );
}

export function ExamsPanel({ classId, termId }: { classId: number; termId: number | null }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [sheetExamId, setSheetExamId] = useState<number | null>(null);

  const exams = useQuery({
    queryKey: ["results-exams", classId, termId],
    queryFn: () => apiGet<{ exams: Exam[] }>(`/v1/results/exams?class_id=${classId}${termId ? `&term_id=${termId}` : ""}`),
  });

  useEffect(() => setSheetExamId(null), [classId, termId]);

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: Exam["status"] }) => apiPatch(`/v1/results/exams/${id}`, { status }),
    onSuccess: () => invalidateResults(qc),
    onError: (err) => toast({ title: "Couldn't update the exam", description: apiErrorText(err), variant: "destructive" }),
  });

  const list = exams.data?.exams ?? [];
  const subjects = [...new Set(list.map((e) => e.subject))];

  return (
    <div className="space-y-6">
      {sheetExamId !== null && <MarksSheet examId={sheetExamId} onClose={() => setSheetExamId(null)} />}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Exams</CardTitle>
            <CardDescription>Open exams show up on the glasses for marking. Close an exam when its marks are final.</CardDescription>
          </div>
          <Button onClick={() => setCreateOpen(true)} data-testid="button-new-exam">
            <Plus className="mr-2 h-4 w-4" /> New exam
          </Button>
        </CardHeader>
        <CardContent>
          {exams.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : exams.error ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{apiErrorText(exams.error)}</p>
          ) : list.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No exams yet for this class and term.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Exam</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Out of</TableHead>
                  <TableHead className="text-right">Marked</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((exam) => (
                  <TableRow key={exam.id} data-testid={`row-exam-${exam.id}`}>
                    <TableCell>
                      <div className="font-medium">{exam.subject}</div>
                      <div className="text-xs text-muted-foreground">{exam.title}</div>
                    </TableCell>
                    <TableCell className="text-sm">{KIND_LABEL[exam.kind]}</TableCell>
                    <TableCell className="text-sm">{fmtDate(exam.held_on)}</TableCell>
                    <TableCell className="text-right tabular-nums">{exam.total_marks}</TableCell>
                    <TableCell className="text-right tabular-nums">{exam.results_recorded ?? 0}</TableCell>
                    <TableCell>
                      <Badge variant={exam.status === "open" ? "default" : "secondary"}>{exam.status}</Badge>
                    </TableCell>
                    <TableCell className="space-x-2 text-right">
                      <Button size="sm" variant="outline" onClick={() => setSheetExamId(exam.id)}>
                        <PencilLine className="mr-1 h-3.5 w-3.5" /> Marks
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={setStatus.isPending}
                        onClick={() => setStatus.mutate({ id: exam.id, status: exam.status === "open" ? "closed" : "open" })}
                      >
                        {exam.status === "open" ? (
                          <>
                            <Lock className="mr-1 h-3.5 w-3.5" /> Close
                          </>
                        ) : (
                          <>
                            <LockOpen className="mr-1 h-3.5 w-3.5" /> Reopen
                          </>
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <CreateExamDialog open={createOpen} onOpenChange={setCreateOpen} classId={classId} termId={termId} subjects={subjects} />
    </div>
  );
}
