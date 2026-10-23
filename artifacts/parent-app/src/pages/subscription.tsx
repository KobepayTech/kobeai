import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "@/lib/api";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
type Subscription = {
  child_id: string;
  child_name: string;
  grade: string;
  status: string;
  expires_at: string | null;
};
type Quote = {
  amount_tsh: number;
  months: number;
  plan: string;
  available: boolean;
};
type Payment = {
  id: number;
  status: string;
  provider_status: string;
  receipt: string | null;
  failure_reason: string | null;
  amount_tsh: number;
  subscription_activated: boolean;
};
export default function SubscriptionPage() {
  const { token } = useAuth();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Subscription | null>(null),
    [quote, setQuote] = useState<Quote | null>(null);
  const [phone, setPhone] = useState(""),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [key, setKey] = useState("");
  const [paymentId, setPaymentId] = useState<number | null>(() => {
    const n = Number(sessionStorage.getItem("k9_subscription_payment"));
    return n > 0 ? n : null;
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const subscriptions = useQuery({
    queryKey: ["parent-subscriptions"],
    queryFn: () =>
      apiGet<{ subscriptions: Subscription[] }>("/v1/parent/subscriptions"),
    enabled: !!token,
    refetchInterval: 15000,
  });
  const payment = useQuery({
    queryKey: ["palmpesa-payment", paymentId],
    queryFn: () =>
      apiGet<{ payment: Payment }>(
        `/v1/parent/subscriptions/payment/${paymentId}`,
      ),
    enabled: !!token && !!paymentId,
    refetchInterval: (q) =>
      q.state.data?.payment.status === "success" ? false : 5000,
  });
  async function choose(s: Subscription) {
    setError("");
    setBusy(true);
    setQuote(null);
    setSelected(s);
    setKey(crypto.randomUUID());
    try {
      setQuote(
        await apiGet<Quote>(`/v1/parent/subscriptions/quote/${s.child_id}`),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load price");
    } finally {
      setBusy(false);
    }
  }
  async function pay() {
    if (!selected || !quote) return;
    setBusy(true);
    setError("");
    try {
      const result = await apiPost<{ payment_id: number }>(
        "/v1/parent/subscriptions/pay",
        {
          child_id: selected.child_id,
          phone,
          name,
          email,
          idempotency_key: key,
          accepted_amount_tsh: quote.amount_tsh,
          accepted_months: quote.months,
        },
      );
      setPaymentId(result.payment_id);
      sessionStorage.setItem(
        "k9_subscription_payment",
        String(result.payment_id),
      );
      setSelected(null);
      setQuote(null);
      await qc.invalidateQueries({ queryKey: ["parent-subscriptions"] });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Payment request failed. Retry uses the same request.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!token)
    return (
      <Layout>
        <div className="p-6">
          <Link href="/login">Sign in to pay for your child</Link>
        </div>
      </Layout>
    );
  const p = payment.data?.payment;
  return (
    <Layout>
      <header className="bg-primary text-white p-6 pt-12 rounded-b-3xl">
        <h1 className="text-2xl font-bold">Student subscriptions</h1>
        <p className="mt-2">Pay securely through PalmPesa mobile money.</p>
        <p className="text-sm mt-2">
          Subscription access and printed learning packs are charged separately.
        </p>
      </header>
      <div className="p-5 space-y-4">
        {(error || subscriptions.error) && (
          <p role="alert" className="text-red-700">
            {error || "Subscriptions could not be loaded. Try again."}
          </p>
        )}
        {subscriptions.isLoading && <p>Loading your children…</p>}
        {subscriptions.data?.subscriptions.length === 0 && (
          <p>No linked students. Add your child before making a payment.</p>
        )}
        {subscriptions.data?.subscriptions.map((s) => (
          <Card className="p-5 space-y-3" key={s.child_id}>
            <h2 className="font-bold text-lg">{s.child_name}</h2>
            <p>
              {s.grade} · {s.status}
            </p>
            <p className="text-sm">
              Access until:{" "}
              {s.expires_at
                ? new Date(s.expires_at).toLocaleDateString()
                : "Not activated"}
            </p>
            <Button disabled={busy} onClick={() => choose(s)}>
              View price & renew
            </Button>
          </Card>
        ))}
        {selected && (
          <Card className="p-5 space-y-4">
            <h2 className="font-bold">Renew {selected.child_name}</h2>
            {quote ? (
              <>
                <p className="text-2xl font-bold">
                  TZS {quote.amount_tsh.toLocaleString()}
                </p>
                <p>
                  {quote.months} months of K9 access. Unused paid time is
                  preserved when renewing.
                </p>
                {!quote.available && (
                  <p>
                    Payments are not enabled by the school yet. Ask the school
                    office.
                  </p>
                )}
                <Label htmlFor="payer-name">Your name</Label>
                <Input
                  id="payer-name"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <Label htmlFor="payer-phone">Mobile-money number</Label>
                <Input
                  id="payer-phone"
                  type="tel"
                  autoComplete="tel"
                  placeholder="07… or +255…"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
                <Label htmlFor="payer-email">Email required by PalmPesa</Label>
                <Input
                  id="payer-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <p className="text-sm">
                  Approve the payment on your own phone. Never enter your
                  mobile-money PIN in K9.
                </p>
                <Button
                  className="w-full"
                  disabled={
                    busy || !quote.available || !phone || !name || !email
                  }
                  onClick={pay}
                >
                  {busy
                    ? "Saving request…"
                    : `Pay TZS ${quote.amount_tsh.toLocaleString()}`}
                </Button>
              </>
            ) : (
              <p>Loading the current subscription price…</p>
            )}
            <Button variant="outline" onClick={() => setSelected(null)}>
              Close
            </Button>
          </Card>
        )}
        {paymentId && (
          <Card className="p-5 space-y-3" role="status">
            <h2 className="font-bold">Payment #{paymentId}</h2>
            {payment.error ? (
              <p>
                Cannot check payment right now. Do not pay again while this
                request is unresolved.
              </p>
            ) : p ? (
              <>
                <p>
                  {p.status === "success"
                    ? "Payment confirmed — subscription activated"
                    : p.status === "failed"
                      ? `Payment status: ${p.provider_status}`
                      : "Awaiting payment confirmation"}
                </p>
                <p>TZS {p.amount_tsh.toLocaleString()}</p>
                {p.receipt && <p>Receipt: {p.receipt}</p>}
                {p.status === "pending" && (
                  <p className="text-sm">
                    A saved request is not a successful payment. Check your
                    phone for the prompt. If the network is uncertain, keep this
                    request rather than paying again.
                  </p>
                )}
                {p.provider_status === "EXPIRED" && (
                  <p className="text-sm">
                    A delayed payment can still arrive. If money left your
                    wallet, ask the school to reconcile before starting another
                    payment.
                  </p>
                )}
                {p.failure_reason && <p>{p.failure_reason}</p>}
                <Button variant="outline" onClick={() => payment.refetch()}>
                  Refresh status
                </Button>
                {p.status !== "pending" && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      sessionStorage.removeItem("k9_subscription_payment");
                      setPaymentId(null);
                    }}
                  >
                    Dismiss
                  </Button>
                )}
              </>
            ) : (
              <p>Checking payment…</p>
            )}
          </Card>
        )}
        <Link href="/school-services" className="block underline">
          Printing allowances & learning-pack history
        </Link>
      </div>
    </Layout>
  );
}
