import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Camera,
  CheckCircle2,
  CircleAlert,
  Compass,
  Eye,
  MapPinOff,
  RefreshCw,
  Wrench,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

type PresenceStatus =
  | "on_schedule"
  | "wrong_location"
  | "not_seen"
  | "low_confidence"
  | "no_timetable"
  | "configuration_missing"
  | "insufficient_camera_coverage";

type PresenceResult = {
  id: number;
  checkpoint_id: number;
  student_code: string;
  student_name: string | null;
  class_name: string | null;
  subject: string | null;
  expected_zone_name: string | null;
  expected_zone_type: string | null;
  actual_zone_name: string | null;
  actual_camera_id: string | null;
  actual_seen_at: string | null;
  confidence: string | number | null;
  status: PresenceStatus;
  requires_review: boolean;
  review_status: "open" | "confirmed" | "dismissed";
  reviewed_at: string | null;
  details: Record<string, unknown> | null;
};

type CheckpointSummary = {
  total_students_checked: number;
  on_schedule: number;
  flagged: number;
  not_seen: number;
  camera_coverage_issues?: number;
  active_periods: number;
  note?: string;
};

type Checkpoint = {
  id: number;
  run_at: string;
  school_date: string;
  school_minute: number;
  status: string;
  summary: CheckpointSummary | null;
  completed_at: string | null;
};

type LatestResponse = { checkpoint: Checkpoint | null; results: PresenceResult[] };
type FlagsResponse = { flags: (PresenceResult & { run_at: string; school_date: string })[] };

const STATUS_META: Record<
  PresenceStatus,
  { label: string; badge: "default" | "secondary" | "destructive" | "outline"; icon: typeof Camera; blurb: string }
> = {
  on_schedule: {
    label: "On schedule",
    badge: "default",
    icon: CheckCircle2,
    blurb: "Student seen in the expected zone during the last checkpoint.",
  },
  wrong_location: {
    label: "Wrong location",
    badge: "destructive",
    icon: Compass,
    blurb: "Student was found by the all-campus search in a different zone than the timetable expected.",
  },
  not_seen: {
    label: "Not recently seen",
    badge: "destructive",
    icon: MapPinOff,
    blurb: "Cameras had coverage but the student was not matched anywhere on campus during the lookback window.",
  },
  low_confidence: {
    label: "Needs verification",
    badge: "outline",
    icon: Eye,
    blurb: "A possible match was found but the face-match confidence was below the automatic-decision threshold.",
  },
  no_timetable: {
    label: "No timetable",
    badge: "secondary",
    icon: CircleAlert,
    blurb: "The timetable had no period for the student's class at this checkpoint.",
  },
  configuration_missing: {
    label: "Configuration missing",
    badge: "secondary",
    icon: Wrench,
    blurb: "The face was recognised but the camera or timetable room is not mapped to a campus zone.",
  },
  insufficient_camera_coverage: {
    label: "Camera coverage issue",
    badge: "outline",
    icon: Camera,
    blurb: "The expected zone has no enabled camera, or its cameras have not produced any events in the lookback window. Not a student issue.",
  },
};

const GROUP_ORDER: PresenceStatus[] = [
  "wrong_location",
  "not_seen",
  "low_confidence",
  "configuration_missing",
  "insufficient_camera_coverage",
];

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function metric(label: string, value: number, Icon: typeof Camera, accent = false) {
  return (
    <Card>
      <CardContent className="p-5 flex items-center justify-between gap-4">
        <div>
          <div className={"text-2xl font-bold " + (accent ? "text-destructive" : "")}>{value}</div>
          <div className="text-sm text-muted-foreground">{label}</div>
        </div>
        <Icon className={"h-6 w-6 " + (accent ? "text-destructive" : "text-muted-foreground")} />
      </CardContent>
    </Card>
  );
}

export default function AttendanceExceptions() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"open" | "confirmed" | "dismissed">("open");

  const latest = useQuery({
    queryKey: ["presence-latest"],
    queryFn: () => apiGet<LatestResponse>("/v1/presence/checkpoints/latest"),
    refetchInterval: 60_000,
  });

  const flags = useQuery({
    queryKey: ["presence-flags", tab],
    queryFn: () =>
      apiGet<FlagsResponse>(`/v1/presence/flags?review_status=${tab}&limit=200`),
    refetchInterval: 60_000,
  });

  const runNow = useMutation({
    mutationFn: () => apiPost<LatestResponse>("/v1/presence/checkpoint/run", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["presence-latest"] });
      qc.invalidateQueries({ queryKey: ["presence-flags"] });
      toast({ title: "Checkpoint kicked off", description: "Fresh presence check is running." });
    },
    onError: (err) =>
      toast({
        title: "Checkpoint failed",
        description: err instanceof ApiError ? err.message : "Unknown error",
        variant: "destructive",
      }),
  });

  const review = useMutation({
    mutationFn: (args: { id: number; review_status: "confirmed" | "dismissed" }) =>
      apiPost(`/v1/presence/results/${args.id}/review`, { review_status: args.review_status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["presence-flags"] });
      qc.invalidateQueries({ queryKey: ["presence-latest"] });
    },
    onError: (err) =>
      toast({
        title: "Review failed",
        description: err instanceof ApiError ? err.message : "Unknown error",
        variant: "destructive",
      }),
  });

  const grouped = useMemo(() => {
    const source = flags.data?.flags ?? [];
    const buckets = new Map<PresenceStatus, typeof source>();
    for (const status of GROUP_ORDER) buckets.set(status, []);
    for (const flag of source) {
      const bucket = buckets.get(flag.status);
      if (bucket) bucket.push(flag);
    }
    return buckets;
  }, [flags.data]);

  const summary = latest.data?.checkpoint?.summary ?? null;
  const runAt = latest.data?.checkpoint?.run_at ?? null;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Attendance exceptions</h1>
          <p className="text-muted-foreground mt-1">
            Timetable-driven checkpoints run every 30 minutes. Only the exceptions land here —
            students on schedule are not surfaced.
          </p>
          {runAt && (
            <p className="text-xs text-muted-foreground mt-2">Last checkpoint {fmtDate(runAt)}</p>
          )}
        </div>
        <Button
          onClick={() => runNow.mutate()}
          disabled={runNow.isPending}
          variant="outline"
        >
          <RefreshCw className={"h-4 w-4 mr-2 " + (runNow.isPending ? "animate-spin" : "")} />
          Run checkpoint now
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {metric("Students checked", summary?.total_students_checked ?? 0, CheckCircle2)}
        {metric("On schedule", summary?.on_schedule ?? 0, CheckCircle2)}
        {metric("Flagged for review", summary?.flagged ?? 0, CircleAlert, (summary?.flagged ?? 0) > 0)}
        {metric("Not recently seen", summary?.not_seen ?? 0, MapPinOff, (summary?.not_seen ?? 0) > 0)}
        {metric(
          "Camera coverage issues",
          summary?.camera_coverage_issues ?? 0,
          Camera,
          (summary?.camera_coverage_issues ?? 0) > 0,
        )}
      </div>

      <div className="flex gap-2">
        {(["open", "confirmed", "dismissed"] as const).map((t) => (
          <Button
            key={t}
            variant={tab === t ? "default" : "outline"}
            onClick={() => setTab(t)}
            size="sm"
          >
            {t === "open" ? "Open" : t === "confirmed" ? "Confirmed" : "Dismissed"}
          </Button>
        ))}
      </div>

      {flags.isLoading && <p className="text-sm text-muted-foreground">Loading exceptions…</p>}
      {flags.error && (
        <p className="text-sm text-destructive">
          Failed to load exceptions: {flags.error instanceof Error ? flags.error.message : "unknown"}
        </p>
      )}

      {flags.data && (flags.data.flags.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12 text-muted-foreground">
            No {tab} exceptions. Everything currently accounted for.
          </CardContent>
        </Card>
      ) : (
        GROUP_ORDER.map((status) => {
          const rows = grouped.get(status) ?? [];
          if (rows.length === 0) return null;
          const meta = STATUS_META[status];
          const Icon = meta.icon;
          return (
            <Card key={status}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Icon className="h-5 w-5" />
                      {meta.label}
                      <Badge variant={meta.badge}>{rows.length}</Badge>
                    </CardTitle>
                    <CardDescription>{meta.blurb}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Student</TableHead>
                        <TableHead>Class · Subject</TableHead>
                        <TableHead>Expected</TableHead>
                        <TableHead>Seen</TableHead>
                        <TableHead>Confidence</TableHead>
                        <TableHead>When</TableHead>
                        {tab === "open" && <TableHead className="text-right">Action</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((flag) => (
                        <TableRow key={flag.id}>
                          <TableCell>
                            <div className="font-medium">{flag.student_name ?? flag.student_code}</div>
                            <div className="text-xs text-muted-foreground font-mono">{flag.student_code}</div>
                          </TableCell>
                          <TableCell>
                            <div>{flag.class_name ?? "—"}</div>
                            <div className="text-xs text-muted-foreground">{flag.subject ?? "—"}</div>
                          </TableCell>
                          <TableCell>
                            {flag.expected_zone_name ?? flag.expected_zone_type ?? "—"}
                          </TableCell>
                          <TableCell>
                            {flag.actual_zone_name ? (
                              <div>{flag.actual_zone_name}</div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                            {flag.actual_camera_id && (
                              <div className="text-xs text-muted-foreground font-mono">{flag.actual_camera_id}</div>
                            )}
                          </TableCell>
                          <TableCell>
                            {flag.confidence != null
                              ? `${Math.round(Number(flag.confidence) * 100)}%`
                              : "—"}
                          </TableCell>
                          <TableCell>{fmtTime(flag.actual_seen_at)}</TableCell>
                          {tab === "open" && (
                            <TableCell className="text-right">
                              <div className="flex gap-2 justify-end">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={review.isPending}
                                  onClick={() => review.mutate({ id: flag.id, review_status: "confirmed" })}
                                >
                                  Confirm
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={review.isPending}
                                  onClick={() => review.mutate({ id: flag.id, review_status: "dismissed" })}
                                >
                                  Dismiss
                                </Button>
                              </div>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          );
        })
      ))}
    </div>
  );
}
