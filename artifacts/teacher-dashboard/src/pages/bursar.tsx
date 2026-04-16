import { useState } from "react";
import { useGetStudentBalances, useGetBillingSummary, useAddDeposit } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Wallet, ArrowUpRight, FileText } from "lucide-react";

export default function Bursar() {
  const { data: balancesData, isLoading: balancesLoading } = useGetStudentBalances();
  const { data: billingData, isLoading: billingLoading } = useGetBillingSummary();
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

      <Card>
        <CardHeader>
          <CardTitle>Student Balances</CardTitle>
          <CardDescription>Manage individual student wallet funds.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total Deposited</TableHead>
                  <TableHead className="text-right">Current Balance</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {balancesLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center">Loading balances...</TableCell>
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
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No student accounts found.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
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
