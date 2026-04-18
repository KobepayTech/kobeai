import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";

interface EarningsRes {
  summary: {
    total_earnings_tsh: number;
    total_earnings_kp: number;
    unpaid_balance_tsh: number;
    unpaid_balance_kp: number;
    total_installs: number;
  };
  per_app: Array<{
    app_id: number;
    name?: string;
    installs: number;
    total_kp: number;
    total_tsh: number;
  }>;
  recent_purchases: Array<{
    id: number;
    app_id: number;
    price_kp: number;
    price_tsh: number;
    dev_share_kp: number;
    dev_share_tsh: number;
    paid_at: string;
  }>;
}

function tsh(n: number) {
  return `TSh ${n.toLocaleString()}`;
}

export default function EarningsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["dev-earnings"],
    queryFn: () => apiGet<EarningsRes>("/v1/dev/earnings"),
  });

  if (isLoading) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8">
        <p className="text-sm text-gray-500">Loading earnings…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8">
        <p className="text-sm text-red-600">Failed to load earnings.</p>
      </div>
    );
  }

  const s = data.summary;
  const appById = new Map(data.per_app.map((a) => [a.app_id, a]));

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-bold mb-1">Earnings</h1>
      <p className="text-sm text-gray-600 mb-6">
        Your share is 70% of every paid install (KP + TSh). Unpaid balance is paid out monthly via M-Pesa.
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
        <Stat label="Lifetime TSh" value={tsh(s.total_earnings_tsh)} highlight />
        <Stat label="Lifetime KP" value={`${s.total_earnings_kp.toLocaleString()} KP`} />
        <Stat label="Unpaid TSh" value={tsh(s.unpaid_balance_tsh)} />
        <Stat label="Total installs" value={s.total_installs.toLocaleString()} />
      </div>

      <h2 className="text-lg font-semibold mb-3">Per-app breakdown</h2>
      <div className="card mb-8">
        {data.per_app.length === 0 ? (
          <p className="text-sm text-gray-500">No apps published yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-500 uppercase">
              <tr>
                <th className="pb-2">App</th>
                <th>Installs</th>
                <th>Earned (KP)</th>
                <th>Earned (TSh)</th>
              </tr>
            </thead>
            <tbody>
              {data.per_app.map((a) => (
                <tr key={a.app_id} className="border-t">
                  <td className="py-2 font-medium">{a.name ?? `App #${a.app_id}`}</td>
                  <td>{a.installs}</td>
                  <td>{a.total_kp.toLocaleString()} KP</td>
                  <td>{tsh(a.total_tsh)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2 className="text-lg font-semibold mb-3">Recent purchases</h2>
      <div className="card">
        {data.recent_purchases.length === 0 ? (
          <p className="text-sm text-gray-500">No paid installs yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-500 uppercase">
              <tr>
                <th className="pb-2">When</th>
                <th>App</th>
                <th>Price</th>
                <th>Your share</th>
              </tr>
            </thead>
            <tbody>
              {data.recent_purchases.map((p) => {
                const app = appById.get(p.app_id);
                const price = p.price_kp > 0 ? `${p.price_kp} KP` : tsh(p.price_tsh);
                const share =
                  p.dev_share_kp > 0
                    ? `${p.dev_share_kp} KP`
                    : tsh(p.dev_share_tsh);
                return (
                  <tr key={p.id} className="border-t">
                    <td className="py-2">{new Date(p.paid_at).toLocaleString()}</td>
                    <td>{app?.name ?? `App #${p.app_id}`}</td>
                    <td>{price}</td>
                    <td className="font-semibold" style={{ color: "#00A86B" }}>
                      {share}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="card">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div
        className="text-2xl font-bold mt-1"
        style={{ color: highlight ? "#00A86B" : "#1A1A2E" }}
      >
        {value}
      </div>
    </div>
  );
}
