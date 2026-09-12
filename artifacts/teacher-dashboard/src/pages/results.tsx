import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trophy } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { tokenRole, useResultsStream, type ClassRow, type ResultEvent, type Term } from "@/lib/results";
import { ScoreboardPanel } from "@/components/results/scoreboard-panel";
import { ExamsPanel } from "@/components/results/exams-panel";
import { SettingsPanel } from "@/components/results/settings-panel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function ResultsPage() {
  const { token } = useAuth();
  const qc = useQueryClient();
  const isAdmin = ["admin", "super_admin"].includes(tokenRole(token) ?? "");

  const classes = useQuery({
    queryKey: ["results", "classes"],
    queryFn: () => apiGet<{ classes: ClassRow[] }>("/v1/teacher/classes"),
  });
  const terms = useQuery({
    queryKey: ["results", "terms"],
    queryFn: () => apiGet<{ terms: Term[] }>("/v1/results/terms"),
  });

  const [classId, setClassId] = useState<number | null>(null);
  const [termId, setTermId] = useState<number | null>(null);
  const [tab, setTab] = useState("scoreboard");
  const [feed, setFeed] = useState<ResultEvent[]>([]);

  const classList = classes.data?.classes ?? [];
  const termList = terms.data?.terms ?? [];

  useEffect(() => {
    if (classId === null && classList[0]) setClassId(classList[0].id);
  }, [classId, classList]);
  useEffect(() => {
    if (termId !== null && termList.some((t) => t.id === termId)) return;
    const preferred = termList.find((t) => t.is_current) ?? termList[0];
    setTermId(preferred ? preferred.id : null);
  }, [termId, termList]);
  useEffect(() => {
    if (terms.isSuccess && termList.length === 0) setTab("settings");
  }, [terms.isSuccess, termList.length]);
  useEffect(() => setFeed([]), [classId]);

  const live = useResultsStream(classId, (event) => {
    if (termId !== null && event.term_id !== termId) return;
    setFeed((prev) => [event, ...prev].slice(0, 6));
    for (const key of ["results-board", "results-exams", "results-sheet"]) qc.invalidateQueries({ queryKey: [key] });
  });

  const ready = classId !== null && termList.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
            <Trophy className="h-7 w-7 text-primary" /> Results
          </h1>
          <p className="mt-1 text-muted-foreground">
            Marks from the glasses and the dashboard fill report cards and the scoreboard as they are recorded.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={live ? "default" : "secondary"} className={live ? "bg-green-600" : ""} data-testid="badge-live">
            {live ? "● Live" : "Connecting…"}
          </Badge>
          <Select value={classId ? String(classId) : ""} onValueChange={(v) => setClassId(Number(v))}>
            <SelectTrigger className="w-44" data-testid="select-class">
              <SelectValue placeholder="Class" />
            </SelectTrigger>
            <SelectContent>
              {classList.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={termId ? String(termId) : ""} onValueChange={(v) => setTermId(Number(v))}>
            <SelectTrigger className="w-48" data-testid="select-term">
              <SelectValue placeholder="Term" />
            </SelectTrigger>
            <SelectContent>
              {termList.map((t) => (
                <SelectItem key={t.id} value={String(t.id)}>
                  {t.name} {t.academic_year}
                  {t.is_current ? " (current)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="scoreboard" data-testid="tab-scoreboard">
            Scoreboard
          </TabsTrigger>
          <TabsTrigger value="exams" data-testid="tab-exams">
            Exams &amp; marks
          </TabsTrigger>
          <TabsTrigger value="settings" data-testid="tab-results-settings">
            Terms &amp; grading
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scoreboard" className="mt-6">
          {classes.isLoading || terms.isLoading ? (
            <Skeleton className="h-96 w-full" />
          ) : !ready ? (
            <NotReady hasClasses={classList.length > 0} />
          ) : (
            <ScoreboardPanel classId={classId} termId={termId} feed={feed} />
          )}
        </TabsContent>
        <TabsContent value="exams" className="mt-6">
          {!ready ? <NotReady hasClasses={classList.length > 0} /> : <ExamsPanel classId={classId} termId={termId} />}
        </TabsContent>
        <TabsContent value="settings" className="mt-6">
          <SettingsPanel terms={termList} isAdmin={isAdmin} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function NotReady({ hasClasses }: { hasClasses: boolean }) {
  return (
    <Card>
      <CardContent className="py-10 text-center text-muted-foreground">
        {hasClasses
          ? "Add the current academic term under Terms & grading to start recording results."
          : "No classes yet — create a class and enroll students first."}
      </CardContent>
    </Card>
  );
}
