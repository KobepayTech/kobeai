import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { apiGet } from "@/lib/api";

interface CampaignStat {
  campaign_id: number;
  name: string;
  impressions: number;
  clicks: number;
  spend_tsh: number;
  ctr: number;
}

interface StatsResponse {
  totals: { impressions: number; clicks: number; spend_tsh: number; ctr: number };
  campaigns: CampaignStat[];
}

export default function Stats() {
  const { data, isLoading } = useQuery({
    queryKey: ["stats"],
    queryFn: () => apiGet<StatsResponse>("/v1/advertiser/stats"),
  });

  return (
    <Layout>
      <h1 className="text-2xl font-bold text-navy mb-1">Performance</h1>
      <p className="text-sm text-muted mb-6">Lifetime impressions, clicks, and spend.</p>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <Stat label="Impressions" value={data?.totals.impressions ?? 0} />
        <Stat label="Clicks" value={data?.totals.clicks ?? 0} />
        <Stat label="CTR" value={`${((data?.totals.ctr ?? 0) * 100).toFixed(2)}%`} />
        <Stat label="Spend (TSh)" value={(data?.totals.spend_tsh ?? 0).toLocaleString()} />
      </div>

      <div className="card p-0 overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center text-muted">Loading…</div>
        ) : !data || data.campaigns.length === 0 ? (
          <div className="p-12 text-center text-muted">No data yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-semibold">Campaign</th>
                <th className="px-4 py-3 font-semibold">Impressions</th>
                <th className="px-4 py-3 font-semibold">Clicks</th>
                <th className="px-4 py-3 font-semibold">CTR</th>
                <th className="px-4 py-3 font-semibold">Spend (TSh)</th>
              </tr>
            </thead>
            <tbody>
              {data.campaigns.map((c) => (
                <tr key={c.campaign_id} className="border-t border-default">
                  <td className="px-4 py-3 font-medium text-navy">{c.name}</td>
                  <td className="px-4 py-3">{c.impressions.toLocaleString()}</td>
                  <td className="px-4 py-3">{c.clicks.toLocaleString()}</td>
                  <td className="px-4 py-3">{(c.ctr * 100).toFixed(2)}%</td>
                  <td className="px-4 py-3">{c.spend_tsh.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card">
      <div className="text-xs uppercase tracking-wide text-muted font-semibold">{label}</div>
      <div className="text-2xl font-bold text-navy mt-1">{value}</div>
    </div>
  );
}
