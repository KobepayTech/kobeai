import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { useAuth, type DeveloperProfile } from "@/lib/auth";

interface PlanDef {
  code: string;
  name: string;
  price_tsh_per_year: number;
  max_apps: number;
  description?: string;
}

interface MeResponse {
  developer: DeveloperProfile;
  plans: Record<string, PlanDef>;
}

interface Payment {
  id: number;
  kind: string;
  plan: string | null;
  amount_tsh: number;
  reference: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  verified_at: string | null;
}

const STATUS_BADGE: Record<string, string> = {
  pending: "badge-amber",
  verified: "badge-green",
  rejected: "badge-red",
};

const TILL_NUMBER = "5096127"; // KobeAI Lipa Namba

export default function BillingPage() {
  const { setDeveloper } = useAuth();
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ["dev-me"],
    queryFn: async () => {
      const res = await apiGet<MeResponse>("/v1/dev/me");
      setDeveloper(res.developer);
      return res;
    },
  });
  const payments = useQuery({
    queryKey: ["dev-payments"],
    queryFn: () => apiGet<{ payments: Payment[] }>("/v1/dev/payments"),
  });

  const [selectedPlan, setSelectedPlan] = useState<string>("indie");
  const [reference, setReference] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const subscribe = useMutation({
    mutationFn: () =>
      apiPost<{ ok: boolean; message: string }>("/v1/dev/subscribe", {
        plan: selectedPlan,
        mpesa_reference: reference.trim(),
      }),
    onSuccess: () => {
      setReference("");
      setErr(null);
      qc.invalidateQueries({ queryKey: ["dev-me"] });
      qc.invalidateQueries({ queryKey: ["dev-payments"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Failed"),
  });

  const dev = me.data?.developer;
  const plans = me.data?.plans ?? {};
  const planList = Object.values(plans).sort((a, b) => a.price_tsh_per_year - b.price_tsh_per_year);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-bold mb-1">Plan & billing</h1>
      <p className="text-sm text-gray-600 mb-6">
        Pick a developer plan, pay via M-Pesa, and we'll activate your account once verified.
      </p>

      {dev && (
        <div className="card mb-6">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="text-xs text-gray-500 uppercase">Current plan</div>
              <div className="text-xl font-bold">
                {dev.plan === "none" ? "Free (no apps)" : (plans[dev.plan]?.name ?? dev.plan)}
              </div>
              <div className="text-sm text-gray-600">
                Status:{" "}
                <span
                  className={`badge ${
                    dev.plan_status === "active"
                      ? "badge-green"
                      : dev.plan_status === "pending_payment"
                        ? "badge-amber"
                        : "badge-gray"
                  }`}
                >
                  {dev.plan_status}
                </span>
                {dev.plan_expires_at && (
                  <span className="ml-2 text-xs">
                    expires {new Date(dev.plan_expires_at).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-500 uppercase">Apps published</div>
              <div className="text-xl font-bold">{dev.total_published_apps}</div>
            </div>
          </div>
        </div>
      )}

      <h2 className="text-lg font-semibold mb-3">Choose a plan</h2>
      <div className="grid gap-4 sm:grid-cols-2 mb-6">
        {planList.map((plan) => {
          const selected = selectedPlan === plan.code;
          return (
            <button
              key={plan.code}
              onClick={() => setSelectedPlan(plan.code)}
              className="card text-left"
              style={{
                borderColor: selected ? "#00A86B" : "#ececec",
                borderWidth: 2,
              }}
            >
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="font-bold text-lg">{plan.name}</h3>
                {selected && <span className="badge badge-green">Selected</span>}
              </div>
              <p className="text-2xl font-bold" style={{ color: "#00A86B" }}>
                TSh {plan.price_tsh_per_year.toLocaleString()}
                <span className="text-sm text-gray-500 font-normal"> / year</span>
              </p>
              <ul className="text-sm text-gray-600 mt-3 space-y-1">
                <li>• Up to {plan.max_apps} published apps</li>
                <li>• 70% revenue share on paid apps</li>
                <li>• KP & TSh payouts via M-Pesa</li>
                {plan.description && <li>• {plan.description}</li>}
              </ul>
            </button>
          );
        })}
      </div>

      <div className="card">
        <h3 className="font-semibold mb-2">Pay via M-Pesa</h3>
        <ol className="text-sm text-gray-700 space-y-1 mb-4 list-decimal list-inside">
          <li>Open M-Pesa → Lipa na M-Pesa → Buy Goods.</li>
          <li>
            Till number: <strong>{TILL_NUMBER}</strong> (KobeAI Developer Plan).
          </li>
          <li>
            Amount: <strong>TSh {(plans[selectedPlan]?.price_tsh_per_year ?? 0).toLocaleString()}</strong>
          </li>
          <li>Enter the M-Pesa transaction reference below.</li>
        </ol>
        <div>
          <label className="label">M-Pesa reference</label>
          <input
            className="input"
            placeholder="e.g. SF12ABCD34"
            value={reference}
            onChange={(e) => setReference(e.target.value.trim().toUpperCase())}
          />
        </div>
        {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
        <button
          onClick={() => subscribe.mutate()}
          className="btn-primary mt-4"
          disabled={reference.length < 6 || subscribe.isPending}
        >
          {subscribe.isPending ? "Submitting…" : "Submit payment for verification"}
        </button>
        {subscribe.isSuccess && (
          <p className="text-sm mt-3" style={{ color: "#00A86B" }}>
            ✓ {subscribe.data.message}
          </p>
        )}
      </div>

      <h2 className="text-lg font-semibold mt-8 mb-3">Payment history</h2>
      <div className="card">
        {payments.isLoading && <p className="text-sm text-gray-500">Loading…</p>}
        {payments.data && payments.data.payments.length === 0 && (
          <p className="text-sm text-gray-500">No payments yet.</p>
        )}
        {payments.data && payments.data.payments.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-500 uppercase">
              <tr>
                <th className="pb-2">Date</th>
                <th>Plan</th>
                <th>Amount</th>
                <th>Reference</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {payments.data.payments.map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="py-2">{new Date(p.created_at).toLocaleDateString()}</td>
                  <td>{p.plan ?? "—"}</td>
                  <td>TSh {p.amount_tsh.toLocaleString()}</td>
                  <td className="font-mono text-xs">{p.reference ?? "—"}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[p.status] || "badge-gray"}`}>
                      {p.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
