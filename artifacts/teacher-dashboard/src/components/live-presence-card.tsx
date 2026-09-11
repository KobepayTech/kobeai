import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { MapPinOff, ArrowRight } from "lucide-react";
import { apiGet } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

type Mismatch = {
  student_code: string;
  student_name: string | null;
  zone_name: string | null;
  zone_type: string | null;
  expected_zone_name: string | null;
  expected_zone_type: string | null;
  mismatch_status: string;
  seen_at: string;
};

type Response = { mismatches: Mismatch[]; since_minutes: number };

function timeAgo(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  } catch {
    return "";
  }
}

/**
 * Live-presence tile for the teacher Overview page. Consumes the fast-path
 * /v1/presence/live/mismatches endpoint — sub-second when a camera event
 * flips a student out of their expected zone.
 */
export function LivePresenceCard() {
  const { data, isLoading } = useQuery({
    queryKey: ["presence-live-mismatches"],
    queryFn: () => apiGet<Response>("/v1/presence/live/mismatches?since_minutes=15"),
    refetchInterval: 20_000,
  });

  if (isLoading || !data) return null;
  if (data.mismatches.length === 0) return null;

  const shown = data.mismatches.slice(0, 5);
  const rest = data.mismatches.length - shown.length;

  return (
    <Card className="border-l-4 border-l-destructive">
      <CardContent className="p-5">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <MapPinOff className="w-5 h-5 text-destructive" />
            <div>
              <p className="text-sm font-semibold">Live location alerts</p>
              <p className="text-xs text-muted-foreground">
                Students seen somewhere other than their timetable expected — last 15 min.
              </p>
            </div>
          </div>
          <Link href="/attendance-exceptions">
            <button className="text-xs text-primary flex items-center gap-1 hover:underline">
              View all <ArrowRight className="w-3 h-3" />
            </button>
          </Link>
        </div>
        <ul className="divide-y divide-border">
          {shown.map((m) => (
            <li key={m.student_code} className="py-2 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {m.student_name ?? m.student_code}
                </p>
                <p className="text-xs text-muted-foreground">
                  seen in{" "}
                  <span className="font-medium">{m.zone_name ?? m.zone_type ?? "unknown zone"}</span>
                  {" · expected "}
                  <span className="font-medium">
                    {m.expected_zone_name ?? m.expected_zone_type ?? "unknown"}
                  </span>
                </p>
              </div>
              <Badge variant="outline">{timeAgo(m.seen_at)}</Badge>
            </li>
          ))}
        </ul>
        {rest > 0 && (
          <p className="text-xs text-muted-foreground mt-2">+ {rest} more</p>
        )}
      </CardContent>
    </Card>
  );
}
