import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Layout } from "@/components/Layout";
import { apiGet, apiPatch } from "@/lib/api";

interface Campaign {
  id: number;
  name: string;
  pricing_model: string;
  bid_amount_tsh: number;
  daily_budget_tsh: number;
  total_budget_tsh: number;
  spent_total_tsh: number;
  spent_today_tsh: number;
  placements: string[];
  status: string;
}

export default function Dashboard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => apiGet<{ campaigns: Campaign[] }>("/v1/advertiser/campaigns"),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      apiPatch(`/v1/advertiser/campaigns/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-navy">Campaigns</h1>
          <p className="text-sm text-muted">Manage your active and draft campaigns</p>
        </div>
        <Link href="/campaigns/new" className="btn btn-primary">
          + New campaign
        </Link>
      </div>

      <div className="card p-0 overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center text-muted">Loading…</div>
        ) : !data || data.campaigns.length === 0 ? (
          <div className="p-12 text-center">
            <div className="text-muted mb-4">No campaigns yet.</div>
            <Link href="/campaigns/new" className="btn btn-primary">
              Launch your first campaign
            </Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-semibold">Campaign</th>
                <th className="px-4 py-3 font-semibold">Pricing</th>
                <th className="px-4 py-3 font-semibold">Bid</th>
                <th className="px-4 py-3 font-semibold">Spent</th>
                <th className="px-4 py-3 font-semibold">Placements</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.campaigns.map((c) => (
                <tr key={c.id} className="border-t border-default">
                  <td className="px-4 py-3 font-medium text-navy">{c.name}</td>
                  <td className="px-4 py-3 uppercase text-xs font-bold text-brand">{c.pricing_model}</td>
                  <td className="px-4 py-3">TSh {c.bid_amount_tsh.toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <div>TSh {c.spent_total_tsh.toLocaleString()}</div>
                    <div className="text-xs text-muted">today: {c.spent_today_tsh.toLocaleString()}</div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {(c.placements ?? []).map((p) => (
                      <span key={p} className="inline-block bg-gray-100 rounded px-1.5 py-0.5 mr-1 mb-1">
                        {p}
                      </span>
                    ))}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <Link href={`/campaigns/${c.id}/creatives`} className="text-brand text-xs font-semibold">
                      Creatives
                    </Link>
                    {c.status === "active" ? (
                      <button
                        onClick={() => setStatus.mutate({ id: c.id, status: "paused" })}
                        className="text-xs text-orange-600 font-semibold"
                      >
                        Pause
                      </button>
                    ) : c.status === "paused" || c.status === "draft" ? (
                      <button
                        onClick={() => setStatus.mutate({ id: c.id, status: "active" })}
                        className="text-xs text-brand font-semibold"
                      >
                        Activate
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: "bg-green-100 text-green-700",
    draft: "bg-gray-100 text-gray-600",
    paused: "bg-orange-100 text-orange-700",
    exhausted: "bg-red-100 text-red-700",
    ended: "bg-gray-100 text-gray-500",
    rejected: "bg-red-100 text-red-700",
  };
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded ${styles[status] ?? "bg-gray-100"}`}>
      {status}
    </span>
  );
}
