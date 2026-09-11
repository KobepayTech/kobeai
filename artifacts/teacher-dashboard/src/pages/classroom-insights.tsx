import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { HelpCircle, Lightbulb, MessagesSquare, MicOff, Sparkles } from "lucide-react";
import { apiGet } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Insight = {
  id: number;
  class_id: number | null;
  class_name: string | null;
  student_code: string | null;
  student_name: string | null;
  subject: string | null;
  period_id: number | null;
  insight_type: "question" | "answer" | "misunderstanding" | "theme";
  text: string;
  attribution_confidence: number | null;
  source_kiosk: string | null;
  captured_at: string;
};

type SummaryRow = {
  class_name: string | null;
  subject: string | null;
  insight_type: string;
  total: number;
  student_attributed: number;
};

const TYPE_META: Record<
  Insight["insight_type"],
  { label: string; badge: "default" | "outline" | "secondary" | "destructive"; icon: typeof HelpCircle }
> = {
  question: { label: "Question", badge: "default", icon: HelpCircle },
  answer: { label: "Answer", badge: "secondary", icon: Sparkles },
  misunderstanding: { label: "Misunderstanding", badge: "destructive", icon: MessagesSquare },
  theme: { label: "Theme", badge: "outline", icon: Lightbulb },
};

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" });
  } catch {
    return iso;
  }
}

export default function ClassroomInsights() {
  const [window, setWindow] = useState<number>(24);

  const list = useQuery({
    queryKey: ["classroom-insights", window],
    queryFn: () =>
      apiGet<{ insights: Insight[] }>(
        `/v1/staff/classroom-insights?since_hours=${window}&limit=200`,
      ),
    refetchInterval: 90_000,
  });

  const summary = useQuery({
    queryKey: ["classroom-insights-summary", window],
    queryFn: () =>
      apiGet<{ rows: SummaryRow[] }>(
        `/v1/staff/classroom-insights/summary?since_hours=${window}`,
      ),
    refetchInterval: 90_000,
  });

  const insights = list.data?.insights ?? [];
  const summaryRows = summary.data?.rows ?? [];

  const grouped = useMemo(() => {
    const buckets = new Map<string, Insight[]>();
    for (const i of insights) {
      const key = `${i.class_name ?? "(unassigned class)"} · ${i.subject ?? "(no subject)"}`;
      const list = buckets.get(key) ?? [];
      list.push(i);
      buckets.set(key, list);
    }
    return Array.from(buckets.entries());
  }, [insights]);

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Classroom insights</h1>
          <p className="text-muted-foreground mt-1">
            Questions and misunderstandings the classroom AI heard during recent lessons.
            These are teaching prompts, not grades or discipline.
          </p>
        </div>
        <div className="flex gap-2">
          {[6, 24, 72, 168].map((h) => (
            <Button
              key={h}
              size="sm"
              variant={window === h ? "default" : "outline"}
              onClick={() => setWindow(h)}
            >
              {h < 24 ? `${h}h` : `${h / 24}d`}
            </Button>
          ))}
        </div>
      </div>

      {list.isLoading && <p className="text-sm text-muted-foreground">Loading insights…</p>}
      {list.error && (
        <p className="text-sm text-destructive">
          Failed to load: {list.error instanceof Error ? list.error.message : "unknown error"}
        </p>
      )}

      {list.data && insights.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground flex flex-col items-center gap-2">
            <MicOff className="w-8 h-8" />
            <p>No classroom mic activity captured in the last {window < 24 ? `${window}h` : `${window / 24}d`}.</p>
            <p className="text-xs">Kiosks post to POST /v1/classroom/insights when a listening window ends.</p>
          </CardContent>
        </Card>
      )}

      {summaryRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Signal by class + subject</CardTitle>
            <CardDescription>What kinds of insights came from where.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Class</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Attributed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summaryRows.map((row, i) => (
                    <TableRow key={i}>
                      <TableCell>{row.class_name ?? "—"}</TableCell>
                      <TableCell>{row.subject ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={TYPE_META[row.insight_type as Insight["insight_type"]]?.badge ?? "outline"}>
                          {TYPE_META[row.insight_type as Insight["insight_type"]]?.label ?? row.insight_type}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">{row.total}</TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        {row.student_attributed}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {grouped.map(([key, items]) => (
        <Card key={key}>
          <CardHeader>
            <CardTitle className="text-lg">{key}</CardTitle>
            <CardDescription>{items.length} insight{items.length === 1 ? "" : "s"}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {items.map((i) => {
                const meta = TYPE_META[i.insight_type];
                const Icon = meta?.icon ?? Lightbulb;
                return (
                  <li key={i.id} className="py-3 flex items-start gap-3">
                    <Icon className="w-4 h-4 mt-1 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">{i.text}</p>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <Badge variant={meta?.badge ?? "outline"}>{meta?.label ?? i.insight_type}</Badge>
                        {i.student_name ? (
                          <span>
                            Attributed to <strong>{i.student_name}</strong>
                            {i.attribution_confidence != null && ` · ${i.attribution_confidence}% confidence`}
                          </span>
                        ) : (
                          <span>Class-level (no reliable speaker attribution)</span>
                        )}
                        <span>· {fmt(i.captured_at)}</span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
