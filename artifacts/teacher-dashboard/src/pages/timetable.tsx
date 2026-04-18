import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, CalendarClock } from "lucide-react";

type ClassRow = { id: number; name: string };
type Period = {
  id: number;
  class_id: number;
  day_of_week: number;
  start_minute: number;
  end_minute: number;
  subject: string;
  room: string | null;
  teacher_name: string | null;
};

const DAYS = [
  { num: 1, label: "Mon" },
  { num: 2, label: "Tue" },
  { num: 3, label: "Wed" },
  { num: 4, label: "Thu" },
  { num: 5, label: "Fri" },
  { num: 6, label: "Sat" },
  { num: 7, label: "Sun" },
];

function authHeader(): HeadersInit {
  const token = localStorage.getItem("teacher_token") ?? "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}
function fmtMinute(min: number): string {
  const h = Math.floor(min / 60).toString().padStart(2, "0");
  const m = (min % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}
function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

async function fetchClasses(): Promise<ClassRow[]> {
  const res = await fetch("/api/v1/teacher/classes", { headers: authHeader() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).classes ?? [];
}

async function fetchPeriods(classId: number | "all"): Promise<Period[]> {
  const url = classId === "all"
    ? "/api/v1/teacher/timetable"
    : `/api/v1/teacher/timetable?class_id=${classId}`;
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).periods ?? [];
}

export default function TimetablePage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [classFilter, setClassFilter] = useState<number | "all">("all");
  const [open, setOpen] = useState(false);

  // Form state for new period.
  const [draftClassId, setDraftClassId] = useState<number | null>(null);
  const [draftDay, setDraftDay] = useState<number>(1);
  const [draftStart, setDraftStart] = useState("08:00");
  const [draftEnd, setDraftEnd] = useState("08:40");
  const [draftSubject, setDraftSubject] = useState("");
  const [draftRoom, setDraftRoom] = useState("");
  const [draftTeacher, setDraftTeacher] = useState("");

  const classesQ = useQuery({ queryKey: ["classes"], queryFn: fetchClasses });
  const periodsQ = useQuery({
    queryKey: ["timetable", classFilter],
    queryFn: () => fetchPeriods(classFilter),
  });

  const createMut = useMutation({
    mutationFn: async (payload: Omit<Period, "id">) => {
      const res = await fetch("/api/v1/teacher/timetable", {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      return await res.json();
    },
    onSuccess: () => {
      toast({ title: "Period added" });
      qc.invalidateQueries({ queryKey: ["timetable"] });
      setOpen(false);
      setDraftSubject("");
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/v1/teacher/timetable/${id}`, { method: "DELETE", headers: authHeader() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      toast({ title: "Period deleted" });
      qc.invalidateQueries({ queryKey: ["timetable"] });
    },
  });

  const grouped = useMemo(() => {
    const map = new Map<number, Period[]>();
    for (const day of DAYS) map.set(day.num, []);
    for (const p of periodsQ.data ?? []) {
      const arr = map.get(p.day_of_week);
      if (arr) arr.push(p);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.start_minute - b.start_minute);
    return map;
  }, [periodsQ.data]);

  const classNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of classesQ.data ?? []) m.set(c.id, c.name);
    return m;
  }, [classesQ.data]);

  function submit() {
    if (!draftClassId) {
      toast({ title: "Pick a class", variant: "destructive" });
      return;
    }
    const start = parseHHMM(draftStart);
    const end = parseHHMM(draftEnd);
    if (start == null || end == null || end <= start) {
      toast({ title: "Invalid time range", description: "Use HH:MM, end > start", variant: "destructive" });
      return;
    }
    if (!draftSubject.trim()) {
      toast({ title: "Subject required", variant: "destructive" });
      return;
    }
    createMut.mutate({
      class_id: draftClassId,
      day_of_week: draftDay,
      start_minute: start,
      end_minute: end,
      subject: draftSubject.trim(),
      room: draftRoom.trim() || null,
      teacher_name: draftTeacher.trim() || null,
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <CalendarClock className="h-6 w-6 text-primary" />
            School Timetable
          </h1>
          <p className="text-sm text-muted-foreground">
            Add weekly periods per class. Student watches will buzz when the subject changes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(classFilter)} onValueChange={(v) => setClassFilter(v === "all" ? "all" : Number(v))}>
            <SelectTrigger className="w-48" data-testid="select-class-filter">
              <SelectValue placeholder="Filter class" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All classes</SelectItem>
              {(classesQ.data ?? []).map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-add-period"><Plus className="h-4 w-4 mr-2" />Add period</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add timetable period</DialogTitle>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <Label>Class</Label>
                  <Select value={draftClassId ? String(draftClassId) : ""} onValueChange={(v) => setDraftClassId(Number(v))}>
                    <SelectTrigger data-testid="select-period-class"><SelectValue placeholder="Select class" /></SelectTrigger>
                    <SelectContent>
                      {(classesQ.data ?? []).map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Day</Label>
                  <Select value={String(draftDay)} onValueChange={(v) => setDraftDay(Number(v))}>
                    <SelectTrigger data-testid="select-period-day"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {DAYS.map((d) => <SelectItem key={d.num} value={String(d.num)}>{d.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Subject</Label>
                  <Input data-testid="input-period-subject" value={draftSubject} onChange={(e) => setDraftSubject(e.target.value)} placeholder="Mathematics" />
                </div>
                <div>
                  <Label>Start (HH:MM)</Label>
                  <Input data-testid="input-period-start" value={draftStart} onChange={(e) => setDraftStart(e.target.value)} />
                </div>
                <div>
                  <Label>End (HH:MM)</Label>
                  <Input data-testid="input-period-end" value={draftEnd} onChange={(e) => setDraftEnd(e.target.value)} />
                </div>
                <div>
                  <Label>Room (optional)</Label>
                  <Input value={draftRoom} onChange={(e) => setDraftRoom(e.target.value)} placeholder="Room 12" />
                </div>
                <div>
                  <Label>Teacher (optional)</Label>
                  <Input value={draftTeacher} onChange={(e) => setDraftTeacher(e.target.value)} placeholder="Mr. Mwangi" />
                </div>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={submit} disabled={createMut.isPending} data-testid="button-submit-period">
                  {createMut.isPending ? "Saving..." : "Save period"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {periodsQ.isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-7 gap-3">
          {DAYS.map((day) => {
            const periods = grouped.get(day.num) ?? [];
            return (
              <Card key={day.num} className="min-h-[200px]" data-testid={`card-day-${day.num}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-bold text-primary uppercase tracking-wider">{day.label}</CardTitle>
                  <CardDescription className="text-xs">{periods.length} period{periods.length === 1 ? "" : "s"}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {periods.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">No periods</p>
                  ) : (
                    periods.map((p) => (
                      <div key={p.id} className="rounded-md border p-2 text-xs space-y-1 group relative" data-testid={`row-period-${p.id}`}>
                        <div className="font-semibold text-sm text-foreground">{p.subject}</div>
                        <div className="text-muted-foreground">
                          {fmtMinute(p.start_minute)}–{fmtMinute(p.end_minute)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {classFilter === "all" && (classNameById.get(p.class_id) ?? `Class ${p.class_id}`)}
                          {p.room && ` · ${p.room}`}
                          {p.teacher_name && ` · ${p.teacher_name}`}
                        </div>
                        <button
                          onClick={() => deleteMut.mutate(p.id)}
                          className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 text-destructive hover:bg-destructive/10 rounded p-1"
                          aria-label="Delete period"
                          data-testid={`button-delete-period-${p.id}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
