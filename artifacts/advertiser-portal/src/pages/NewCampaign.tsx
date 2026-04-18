import { FormEvent, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Layout } from "@/components/Layout";
import { apiGet, apiPost } from "@/lib/api";

interface Placement {
  id: string;
  surface: string;
  description: string;
  allowed_formats: string[];
  floor_bid_tsh: number;
}

export default function NewCampaign() {
  const [, navigate] = useLocation();
  const { data: placements } = useQuery({
    queryKey: ["placements"],
    queryFn: () => apiGet<{ placements: Placement[] }>("/v1/advertiser/placements"),
  });

  const [name, setName] = useState("");
  const [pricingModel, setPricingModel] = useState("cpm");
  const [bidAmount, setBidAmount] = useState(2000);
  const [dailyBudget, setDailyBudget] = useState(10000);
  const [totalBudget, setTotalBudget] = useState(100000);
  const [selectedPlacements, setSelectedPlacements] = useState<string[]>([]);
  const [region, setRegion] = useState("");
  const [grade, setGrade] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function togglePlacement(id: string) {
    setSelectedPlacements((cur) =>
      cur.includes(id) ? cur.filter((p) => p !== id) : [...cur, id],
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (selectedPlacements.length === 0) {
      setErr("Pick at least one placement");
      return;
    }
    setBusy(true);
    try {
      const targeting: Record<string, string> = {};
      if (region) targeting.region = region;
      if (grade) targeting.grade = grade;
      const res = await apiPost<{ campaign: { id: number } }>("/v1/advertiser/campaigns", {
        name,
        pricing_model: pricingModel,
        bid_amount_tsh: bidAmount,
        daily_budget_tsh: dailyBudget,
        total_budget_tsh: totalBudget,
        placements: selectedPlacements,
        targeting: Object.keys(targeting).length ? targeting : null,
      });
      navigate(`/campaigns/${res.campaign.id}/creatives`);
    } catch (e: any) {
      setErr(e.message ?? "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout>
      <div className="max-w-2xl">
        <h1 className="text-2xl font-bold text-navy mb-1">New campaign</h1>
        <p className="text-sm text-muted mb-6">Set pricing, budget, and where your ad runs.</p>

        <form onSubmit={onSubmit} className="card space-y-5">
          <div>
            <label className="label">Campaign name</label>
            <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Back-to-school promo" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            {[
              { v: "cpm", title: "CPM", desc: "Pay per 1,000 impressions" },
              { v: "cpc", title: "CPC", desc: "Pay only when tapped" },
              { v: "flat", title: "Flat", desc: "Reserve placement window" },
            ].map((opt) => (
              <button
                type="button"
                key={opt.v}
                onClick={() => setPricingModel(opt.v)}
                className={`text-left p-3 rounded-lg border-2 transition ${
                  pricingModel === opt.v ? "border-brand bg-green-50" : "border-default hover:border-gray-300"
                }`}
              >
                <div className="font-bold text-navy">{opt.title}</div>
                <div className="text-xs text-muted mt-0.5">{opt.desc}</div>
              </button>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="label">Bid (TSh)</label>
              <input className="input" type="number" required min={1} value={bidAmount} onChange={(e) => setBidAmount(Number(e.target.value))} />
              <div className="text-xs text-muted mt-1">
                {pricingModel === "cpm" && "per 1,000 impressions"}
                {pricingModel === "cpc" && "per click"}
                {pricingModel === "flat" && "per period"}
              </div>
            </div>
            <div>
              <label className="label">Daily budget</label>
              <input className="input" type="number" min={0} value={dailyBudget} onChange={(e) => setDailyBudget(Number(e.target.value))} />
            </div>
            <div>
              <label className="label">Total budget</label>
              <input className="input" type="number" min={0} value={totalBudget} onChange={(e) => setTotalBudget(Number(e.target.value))} />
            </div>
          </div>

          <div>
            <label className="label">Placements</label>
            <div className="space-y-2">
              {placements?.placements.map((p) => (
                <label key={p.id} className="flex items-start gap-3 p-3 rounded-lg border border-default cursor-pointer hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={selectedPlacements.includes(p.id)}
                    onChange={() => togglePlacement(p.id)}
                    className="mt-1 accent-[#00A86B]"
                  />
                  <div className="flex-1">
                    <div className="font-semibold text-navy text-sm">{p.id}</div>
                    <div className="text-xs text-muted">{p.description}</div>
                    <div className="text-xs text-muted mt-1">
                      Formats: {p.allowed_formats.join(", ")} · Floor: TSh {p.floor_bid_tsh}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Region (optional)</label>
              <input className="input" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="Dar es Salaam" />
            </div>
            <div>
              <label className="label">Grade (optional)</label>
              <input className="input" value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="Form 1" />
            </div>
          </div>

          {err && <div className="text-sm text-red-600">{err}</div>}

          <div className="flex gap-3 pt-2">
            <button className="btn btn-primary" disabled={busy}>
              {busy ? "Creating…" : "Create campaign & add creative"}
            </button>
            <button type="button" onClick={() => navigate("/dashboard")} className="btn btn-secondary">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </Layout>
  );
}
