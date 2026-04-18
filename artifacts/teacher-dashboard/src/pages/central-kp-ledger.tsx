import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CheckCircle2, AlertTriangle, Clock } from "lucide-react";

type LedgerEntry = {
  id: number;
  created_at: string;
  delta: number;
  reason: string;
  balance_after: number;
  user_id: number;
  student_code: string | null;
  student_name: string | null;
  tenant_id: number | null;
  school_name: string | null;
};

type Stats = {
  entries_24h: number;
  net_kp_24h: number;
  pending_grants: number;
  conservation: {
    ledger_sum: number;
    balance_sum: number;
    balanced: boolean;
  };
};

function reasonLabel(r: string): string {
  if (r === "membership_grant") return "Membership grant";
  if (r === "question_won") return "Market: correct answer";
  if (r === "lock_purchase") return "Market: lock";
  if (r === "lock_refund") return "Market: lock refund";
  if (r === "admin_adjust") return "Admin adjustment";
  return r;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function CentralKpLedger() {
  const stats = useQuery({
    queryKey: ["/central/v1/admin/kp/stats"],
    queryFn: () => apiGet<Stats>("/central/v1/admin/kp/stats"),
    refetchInterval: 5_000,
  });

  const ledger = useQuery({
    queryKey: ["/central/v1/admin/kp/ledger"],
    queryFn: () =>
      apiGet<{ entries: LedgerEntry[] }>("/central/v1/admin/kp/ledger?limit=100"),
    refetchInterval: 5_000,
  });

  const s = stats.data;
  const entries = ledger.data?.entries ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Global KP Ledger</h1>
        <p className="text-sm text-muted-foreground">
          Append-only audit trail of every KP credit and debit across all
          schools · auto-refreshing every 5s
        </p>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase text-muted-foreground tracking-wide">
              Entries (24h)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="stat-entries-24h">
              {(s?.entries_24h ?? 0).toLocaleString()}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase text-muted-foreground tracking-wide">
              Net KP issued (24h)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${(s?.net_kp_24h ?? 0) >= 0 ? "text-emerald-600" : "text-red-600"}`}
              data-testid="stat-net-24h"
            >
              {(s?.net_kp_24h ?? 0) >= 0 ? "+" : ""}
              {(s?.net_kp_24h ?? 0).toLocaleString()}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase text-muted-foreground tracking-wide">
              Pending grants
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className="text-2xl font-bold flex items-center gap-2"
              data-testid="stat-pending"
            >
              {(s?.pending_grants ?? 0) > 0 ? (
                <Clock className="w-5 h-5 text-amber-500" />
              ) : null}
              {(s?.pending_grants ?? 0).toLocaleString()}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              awaiting student onboarding
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase text-muted-foreground tracking-wide">
              Conservation
            </CardTitle>
          </CardHeader>
          <CardContent>
            {s?.conservation.balanced ? (
              <div
                className="text-base font-semibold text-emerald-600 flex items-center gap-2"
                data-testid="stat-conservation"
              >
                <CheckCircle2 className="w-5 h-5" /> Balanced
              </div>
            ) : (
              <div
                className="text-base font-semibold text-red-600 flex items-center gap-2"
                data-testid="stat-conservation"
              >
                <AlertTriangle className="w-5 h-5" /> Mismatch
              </div>
            )}
            <p className="text-[10px] text-muted-foreground mt-1 font-mono">
              Σ ledger {(s?.conservation.ledger_sum ?? 0).toLocaleString()} = Σ
              balances {(s?.conservation.balance_sum ?? 0).toLocaleString()}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Recent entries</CardTitle>
            <Badge variant="outline" className="text-emerald-600">
              ● Live
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {ledger.isLoading ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              Loading…
            </div>
          ) : entries.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              No KP activity yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>School</TableHead>
                  <TableHead>Student</TableHead>
                  <TableHead>Δ KP</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Balance after</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id} data-testid={`row-ledger-${e.id}`}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {fmtTime(e.created_at)}
                    </TableCell>
                    <TableCell className="font-medium">
                      {e.school_name ?? (
                        <span className="text-muted-foreground italic">
                          unattached
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-xs">
                        {e.student_code ?? "—"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {e.student_name}
                      </div>
                    </TableCell>
                    <TableCell
                      className={`font-bold ${e.delta > 0 ? "text-emerald-600" : "text-red-600"}`}
                    >
                      {e.delta > 0 ? "+" : ""}
                      {e.delta}
                    </TableCell>
                    <TableCell className="text-xs">
                      {reasonLabel(e.reason)}
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {e.balance_after.toLocaleString()}
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
