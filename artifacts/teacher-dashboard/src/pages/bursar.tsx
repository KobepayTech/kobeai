import { useState } from "react";
import { useGetStudentBalances, useGetBillingSummary, useAddDeposit } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Wallet, ArrowUpRight, FileText, Info, Smartphone, CheckCircle2, Clock, XCircle, Download } from "lucide-react";

async function downloadReceipt(paymentId: number, receipt: string | null) {
  const token = localStorage.getItem("teacher_token") ?? "";
  const res = await fetch(`/api/v1/bursar/subscription-payments/${paymentId}/receipt.pdf`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    alert(`Could not download receipt (HTTP ${res.status})`);
    return;
  }
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
  summary: {
    total_count: number;
    success_count: number;
    pending_count: number;
    failed_count: number;
    collected_tsh: number;
  };
};

function StatusPill({ status }: { status: Payment["status"] }) {
  if (status === "success") return <Badge className="bg-emerald-500 hover:bg-emerald-500"><CheckCircle2 className="h-3 w-3 mr-1" />Success</Badge>;
  if (status === "pending") return <Badge className="bg-amber-500 hover:bg-amber-500"><Clock className="h-3 w-3 mr-1" />Pending</Badge>;
  return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Failed</Badge>;
}

export default function Bursar() {
  const { data: balancesData, isLoading: balancesLoading } = useGetStudentBalances();
  const { data: billingData, isLoading: billingLoading } = useGetBillingSummary();
  const { data: paymentsData, isLoading: paymentsLoading } = useQuery<PaymentsResponse>({
    queryKey: ["bursar-subscription-payments"],
    queryFn: async () => {
      const res = await fetch("/api/v1/bursar/subscription-payments");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 5000, // bursar wants to see incoming STK payments live
  });
  const depositMutation = useAddDeposit();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [depositOpen, setDepositOpen] = useState(false);
  const [selectedStudent, setSelectedStudent] = useState<any>(null);
  const [amount, setAmount] = useState("");

  const handleDeposit = () => {
    if (!selectedStudent || !amount || isNaN(Number(amount))) return;

    depositMutation.mutate({
      data: {
        student_id: selectedStudent.student_id,
        amount: Number(amount),
        deposit_method: "cash",
        notes: "School desk deposit"
      }
    }, {
      onSuccess: (res) => {
        toast({
          title: "Deposit Successful",
          description: `Added TZS ${amount} to ${selectedStudent.name}'s wallet.`
        });
        setDepositOpen(false);
        setAmount("");
        queryClient.invalidateQueries({ queryKey: ["/api/v1/bursar/students/balances"] });
      },
      onError: () => {
        toast({
          variant: "destructive",
          title: "Deposit Failed",
          description: "There was an error processing the deposit."
        });
      }
    });
  };

  const openDepositDialog = (student: any) => {
    setSelectedStudent(student);
    setAmount("");
    setDepositOpen(true);
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Bursar & Billing</h1>
        <p className="text-muted-foreground mt-1">Manage student wallets and view school billing.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="bg-primary/5 border-primary/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <Wallet className="h-5 w-5 text-primary" />
              School Wallets Overview
            </CardTitle>
          </CardHeader>
          <CardContent>
            {balancesLoading ? (
              <div className="h-16 animate-pulse bg-muted rounded"></div>
            ) : balancesData?.summary ? (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Total Managed Balance</p>
                  <p className="text-3xl font-bold">TZS {balancesData.summary.total_balance.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Active Accounts</p>
                  <p className="text-3xl font-bold">{balancesData.summary.total_accounts}</p>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <FileText className="h-5 w-5 text-muted-foreground" />
              Current Billing Period
            </CardTitle>
          </CardHeader>
          <CardContent>
            {billingLoading ? (
              <div className="h-16 animate-pulse bg-muted rounded"></div>
            ) : billingData ? (
              <div className="flex justify-between items-end">
                <div>
                  <p className="text-sm text-muted-foreground">{billingData.period}</p>
                  <p className="text-3xl font-bold">TZS {billingData.total_amount.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground mt-1">Includes AI & Quiz usage</p>
                </div>
                <Badge variant="outline">{billingData.status}</Badge>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card className="border-primary/30 bg-primary/[0.02]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5 text-primary" />
            M-Pesa Subscription Collections
          </CardTitle>
          <CardDescription>
            Live feed of parent STK push payments for student subscriptions. Each successful payment renews the child's plan for 30 days.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs text-muted-foreground">Collected</p>
              <p className="text-2xl font-bold text-primary">
                TZS {(paymentsData?.summary?.collected_tsh ?? 0).toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs text-muted-foreground">Successful</p>
              <p className="text-2xl font-bold text-emerald-600">{paymentsData?.summary?.success_count ?? 0}</p>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs text-muted-foreground">Pending</p>
              <p className="text-2xl font-bold text-amber-600">{paymentsData?.summary?.pending_count ?? 0}</p>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs text-muted-foreground">Failed</p>
              <p className="text-2xl font-bold text-rose-600">{paymentsData?.summary?.failed_count ?? 0}</p>
            </div>
          </div>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Receipt</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right">PDF</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paymentsLoading ? (
                  <TableRow><TableCell colSpan={8} className="h-16 text-center text-muted-foreground">Loading...</TableCell></TableRow>
                ) : !paymentsData?.payments?.length ? (
                  <TableRow><TableCell colSpan={8} className="h-16 text-center text-muted-foreground">No subscription payments yet — ask parents to pay from the Parent App.</TableCell></TableRow>
                ) : (
                  paymentsData.payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="font-medium">{p.student_name}</div>
                        <div className="text-xs text-muted-foreground">{p.student_code}</div>
                      </TableCell>
                      <TableCell className="text-sm">{p.phone}</TableCell>
                      <TableCell className="capitalize text-sm">{p.plan}</TableCell>
                      <TableCell className="text-right font-semibold">TZS {p.amount_tsh.toLocaleString()}</TableCell>
                      <TableCell><StatusPill status={p.status} /></TableCell>
                      <TableCell className="font-mono text-xs">
                        {p.mpesa_receipt ?? (p.failure_reason ? <span className="text-rose-600">{p.failure_reason}</span> : "—")}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(p.initiated_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {p.status === "success" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void downloadReceipt(p.id, p.mpesa_receipt)}
                            data-testid={`button-receipt-${p.id}`}
                          >
                            <Download className="h-3 w-3 mr-1" />
                            Receipt
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

      <Card>
        <CardHeader>
          <CardTitle>Student Balances</CardTitle>
          <CardDescription>Manage individual student wallet funds and KobeAI usage.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <TooltipProvider delayDuration={150}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Student</TableHead>
                    <TableHead>Grade</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total Deposited</TableHead>
                    <TableHead className="text-right">KobeAI Spend</TableHead>
                    <TableHead className="text-right">Current Balance</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {balancesLoading ? (
                    <TableRow>
                      <TableCell colSpan={7} className="h-24 text-center">Loading balances...</TableCell>
                    </TableRow>
                  ) : balancesData?.students?.length ? (
                    balancesData.students.map((student) => (
                      <TableRow key={student.id}>
                        <TableCell>
                          <div className="font-medium">{student.name}</div>
                          <div className="text-xs text-muted-foreground">{student.student_id}</div>
                        </TableCell>
                        <TableCell>Grade {student.grade}</TableCell>
                        <TableCell>
                          <Badge variant={student.balance < 1000 ? "destructive" : "secondary"}>
                            {student.balance < 1000 ? "Low Balance" : student.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          TZS {student.total_deposited.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary cursor-help"
                              >
                                TZS {student.total_spent.toLocaleString()}
                                <Info className="h-3 w-3 text-muted-foreground" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="left" className="text-xs">
                              <div className="space-y-1">
                                <div className="flex justify-between gap-4">
                                  <span className="text-muted-foreground">AI questions ({student.questions_count})</span>
                                  <span className="font-medium">TZS {student.ai_questions_spend.toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between gap-4">
                                  <span className="text-muted-foreground">Quizzes ({student.quizzes_count})</span>
                                  <span className="font-medium">TZS {student.quiz_spend.toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between gap-4 border-t pt-1">
                                  <span>Total</span>
                                  <span className="font-semibold">TZS {student.total_spent.toLocaleString()}</span>
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell className="text-right font-bold text-primary">
                          TZS {student.balance.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="outline" onClick={() => openDepositDialog(student)}>
                            <ArrowUpRight className="h-4 w-4 mr-1" />
                            Deposit
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No student accounts found.</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TooltipProvider>
          </div>
        </CardContent>
      </Card>

      <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Funds</DialogTitle>
            <DialogDescription>
              Deposit cash into {selectedStudent?.name}'s wallet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Current Balance</Label>
              <div className="text-2xl font-bold text-muted-foreground">
                TZS {selectedStudent?.balance.toLocaleString()}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="amount">Deposit Amount (TZS)</Label>
              <Input
                id="amount"
                type="number"
                placeholder="5000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDepositOpen(false)}>Cancel</Button>
            <Button onClick={handleDeposit} disabled={!amount || isNaN(Number(amount)) || depositMutation.isPending}>
              {depositMutation.isPending ? "Processing..." : "Confirm Deposit"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
