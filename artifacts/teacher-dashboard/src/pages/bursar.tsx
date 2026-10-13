import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorText, apiGet, apiPost } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import {
  Wallet,
  FileText,
  Smartphone,
  CheckCircle2,
  Clock,
  XCircle,
  Download,
  Send,
  ShieldCheck,
  TriangleAlert,
  GraduationCap,
} from "lucide-react";

// The bursar's desk, on the real fee ledger.
//
// What used to be here was a demo: fabricated balances, a hard-coded billing
// summary, and a "wallet" that was actually the KP rewards balance. It has
// been replaced by /v1/fees/* — append-only transactions, a cached balance
// the server can prove, and reconciliation on its own page.

const tsh = (n: number) => `TSh ${Math.round(n).toLocaleString()}`;

type Account = {
  student_id: number;
  name: string;
  student_code: string | null;
  grade: string | null;
  charged_tsh: number;
  paid_tsh: number;
  waived_tsh: number;
  balance_tsh: number;
  last_transaction_at: string | null;
};

type Summary = {
  students: number;
  students_in_arrears: number;
  charged_tsh: number;
  collected_tsh: number;
  waived_tsh: number;
  outstanding_tsh: number;
  collected_30d_tsh: number;
  collection_rate: number;
};

type Transaction = {
  id: number;
  kind: string;
  delta_tsh: number;
  balance_after_tsh: number;
  method: string | null;
  reference: string | null;
  note: string | null;
  received_at: string;
  created_at: string;
};

type Payment = {
  id: number;
  student_code: string;
  student_name: string;
  plan: string;
  amount_tsh: number;
  phone: string;
  status: "pending" | "success" | "failed";
  mpesa_receipt: string | null;
  failure_reason: string | null;
  initiated_at: string;
  completed_at: string | null;
};

type PaymentsResponse = {
  payments: Payment[];
  summary: { collected_tsh: number };
};

async function downloadReceipt(paymentId: number, receipt: string | null) {
  const token = localStorage.getItem("teacher_token") ?? "";
  const res = await fetch(`/api/v1/bursar/subscription-payments/${paymentId}/receipt.pdf`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `receipt-${receipt ?? paymentId}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function StatusPill({ status }: { status: Payment["status"] }) {
  if (status === "success")
    return (
      <Badge className="bg-emerald-500 hover:bg-emerald-500">
        <CheckCircle2 className="mr-1 h-3 w-3" />
        Success
      </Badge>
    );
  if (status === "pending")
    return (
      <Badge className="bg-amber-500 hover:bg-amber-500">
        <Clock className="mr-1 h-3 w-3" />
        Pending
      </Badge>
    );
  return (
    <Badge variant="destructive">
      <XCircle className="mr-1 h-3 w-3" />
      Failed
    </Badge>
  );
}

export default function Bursar() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const accountsQuery = useQuery<{ accounts: Account[]; summary: Summary }>({
    queryKey: ["fee-accounts"],
    queryFn: () => apiGet("/v1/fees/accounts"),
  });
  const paymentsQuery = useQuery<PaymentsResponse>({
    queryKey: ["bursar-subscription-payments"],
    queryFn: () => apiGet("/v1/bursar/subscription-payments"),
    refetchInterval: 5000, // the bursar wants incoming STK payments live
  });

  const [payOpen, setPayOpen] = useState(false);
  const [selected, setSelected] = useState<Account | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [detail, setDetail] = useState<Account | null>(null);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkAmount, setBulkAmount] = useState("10000");
  const [bulkResult, setBulkResult] = useState<{
    successes: number;
    failures: number;
    results: { student_id: string; ok: boolean; error?: string; phone?: string }[];
  } | null>(null);

  const accounts = accountsQuery.data?.accounts ?? [];
  const summary = accountsQuery.data?.summary;

  const history = useQuery<{ transactions: Transaction[]; parents: { phone: string }[] }>({
    queryKey: ["fee-account", detail?.student_id],
    queryFn: () => apiGet(`/v1/fees/accounts/${detail!.student_id}`),
    enabled: !!detail,
  });

  const recordPayment = useMutation({
    mutationFn: () =>
      apiPost("/v1/fees/payments", {
        student_id: selected!.student_id,
        amount_tsh: Number(amount),
        method,
        reference: reference.trim() || undefined,
      }),
    onSuccess: () => {
      toast({ title: "Payment recorded", description: `${tsh(Number(amount))} for ${selected!.name}.` });
      setPayOpen(false);
      setAmount("");
      setReference("");
      qc.invalidateQueries({ queryKey: ["fee-accounts"] });
    },
    onError: (err) =>
      toast({ variant: "destructive", title: "Not recorded", description: apiErrorText(err) }),
  });

  // The K9 learning subscription is collected by the school with everything
  // else: the bursar receipts the payment, then activates the year from that
  // same receipt. No parent runs a separate app payment for a service their
  // child reaches through the school's own computers.
  const activate = useMutation({
    mutationFn: (studentId: number) =>
      apiPost<{ student: string; expires_at: string }>("/v1/subscriptions/activate", {
        student_id: studentId,
        months: 12,
      }),
    onSuccess: (res) =>
      toast({
        title: "K9 learning subscription activated",
        description: `${res.student} is covered until ${new Date(res.expires_at).toLocaleDateString()}.`,
      }),
    onError: (err) =>
      toast({ variant: "destructive", title: "Could not activate", description: apiErrorText(err) }),
  });

  const verify = useMutation({
    mutationFn: () => apiGet<{ ok: boolean; drift: unknown[] }>("/v1/fees/verify"),
    onSuccess: (res) =>
      toast({
        title: res.ok ? "Ledger checks out" : "Ledger disagrees with itself",
        description: res.ok
          ? "Every cached balance equals the sum of its transactions."
          : `${res.drift.length} account(s) drifted — this should never happen. Tell KobeAI.`,
        variant: res.ok ? undefined : "destructive",
      }),
  });

  const sendBulk = useMutation({
    mutationFn: () =>
      apiPost<typeof bulkResult>("/v1/bursar/invoices/bulk", {
        student_ids: [...bulkSelected],
        amount_tsh: Number(bulkAmount),
      }),
    onSuccess: (body) => {
      setBulkResult(body);
      toast({
        title: `Sent ${body!.successes} STK push${body!.successes === 1 ? "" : "es"}`,
        description: body!.failures > 0 ? `${body!.failures} could not be sent — see below.` : undefined,
      });
      qc.invalidateQueries({ queryKey: ["bursar-subscription-payments"] });
    },
    onError: (err) =>
      toast({ variant: "destructive", title: "Bulk invoicing failed", description: apiErrorText(err) }),
  });

  const arrears = useMemo(() => accounts.filter((a) => a.balance_tsh > 0), [accounts]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Bursar &amp; Fees</h1>
        <p className="mt-1 text-muted-foreground">
          The school's fee ledger. Every figure here is the sum of its transactions.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Stat
          icon={Wallet}
          label="Outstanding"
          value={summary ? tsh(summary.outstanding_tsh) : "—"}
          hint={summary ? `${summary.students_in_arrears} of ${summary.students} students` : ""}
        />
        <Stat
          icon={CheckCircle2}
          label="Collected"
          value={summary ? tsh(summary.collected_tsh) : "—"}
          hint={summary ? `${summary.collection_rate}% of what was charged` : ""}
        />
        <Stat
          icon={Clock}
          label="Last 30 days"
          value={summary ? tsh(summary.collected_30d_tsh) : "—"}
          hint="Payments received"
        />
        <Stat
          icon={FileText}
          label="Charged"
          value={summary ? tsh(summary.charged_tsh) : "—"}
          hint={summary && summary.waived_tsh > 0 ? `${tsh(summary.waived_tsh)} waived` : "Across all terms"}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Student accounts</CardTitle>
            <CardDescription>
              What each student has been charged, has paid, and still owes. Click a row for the
              full history.
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" onClick={() => verify.mutate()} disabled={verify.isPending}>
              <ShieldCheck className="mr-2 h-4 w-4" /> Check the ledger
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setBulkResult(null);
                setBulkSelected(
                  new Set(arrears.map((a) => a.student_code).filter((c): c is string => !!c)),
                );
                setBulkOpen(true);
              }}
            >
              <Send className="mr-2 h-4 w-4" /> Bulk invoice
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>Form</TableHead>
                  <TableHead className="text-right">Charged</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Owes</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accountsQuery.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center">
                      Loading the ledger…
                    </TableCell>
                  </TableRow>
                ) : accounts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      No students yet. Photograph a class list from Staff &amp; Students first.
                    </TableCell>
                  </TableRow>
                ) : (
                  accounts.map((a) => (
                    <TableRow
                      key={a.student_id}
                      className="cursor-pointer"
                      onClick={() => setDetail(a)}
                    >
                      <TableCell>
                        <div className="font-medium">{a.name}</div>
                        <div className="text-xs text-muted-foreground">{a.student_code ?? "—"}</div>
                      </TableCell>
                      <TableCell>{a.grade ?? "—"}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {tsh(a.charged_tsh)}
                      </TableCell>
                      <TableCell className="text-right">{tsh(a.paid_tsh)}</TableCell>
                      <TableCell className="text-right">
                        {a.balance_tsh > 0 ? (
                          <span className="font-semibold text-destructive">{tsh(a.balance_tsh)}</span>
                        ) : a.balance_tsh < 0 ? (
                          <span className="text-emerald-600">{tsh(-a.balance_tsh)} in credit</span>
                        ) : (
                          <span className="text-muted-foreground">Clear</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelected(a);
                              setAmount(a.balance_tsh > 0 ? String(a.balance_tsh) : "");
                              setPayOpen(true);
                            }}
                          >
                            Record payment
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Activate this student's K9 learning subscription for a year"
                            disabled={activate.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              activate.mutate(a.student_id);
                            }}
                          >
                            <GraduationCap className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5" /> M-Pesa subscription collections
          </CardTitle>
          <CardDescription>
            Live from the control plane. These are subscription payments — school fees paid by
            M-Pesa are reconciled on the Reconcile page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Receipt</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paymentsQuery.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : (paymentsQuery.data?.payments.length ?? 0) === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      No collections yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  paymentsQuery.data!.payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="font-medium">{p.student_name}</div>
                        <div className="text-xs text-muted-foreground">{p.student_code}</div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{p.phone}</TableCell>
                      <TableCell className="text-right">{tsh(p.amount_tsh)}</TableCell>
                      <TableCell>
                        <StatusPill status={p.status} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{p.mpesa_receipt ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {p.status === "success" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => downloadReceipt(p.id, p.mpesa_receipt)}
                          >
                            <Download className="mr-1 h-3 w-3" /> Receipt
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Record a payment */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record a payment</DialogTitle>
            <DialogDescription>
              {selected ? `${selected.name} — owes ${tsh(selected.balance_tsh)}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="amount">Amount (TSh)</Label>
              <Input id="amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>How it arrived</Label>
              <div className="flex gap-2">
                {["cash", "mpesa", "bank"].map((m) => (
                  <Button
                    key={m}
                    size="sm"
                    variant={method === m ? "default" : "outline"}
                    onClick={() => setMethod(m)}
                  >
                    {m === "mpesa" ? "M-Pesa" : m === "cash" ? "Cash" : "Bank"}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="reference">Receipt or slip number</Label>
              <Input
                id="reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder={method === "mpesa" ? "QGH4K2LM9X" : "Cash book no."}
              />
              <p className="text-xs text-muted-foreground">
                An M-Pesa receipt can only ever be recorded once — that is what stops the same
                payment being posted twice.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={() => recordPayment.mutate()}
              disabled={recordPayment.isPending || !(Number(amount) > 0)}
            >
              {recordPayment.isPending ? "Recording…" : "Record it"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One account's history */}
      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{detail?.name}</DialogTitle>
            <DialogDescription>
              {detail ? `${detail.student_code ?? ""} · owes ${tsh(detail.balance_tsh)}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-96 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(history.data?.transactions ?? []).map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="text-muted-foreground">
                      {new Date(t.received_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <div className="capitalize">{t.kind}</div>
                      <div className="text-xs text-muted-foreground">
                        {[t.method, t.reference, t.note].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </TableCell>
                    <TableCell
                      className={`text-right ${t.delta_tsh < 0 ? "text-emerald-600" : ""}`}
                    >
                      {t.delta_tsh > 0 ? "+" : "−"}
                      {tsh(Math.abs(t.delta_tsh))}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {tsh(t.balance_after_tsh)}
                    </TableCell>
                  </TableRow>
                ))}
                {(history.data?.transactions.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      Nothing on this account yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk invoice */}
      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Bulk invoice</DialogTitle>
            <DialogDescription>
              Sends an M-Pesa prompt to each family's registered phone. A student with no linked
              parent is skipped and reported — no number is ever guessed at.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="bulk-amount">Amount per family (TSh)</Label>
              <Input
                id="bulk-amount"
                value={bulkAmount}
                onChange={(e) => setBulkAmount(e.target.value)}
              />
            </div>
            <div className="max-h-56 overflow-y-auto rounded-md border p-2">
              {arrears.map((a) => (
                <label key={a.student_id} className="flex items-center gap-2 py-1 text-sm">
                  <Checkbox
                    checked={!!a.student_code && bulkSelected.has(a.student_code)}
                    onCheckedChange={(checked) => {
                      if (!a.student_code) return;
                      const next = new Set(bulkSelected);
                      if (checked) next.add(a.student_code);
                      else next.delete(a.student_code);
                      setBulkSelected(next);
                    }}
                  />
                  <span className="flex-1">{a.name}</span>
                  <span className="text-muted-foreground">{tsh(a.balance_tsh)}</span>
                </label>
              ))}
              {arrears.length === 0 && (
                <p className="p-2 text-sm text-muted-foreground">Nobody is in arrears.</p>
              )}
            </div>
            {bulkResult && (
              <div className="rounded-md border p-3 text-sm">
                <div className="mb-2 font-medium">
                  {bulkResult.successes} sent, {bulkResult.failures} failed
                </div>
                {bulkResult.results
                  .filter((r) => !r.ok)
                  .map((r) => (
                    <div key={r.student_id} className="flex items-center gap-2 text-muted-foreground">
                      <TriangleAlert className="h-3 w-3" />
                      {r.student_id}: {r.error}
                    </div>
                  ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={() => sendBulk.mutate()}
              disabled={sendBulk.isPending || bulkSelected.size === 0 || !(Number(bulkAmount) > 0)}
            >
              {sendBulk.isPending
                ? "Sending…"
                : `Send ${bulkSelected.size} prompt${bulkSelected.size === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 pt-6">
        <div className="rounded-md bg-primary/10 p-3">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0">
          <div className="text-xl font-bold leading-none">{value}</div>
          <div className="text-sm font-medium">{label}</div>
          <div className="truncate text-xs text-muted-foreground">{hint}</div>
        </div>
      </CardContent>
    </Card>
  );
}
