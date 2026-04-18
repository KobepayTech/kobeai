import { FormEvent, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { apiGet, apiPost } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface LedgerEntry {
  id: number;
  delta_tsh: number;
  balance_after: number;
  reason: string;
  created_at: string;
}

export default function Wallet() {
  const { advertiser, refresh } = useAuth();
  const qc = useQueryClient();
  const [amount, setAmount] = useState(50000);
  const [err, setErr] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["ledger"],
    queryFn: () => apiGet<{ ledger: LedgerEntry[] }>("/v1/advertiser/ledger"),
  });

  const topup = useMutation({
    mutationFn: (n: number) => apiPost("/v1/advertiser/topup", { amount_tsh: n }),
    onSuccess: async () => {
      await refresh();
      qc.invalidateQueries({ queryKey: ["ledger"] });
      setErr(null);
    },
    onError: (e: Error) => setErr(e.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    topup.mutate(amount);
  }

  return (
    <Layout>
      <h1 className="text-2xl font-bold text-navy mb-1">Wallet</h1>
      <p className="text-sm text-muted mb-6">Top up your balance to keep campaigns running.</p>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="card">
          <div className="text-xs uppercase font-semibold text-muted">Current balance</div>
          <div className="text-4xl font-black text-brand mt-1 mb-4">
            TSh {(advertiser?.balance_tsh ?? 0).toLocaleString()}
          </div>

          <form onSubmit={onSubmit} className="space-y-3">
            <div>
              <label className="label">Top up amount (TSh)</label>
              <input
                className="input"
                type="number"
                min={1000}
                step={1000}
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
            </div>
            <div className="flex gap-2">
              {[10000, 50000, 100000, 500000].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setAmount(v)}
                  className="btn btn-secondary text-xs flex-1"
                >
                  {v.toLocaleString()}
                </button>
              ))}
            </div>
            {err && <div className="text-sm text-red-600">{err}</div>}
            <button className="btn btn-primary w-full" disabled={topup.isPending}>
              {topup.isPending ? "Processing…" : `Top up TSh ${amount.toLocaleString()}`}
            </button>
            <p className="text-xs text-muted">
              Demo top-up — no real payment. Production will accept M-Pesa Push.
            </p>
          </form>
        </div>

        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-default font-bold text-navy">Recent activity</div>
          {!data || data.ledger.length === 0 ? (
            <div className="p-8 text-center text-muted text-sm">No transactions yet.</div>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {data.ledger.map((l) => (
                  <tr key={l.id} className="border-t border-default">
                    <td className="px-4 py-2.5">
                      <div className="text-navy text-sm">{l.reason}</div>
                      <div className="text-xs text-muted">{new Date(l.created_at).toLocaleString()}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className={`font-semibold ${l.delta_tsh >= 0 ? "text-brand" : "text-red-600"}`}>
                        {l.delta_tsh >= 0 ? "+" : ""}
                        {l.delta_tsh.toLocaleString()}
                      </div>
                      <div className="text-xs text-muted">bal {l.balance_after.toLocaleString()}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  );
}
