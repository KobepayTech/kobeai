import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorText, apiGet, apiPost } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Banknote, CircleCheck, CircleHelp, Copy, MessageSquare, TriangleAlert } from "lucide-react";

// The reconciliation desk.
//
// The bursar pastes the M-Pesa confirmations off the school phone (or
// photographs them from Teacher Lens). K9 reads them, works out whose fees
// each one is and says WHY. The bursar confirms.
//
// Nothing on this page posts money until Confirm is pressed, and every
// posted payment keeps the reason it was matched, so "why is this parent's
// money on this child's account" always has a recorded answer.

const tsh = (n: number) => `TSh ${Math.round(n).toLocaleString()}`;

type Match = {
  student_id: number;
  student_name: string;
  matched_by: string;
  confidence: number;
  reason: string;
};

type Proposal = {
  receipt: string | null;
  payer_name: string | null;
  payer_phone: string | null;
  amount_tsh: number;
  paid_at: string | null;
  confidence: number;
  raw: string;
  match: Match | null;
  already_posted: boolean;
};

type Batch = {
  id: number;
  status: string;
  parsed: Proposal[];
  model: string | null;
  created_at: string;
  created_count: number;
  updated_count: number;
};

type Account = { student_id: number; name: string; student_code: string | null; balance_tsh: number };

type Family = {
  student_id: number;
  name: string;
  student_code: string | null;
  grade: string | null;
  balance_tsh: number;
  paid_tsh: number;
  posture: string;
  parents: { phone: string; parent_name: string }[];
  draft_sw: string;
  draft_en: string;
};

export default function ReconcilePage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [batch, setBatch] = useState<Batch | null>(null);
  // Per-row overrides: the bursar's decision where it differs from the agent's.
  const [assigned, setAssigned] = useState<Record<number, number | null>>({});
  const [skipped, setSkipped] = useState<Set<number>>(new Set());

  const accounts = useQuery<{ accounts: Account[] }>({
    queryKey: ["fee-accounts"],
    queryFn: () => apiGet("/v1/fees/accounts"),
  });
  const arrears = useQuery<{ families: Family[] }>({
    queryKey: ["fee-arrears"],
    queryFn: () => apiGet("/v1/fees/arrears"),
  });

  const read = useMutation({
    mutationFn: () => apiPost<{ import: Batch }>("/v1/fees/reconcile/text", { text }),
    onSuccess: (res) => {
      setBatch(res.import);
      setAssigned({});
      setSkipped(new Set());
      const matched = res.import.parsed.filter((p) => p.match).length;
      toast({
        title: `${res.import.parsed.length} payment${res.import.parsed.length === 1 ? "" : "s"} read`,
        description: `${matched} matched to a student. Check them before confirming.`,
      });
    },
    onError: (err) =>
      toast({ variant: "destructive", title: "Could not read that", description: apiErrorText(err) }),
  });

  const rows = batch?.parsed ?? [];

  const decisionFor = (i: number): number | null => {
    if (skipped.has(i)) return null;
    if (i in assigned) return assigned[i] ?? null;
    return rows[i]?.match?.student_id ?? null;
  };

  const ready = useMemo(
    () => rows.map((_, i) => decisionFor(i)).filter((id, i) => id != null && !rows[i]!.already_posted).length,
    [rows, assigned, skipped],
  );

  const confirm = useMutation({
    mutationFn: () => {
      const payments = rows
        .map((row, i) => ({ row, i, studentId: decisionFor(i) }))
        .filter(({ row, studentId }) => studentId != null && !row.already_posted)
        .map(({ row, i, studentId }) => ({
          receipt: row.receipt,
          student_id: studentId,
          amount_tsh: row.amount_tsh,
          method: "mpesa",
          payer_name: row.payer_name,
          payer_phone: row.payer_phone,
          paid_at: row.paid_at,
          matched_by: i in assigned || skipped.has(i) ? "manual" : (row.match?.matched_by ?? "manual"),
          confidence: row.match?.confidence ?? null,
          reason:
            i in assigned
              ? "Assigned by the bursar at the reconciliation desk."
              : (row.match?.reason ?? null),
        }));
      return apiPost<{ posted: number; failed: number; results: Array<{ receipt: string | null; ok: boolean; error?: string }> }>(
        `/v1/fees/reconcile/${batch!.id}/confirm`,
        { payments },
      );
    },
    onSuccess: (res) => {
      toast({
        title: `${res.posted} payment${res.posted === 1 ? "" : "s"} posted`,
        description: res.failed > 0 ? `${res.failed} could not be posted — see the rows.` : undefined,
      });
      setBatch(null);
      setText("");
      qc.invalidateQueries({ queryKey: ["fee-accounts"] });
      qc.invalidateQueries({ queryKey: ["fee-arrears"] });
    },
    onError: (err) =>
      toast({ variant: "destructive", title: "Could not post", description: apiErrorText(err) }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Reconcile payments</h1>
        <p className="text-sm text-muted-foreground">
          Paste the M-Pesa confirmations from the school phone. K9 reads them and works out whose
          fees they are — you decide, and only then is anything posted.
        </p>
      </div>

      {!batch && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Banknote className="h-5 w-5" /> Paste the confirmations
            </CardTitle>
            <CardDescription>
              One per line, exactly as they arrived. Nothing is sent off the school LAN, and the
              reading needs no model — M-Pesa text is machine-generated, so it is read exactly.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <textarea
              className="h-56 w-full rounded-md border bg-background p-3 font-mono text-sm"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                "QGH4K2LM9X Confirmed. You have received TSh 120,000.00 from ASHA JUMA MWANGI 255712345678 on 3/2/26 at 10:31 AM\n" +
                "QK7T2M4P1A Confirmed. You have received TSh 60,000.00 from JUMA HAMISI 0754111222 on 3/2/26"
              }
            />
            <Button onClick={() => read.mutate()} disabled={read.isPending || text.trim().length < 12}>
              {read.isPending ? "Reading…" : "Read them"}
            </Button>
            <p className="text-xs text-muted-foreground">
              On a phone, Teacher Lens can photograph the messages instead — same pipeline.
            </p>
          </CardContent>
        </Card>
      )}

      {batch && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Check these before they are posted</CardTitle>
              <CardDescription>
                {rows.length} read{batch.model ? ` by ${batch.model}` : " by the line reader"}. A row
                with no match, or one you disagree with, is yours to assign.
              </CardDescription>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" onClick={() => setBatch(null)}>
                Start over
              </Button>
              <Button onClick={() => confirm.mutate()} disabled={confirm.isPending || ready === 0}>
                {confirm.isPending ? "Posting…" : `Post ${ready}`}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {rows.map((row, i) => {
              const chosen = decisionFor(i);
              const chosenAccount = accounts.data?.accounts.find((a) => a.student_id === chosen);
              return (
                <div
                  key={i}
                  className={`rounded-lg border p-4 ${row.already_posted ? "opacity-60" : ""}`}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-lg font-semibold">{tsh(row.amount_tsh)}</span>
                    {row.receipt && (
                      <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs">
                        {row.receipt}
                      </code>
                    )}
                    {row.payer_name && <span className="text-sm">{row.payer_name}</span>}
                    {row.payer_phone && (
                      <span className="text-sm text-muted-foreground">+{row.payer_phone}</span>
                    )}
                    {row.paid_at && (
                      <span className="text-xs text-muted-foreground">
                        {new Date(row.paid_at).toLocaleDateString()}
                      </span>
                    )}
                    {row.already_posted && <Badge variant="secondary">Already on the ledger</Badge>}
                  </div>

                  {!row.already_posted && (
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      {chosen ? (
                        <Badge className="bg-emerald-500 hover:bg-emerald-500">
                          <CircleCheck className="mr-1 h-3 w-3" />
                          {chosenAccount?.name ?? row.match?.student_name}
                        </Badge>
                      ) : (
                        <Badge variant="outline">
                          <CircleHelp className="mr-1 h-3 w-3" /> Not matched
                        </Badge>
                      )}
                      {row.match && !(i in assigned) && !skipped.has(i) && (
                        <span className="text-xs text-muted-foreground">
                          {row.match.reason} ({row.match.confidence}% sure)
                        </span>
                      )}
                      <select
                        className="ml-auto rounded-md border bg-background px-2 py-1 text-sm"
                        value={chosen ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          const next = new Set(skipped);
                          if (v === "") {
                            next.add(i);
                            setSkipped(next);
                            setAssigned({ ...assigned, [i]: null });
                          } else {
                            next.delete(i);
                            setSkipped(next);
                            setAssigned({ ...assigned, [i]: Number(v) });
                          }
                        }}
                      >
                        <option value="">Leave for later</option>
                        {(accounts.data?.accounts ?? []).map((a) => (
                          <option key={a.student_id} value={a.student_id}>
                            {a.name}
                            {a.student_code ? ` (${a.student_code})` : ""} — owes {tsh(a.balance_tsh)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <p className="mt-2 truncate font-mono text-xs text-muted-foreground">{row.raw}</p>
                </div>
              );
            })}
            {rows.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Nothing readable in that text. Check it is the confirmation messages themselves.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" /> Who to chase
          </CardTitle>
          <CardDescription>
            Families in arrears, worst first, with a message ready to send. The wording is fixed,
            not generated — a school speaking to a parent about money should say the same thing
            every time, and say it whether or not the model box is switched on.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Student</TableHead>
                <TableHead className="text-right">Owes</TableHead>
                <TableHead>Standing</TableHead>
                <TableHead>Parent</TableHead>
                <TableHead className="text-right">Message</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(arrears.data?.families ?? []).map((f) => (
                <TableRow key={f.student_id}>
                  <TableCell>
                    <div className="font-medium">{f.name}</div>
                    <div className="text-xs text-muted-foreground">{f.grade ?? ""}</div>
                  </TableCell>
                  <TableCell className="text-right font-semibold">{tsh(f.balance_tsh)}</TableCell>
                  <TableCell>
                    {f.posture === "part_paid" ? (
                      <Badge variant="secondary">Paying — {tsh(f.paid_tsh)} so far</Badge>
                    ) : (
                      <Badge variant="outline">
                        <TriangleAlert className="mr-1 h-3 w-3" /> Nothing paid
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {f.parents[0]?.phone ? `+${f.parents[0].phone}` : "no phone linked"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        navigator.clipboard
                          .writeText(f.draft_sw)
                          .then(() => toast({ title: "Message copied" }))
                          .catch(() => toast({ variant: "destructive", title: "Copy failed" }));
                      }}
                    >
                      <Copy className="mr-1 h-3 w-3" /> Copy
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(arrears.data?.families.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    Nobody is in arrears.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <Label className="mt-4 block text-xs text-muted-foreground">
            Copy sends nothing on its own. You paste it into WhatsApp or SMS and read it before you
            press send — no message about a family's money leaves this school unsent by a person.
          </Label>
        </CardContent>
      </Card>
    </div>
  );
}
