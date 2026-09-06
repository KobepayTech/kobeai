import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cake, CheckCircle2, Sparkles, XCircle } from "lucide-react";
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
import { useToast } from "@/hooks/use-toast";

type CelebrationStatus = "pending" | "approved" | "dismissed" | "played";
type Celebration = {
  id: number;
  student_code: string;
  student_name: string | null;
  birthday: string;
  celebration_date: string;
  status: CelebrationStatus;
  approved_at: string | null;
  played_at: string | null;
  played_by_kiosk: string | null;
};

type Response = { celebrations: Celebration[] };

function statusBadge(status: CelebrationStatus) {
  switch (status) {
    case "pending":
      return { label: "Awaiting your approval", variant: "outline" as const };
    case "approved":
      return { label: "Queued for classroom TV", variant: "default" as const };
    case "played":
      return { label: "Shown on TV", variant: "secondary" as const };
    case "dismissed":
      return { label: "Skipped", variant: "secondary" as const };
  }
}

export function BirthdayCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["birthdays-today"],
    queryFn: () => apiGet<Response>("/v1/staff/learning-profile/birthdays/today"),
    refetchInterval: 5 * 60_000,
  });

  const approve = useMutation({
    mutationFn: (studentCode: string) =>
      apiPost(`/v1/staff/learning-profile/birthdays/${studentCode}/approve`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["birthdays-today"] }),
    onError: (err) =>
      toast({
        title: "Couldn't approve celebration",
        description: err instanceof ApiError ? err.message : "Unknown error",
        variant: "destructive",
      }),
  });

  const dismiss = useMutation({
    mutationFn: (studentCode: string) =>
      apiPost(`/v1/staff/learning-profile/birthdays/${studentCode}/dismiss`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["birthdays-today"] }),
    onError: (err) =>
      toast({
        title: "Couldn't dismiss celebration",
        description: err instanceof ApiError ? err.message : "Unknown error",
        variant: "destructive",
      }),
  });

  if (isLoading) return null;
  if (!data || data.celebrations.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="bg-pink-100 text-pink-600 w-10 h-10 rounded-full flex items-center justify-center">
            <Cake className="w-5 h-5" />
          </div>
          <div>
            <CardTitle>Birthdays today</CardTitle>
            <CardDescription>
              Approve to queue a classroom-TV celebration, or skip if the student prefers privacy.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {data.celebrations.map((c) => {
            const badge = statusBadge(c.status);
            const disabled = approve.isPending || dismiss.isPending;
            return (
              <li key={c.id} className="py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">{c.student_name ?? c.student_code}</p>
                  <p className="text-xs text-muted-foreground font-mono">{c.student_code}</p>
                </div>
                <Badge variant={badge.variant}>{badge.label}</Badge>
                {c.status === "pending" && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={disabled}
                      onClick={() => approve.mutate(c.student_code)}
                    >
                      <Sparkles className="w-4 h-4 mr-1" />
                      Celebrate
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => dismiss.mutate(c.student_code)}
                    >
                      <XCircle className="w-4 h-4 mr-1" />
                      Skip
                    </Button>
                  </div>
                )}
                {c.status === "played" && (
                  <span className="text-xs text-emerald-600 flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Shown
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
