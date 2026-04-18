import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { Layout } from "@/components/layout";
import { RenewalBanner } from "@/components/renewal-banner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Smartphone,
  CheckCircle2,
  XCircle,
  Loader2,
  Calendar,
  ShieldCheck,
} from "lucide-react";

type Subscription = {
  child_id: string;
  child_name: string;
  grade: string;
  student_code: string;
  plan: string;
  status: string;
  monthly_price_tsh: number;
  expires_at: string | null;
  parent_phone: string | null;
};

type Payment = {
  id: number;
  status: "pending" | "success" | "failed";
  amount_tsh: number;
  phone: string;
  mpesa_receipt: string | null;
  failure_reason: string | null;
  kp_granted?: number;
};

function statusBadge(status: string) {
  switch (status) {
    case "active":
      return <Badge className="bg-emerald-500 hover:bg-emerald-500">Active</Badge>;
    case "trial":
      return <Badge className="bg-sky-500 hover:bg-sky-500">Trial</Badge>;
    case "grace":
      return <Badge className="bg-amber-500 hover:bg-amber-500">Grace period</Badge>;
    case "expired":
      return <Badge variant="destructive">Expired</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function SubscriptionPage() {
  const [, setLocation] = useLocation();
  const { token } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!token) setLocation("/login");
  }, [token, setLocation]);

  const { data, isLoading } = useQuery({
    queryKey: ["parent-subscriptions"],
    queryFn: () => apiGet<{ subscriptions: Subscription[] }>("/v1/parent/subscriptions"),
    enabled: !!token,
  });

  const [payOpen, setPayOpen] = useState(false);
  const [selected, setSelected] = useState<Subscription | null>(null);
  const [phone, setPhone] = useState("");
  const [paymentId, setPaymentId] = useState<number | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [stage, setStage] = useState<"form" | "stk" | "done">("form");
  const [submitting, setSubmitting] = useState(false);

  function openPay(s: Subscription) {
    setSelected(s);
    setPhone(s.parent_phone ?? "");
    setPayment(null);
    setPaymentId(null);
    setStage("form");
    setPayOpen(true);
  }

  async function startPayment() {
    if (!selected) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/parent/subscriptions/pay", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ child_id: selected.child_id, phone }),
      });
      const body = await res.json();
      if (!res.ok) {
        toast({ title: "Could not start payment", description: body.error ?? "Try again", variant: "destructive" });
        return;
      }
      setPaymentId(body.payment_id);
      setStage("stk");
      toast({ title: "STK push sent", description: body.message });
    } finally {
      setSubmitting(false);
    }
  }

  // Poll payment status while pending
  useEffect(() => {
    if (!paymentId || stage !== "stk") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/v1/parent/subscriptions/payment/${paymentId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
        setPayment(body.payment);
        if (body.payment.status !== "pending") {
          setStage("done");
          if (body.payment.status === "success") {
            toast({ title: "Payment confirmed", description: `Receipt ${body.payment.mpesa_receipt}` });
            // Cache extends in ~60s sync. Force a refresh in a few seconds.
            setTimeout(() => queryClient.invalidateQueries({ queryKey: ["parent-subscriptions"] }), 1500);
          } else {
            toast({ title: "Payment failed", description: body.payment.failure_reason ?? "Unknown error", variant: "destructive" });
          }
        }
      } catch {
        // swallow polling errors
      }
    };
    void tick();
    const id = setInterval(tick, 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [paymentId, stage, token, toast, queryClient]);

  if (!token) return null;

  return (
    <Layout>
      <div className="px-6 pt-12 pb-8 bg-primary text-white rounded-b-[40px] shadow-sm relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -translate-y-1/4 translate-x-1/4"></div>
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-2 text-primary-foreground/80">
            <ShieldCheck className="w-5 h-5" />
            <h1 className="text-sm font-medium">Subscriptions</h1>
          </div>
          <h2 className="text-2xl font-bold">Pay your child's monthly plan</h2>
          <p className="text-sm text-white/80 mt-1">Settle KobeAI access — paid via M-Pesa STK push to the school bursar.</p>
        </div>
      </div>

      <div className="px-6 -mt-6 relative z-20 space-y-4">
        <RenewalBanner />
        {isLoading ? (
          <Card className="p-6 rounded-3xl bg-gray-100 h-32 animate-pulse" />
        ) : (
          data?.subscriptions?.map((s) => (
            <Card key={s.child_id} className="p-6 rounded-3xl shadow-sm border-gray-100">
              <div className="flex justify-between items-start mb-3">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">{s.child_name}</h3>
                  <p className="text-sm text-gray-500">{s.grade} · {s.student_code}</p>
                </div>
                {statusBadge(s.status)}
              </div>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div>
                  <p className="text-xs text-gray-400 uppercase tracking-wide">Plan</p>
                  <p className="text-sm font-semibold capitalize">{s.plan}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 uppercase tracking-wide">Monthly</p>
                  <p className="text-sm font-semibold">TSh {s.monthly_price_tsh.toLocaleString()}</p>
                </div>
                <div className="col-span-2 flex items-center gap-2 text-xs text-gray-500">
                  <Calendar className="w-3.5 h-3.5" />
                  Renews / expires: <span className="font-medium text-gray-700">{fmtDate(s.expires_at)}</span>
                </div>
              </div>
              <Button
                onClick={() => openPay(s)}
                disabled={s.monthly_price_tsh === 0}
                className="w-full h-12 rounded-xl shadow-lg shadow-primary/25"
              >
                <Smartphone className="w-5 h-5 mr-2" />
                {s.monthly_price_tsh === 0 ? "Free trial" : `Pay TSh ${s.monthly_price_tsh.toLocaleString()} via M-Pesa`}
              </Button>
            </Card>
          ))
        )}
      </div>

      <Dialog open={payOpen} onOpenChange={(o) => { setPayOpen(o); if (!o) setStage("form"); }}>
        <DialogContent className="rounded-3xl sm:rounded-3xl p-6 max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {stage === "form" && `Pay for ${selected?.child_name}`}
              {stage === "stk" && "Check your phone"}
              {stage === "done" && payment?.status === "success" && "Payment received"}
              {stage === "done" && payment?.status === "failed" && "Payment failed"}
            </DialogTitle>
          </DialogHeader>

          {stage === "form" && selected && (
            <div className="space-y-4 mt-2">
              <div className="rounded-2xl bg-gray-50 p-4 space-y-1">
                <p className="text-xs text-gray-500">Amount due</p>
                <p className="text-3xl font-bold text-primary">TSh {selected.monthly_price_tsh.toLocaleString()}</p>
                <p className="text-xs text-gray-500 capitalize">{selected.plan} plan · 30 days</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">M-Pesa phone number</Label>
                <Input
                  id="phone"
                  type="tel"
                  placeholder="+255 712 345 678"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="h-12 rounded-xl text-base"
                />
                <p className="text-xs text-gray-500">An STK push will be sent here. Enter your M-Pesa PIN to confirm.</p>
              </div>
              <Button onClick={startPayment} disabled={!phone || submitting} className="w-full h-12 rounded-xl">
                {submitting ? "Sending request..." : "Send STK push"}
              </Button>
            </div>
          )}

          {stage === "stk" && (
            <div className="py-8 text-center space-y-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
              </div>
              <div>
                <p className="font-semibold">STK push sent to {phone}</p>
                <p className="text-sm text-gray-500 mt-1">Open M-Pesa, enter your PIN to confirm payment of TSh {selected?.monthly_price_tsh.toLocaleString()}.</p>
              </div>
              <p className="text-xs text-gray-400">Waiting for confirmation...</p>
            </div>
          )}

          {stage === "done" && payment?.status === "success" && (
            <div className="py-6 text-center space-y-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center">
                <CheckCircle2 className="w-10 h-10 text-emerald-600" />
              </div>
              <div>
                <p className="font-semibold text-lg">TSh {payment.amount_tsh.toLocaleString()} received</p>
                <p className="text-sm text-gray-500 mt-1">Receipt: <span className="font-mono">{payment.mpesa_receipt}</span></p>
                <p className="text-sm text-gray-500">Subscription extended by 30 days.</p>
              </div>
              {payment.kp_granted && payment.kp_granted > 0 && (
                <div
                  className="rounded-2xl p-4 flex items-center gap-3 text-left"
                  style={{ background: "linear-gradient(135deg,#00A86B 0%,#008A57 100%)", color: "white" }}
                  data-testid="kp-bonus-card"
                >
                  <div className="w-12 h-12 rounded-full flex items-center justify-center text-base font-bold shrink-0" style={{ background: "rgba(255,255,255,0.18)" }}>
                    KP
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] uppercase tracking-wide opacity-80">
                      Bonus credited to {selected?.child_name ?? "your child"}
                    </div>
                    <div className="text-xl font-bold leading-tight">+{payment.kp_granted} KP</div>
                    <div className="text-[10px] opacity-90">
                      They'll see this on their watch instantly.
                    </div>
                  </div>
                </div>
              )}
              <Button onClick={() => setPayOpen(false)} className="w-full h-12 rounded-xl">Done</Button>
            </div>
          )}

          {stage === "done" && payment?.status === "failed" && (
            <div className="py-6 text-center space-y-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-rose-100 flex items-center justify-center">
                <XCircle className="w-10 h-10 text-rose-600" />
              </div>
              <div>
                <p className="font-semibold text-lg">Payment did not go through</p>
                <p className="text-sm text-gray-500 mt-1">{payment.failure_reason}</p>
              </div>
              <Button onClick={() => setStage("form")} variant="outline" className="w-full h-12 rounded-xl">Try again</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
