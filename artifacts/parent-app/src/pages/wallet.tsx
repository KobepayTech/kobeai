import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useGetParentWallet, useAddFunds, getGetParentWalletQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Wallet as WalletIcon, Plus, ArrowUpRight, ArrowDownRight } from "lucide-react";

export default function Wallet() {
  const [, setLocation] = useLocation();
  const { token } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!token) setLocation("/login");
  }, [token, setLocation]);

  const { data, isLoading } = useGetParentWallet({
    request: { headers: { Authorization: `Bearer ${token}` } }
  });

  const addFundsMutation = useAddFunds();
  const [selectedChild, setSelectedChild] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleAddFunds = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedChild || !amount) return;

    addFundsMutation.mutate({
      data: { child_id: selectedChild, amount: Number(amount) }
    }, {
      onSuccess: (res) => {
        toast({ title: "Funds added successfully", description: res.message });
        setIsDialogOpen(false);
        setAmount("");
        queryClient.invalidateQueries({ queryKey: getGetParentWalletQueryKey() });
      },
      onError: () => {
        toast({ title: "Failed to add funds", variant: "destructive" });
      }
    });
  };

  if (!token) return null;

  return (
    <Layout>
      <div className="px-6 pt-12 pb-8 bg-primary text-white rounded-b-[40px] shadow-sm relative overflow-hidden">
        <div className="absolute top-0 left-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -translate-y-1/4 -translate-x-1/4"></div>
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-2 text-primary-foreground/80">
            <WalletIcon className="w-5 h-5" />
            <h1 className="text-sm font-medium">Family Balance</h1>
          </div>
          <h2 className="text-4xl font-bold">
            {isLoading ? <div className="h-10 w-48 bg-white/20 rounded animate-pulse"></div> : `TSh ${data?.total_balance.toLocaleString()}`}
          </h2>
        </div>
      </div>

      <div className="px-6 -mt-6 relative z-20 space-y-6">
        {isLoading ? (
          <div className="space-y-4">
            <Card className="p-6 rounded-3xl border-none shadow-sm h-48 bg-gray-100 animate-pulse"></Card>
          </div>
        ) : (
          data?.children?.map((child) => (
            <Card key={child.id} className="p-6 rounded-3xl shadow-sm border-gray-100">
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">{child.name}</h3>
                  <p className="text-sm text-gray-500">Grade {child.grade}</p>
                </div>
                <div className="text-right">
                  <p className="text-xl font-bold text-primary">TSh {child.balance.toLocaleString()}</p>
                  <p className="text-xs text-gray-400">Limit: TSh {child.daily_limit.toLocaleString()}/day</p>
                </div>
              </div>

              <Dialog open={isDialogOpen && selectedChild === child.id} onOpenChange={(open) => {
                setIsDialogOpen(open);
                if (open) setSelectedChild(child.id);
                else setSelectedChild(null);
              }}>
                <DialogTrigger asChild>
                  <Button className="w-full rounded-xl bg-gray-50 text-primary hover:bg-primary/10 border-none shadow-none h-12 font-semibold">
                    <Plus className="w-5 h-5 mr-2" /> Top Up Wallet
                  </Button>
                </DialogTrigger>
                <DialogContent className="rounded-3xl sm:rounded-3xl p-6">
                  <DialogHeader>
                    <DialogTitle className="text-xl font-bold">Add Funds for {child.name}</DialogTitle>
                  </DialogHeader>
                  <form onSubmit={handleAddFunds} className="space-y-6 mt-4">
                    <div className="space-y-2">
                      <Label htmlFor="amount">Amount (TSh)</Label>
                      <Input
                        id="amount"
                        type="number"
                        placeholder="e.g., 5000"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        className="h-12 rounded-xl text-lg"
                        required
                        min="1000"
                      />
                    </div>
                    <Button 
                      type="submit" 
                      className="w-full h-12 rounded-xl text-base shadow-lg shadow-primary/25"
                      disabled={addFundsMutation.isPending}
                    >
                      {addFundsMutation.isPending ? "Processing..." : "Confirm Top Up"}
                    </Button>
                  </form>
                </DialogContent>
              </Dialog>

              {child.transactions && child.transactions.length > 0 && (
                <div className="mt-6 space-y-4">
                  <h4 className="text-sm font-semibold text-gray-900">Recent Transactions</h4>
                  {child.transactions.slice(0, 3).map((tx) => (
                    <div key={tx.id} className="flex justify-between items-center">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${tx.type === 'deposit' ? 'bg-emerald-100 text-emerald-600' : 'bg-rose-100 text-rose-600'}`}>
                          {tx.type === 'deposit' ? <ArrowUpRight className="w-5 h-5" /> : <ArrowDownRight className="w-5 h-5" />}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">{tx.description}</p>
                          <p className="text-xs text-gray-500">{new Date(tx.created_at).toLocaleDateString()}</p>
                        </div>
                      </div>
                      <span className={`text-sm font-bold ${tx.type === 'deposit' ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {tx.type === 'deposit' ? '+' : '-'}TSh {tx.amount.toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ))
        )}
      </div>
    </Layout>
  );
}
