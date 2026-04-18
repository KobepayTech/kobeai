import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// All ad-exchange endpoints live on the standalone ads-server, mounted by
// the platform proxy at `/ads-api/*`. The admin login itself still hits the
// main api-server (`/api/v1/auth/teacher/login`) below.
const BASE = "/ads-api";
const AUTH_BASE = "/api";

function adminHeaders(): Record<string, string> {
  const t = localStorage.getItem("admin_token");
  return t ? { Authorization: `Bearer ${t}` } : {};
}

class AdminAuthError extends Error {
  constructor() { super("unauthorized"); }
}

async function adminGet<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: adminHeaders() });
  if (r.status === 401 || r.status === 403) throw new AdminAuthError();
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}

async function adminJson<T>(path: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 || r.status === 403) throw new AdminAuthError();
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}

interface Revenue {
  advertisers_total: number;
  advertiser_balance_total_tsh: number;
  impressions_total: number;
  clicks_total: number;
  impression_revenue_tsh: number;
  click_revenue_tsh: number;
  total_revenue_tsh: number;
}

interface Advertiser {
  id: number;
  company_name: string;
  contact_email: string;
  balance_tsh: number;
  status: string;
}

interface Campaign {
  id: number;
  advertiser_id: number;
  advertiser_name: string | null;
  name: string;
  pricing_model: string;
  bid_amount_tsh: number;
  placements: string[];
  status: string;
  spent_total_tsh: number;
}

function tsh(n: number) {
  return `TSh ${(n ?? 0).toLocaleString()}`;
}

function AdminLogin({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState("admin@school.tz");
  const [password, setPassword] = useState("admin123");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${AUTH_BASE}/v1/auth/teacher/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!r.ok) throw new Error("Invalid credentials");
      const j = await r.json();
      if (j.role !== "admin" && j.role !== "super_admin") {
        throw new Error("Account is not an admin");
      }
      localStorage.setItem("admin_token", j.access_token);
      onLogin();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto px-6 py-12">
      <h1 className="text-2xl font-bold mb-1">Ads Admin</h1>
      <p className="text-sm text-gray-600 mb-6">Sign in as a school admin to moderate the ad exchange.</p>
      <form onSubmit={submit} className="space-y-3">
        <input
          className="input w-full"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="input w-full"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {err && <div className="text-sm text-red-600">{err}</div>}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

export default function AdsAdminPage() {
  const [authed, setAuthed] = useState<boolean>(() => !!localStorage.getItem("admin_token"));
  const qc = useQueryClient();

  const revenue = useQuery({
    queryKey: ["ads-admin", "revenue"],
    queryFn: () => adminGet<Revenue>("/v1/admin/ads/revenue"),
    enabled: authed,
  });
  const advertisers = useQuery({
    queryKey: ["ads-admin", "advertisers"],
    queryFn: () => adminGet<{ advertisers: Advertiser[] }>("/v1/admin/ads/advertisers"),
    enabled: authed,
  });
  const campaigns = useQuery({
    queryKey: ["ads-admin", "campaigns"],
    queryFn: () => adminGet<{ campaigns: Campaign[] }>("/v1/admin/ads/campaigns"),
    enabled: authed,
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      adminJson<{ campaign: Campaign }>(
        `/v1/admin/ads/campaigns/${id}`,
        "PATCH",
        { status },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ads-admin", "campaigns"] });
      qc.invalidateQueries({ queryKey: ["ads-admin", "revenue"] });
    },
  });

  // Auto-detect 401/403 and bounce to login. Detection uses the typed
  // AdminAuthError thrown by adminGet/adminJson — never error-message regex.
  useEffect(() => {
    const failing = [revenue.error, advertisers.error, campaigns.error, setStatus.error]
      .some((e) => e instanceof AdminAuthError);
    if (failing) {
      localStorage.removeItem("admin_token");
      setAuthed(false);
    }
  }, [revenue.error, advertisers.error, campaigns.error, setStatus.error]);

  if (!authed) return <AdminLogin onLogin={() => setAuthed(true)} />;

  const r = revenue.data;
  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Ads Admin</h1>
          <p className="text-sm text-gray-600">
            Moderate campaigns and review exchange revenue.
          </p>
        </div>
        <button
          className="text-sm text-gray-600 hover:text-gray-900"
          onClick={() => {
            localStorage.removeItem("admin_token");
            setAuthed(false);
          }}
        >
          Sign out
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <Stat label="Total revenue" value={tsh(r?.total_revenue_tsh ?? 0)} />
        <Stat label="Impression revenue" value={tsh(r?.impression_revenue_tsh ?? 0)} />
        <Stat label="Click revenue" value={tsh(r?.click_revenue_tsh ?? 0)} />
        <Stat label="Advertiser balances" value={tsh(r?.advertiser_balance_total_tsh ?? 0)} />
        <Stat label="Advertisers" value={String(r?.advertisers_total ?? 0)} />
        <Stat label="Impressions" value={String(r?.impressions_total ?? 0).toLocaleString()} />
        <Stat label="Clicks" value={String(r?.clicks_total ?? 0).toLocaleString()} />
        <Stat
          label="CTR"
          value={
            r && r.impressions_total > 0
              ? `${((r.clicks_total / r.impressions_total) * 100).toFixed(2)}%`
              : "—"
          }
        />
      </div>

      <h2 className="text-lg font-semibold mb-3">Campaigns</h2>
      <div className="card p-0 overflow-x-auto mb-8">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="p-3">Campaign</th>
              <th className="p-3">Advertiser</th>
              <th className="p-3">Pricing</th>
              <th className="p-3">Bid</th>
              <th className="p-3">Spent</th>
              <th className="p-3">Status</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.data?.campaigns.map((c) => (
              <tr key={c.id} className="border-t">
                <td className="p-3">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-gray-500">
                    {(c.placements ?? []).join(", ")}
                  </div>
                </td>
                <td className="p-3">{c.advertiser_name ?? `#${c.advertiser_id}`}</td>
                <td className="p-3 uppercase">{c.pricing_model}</td>
                <td className="p-3">{tsh(c.bid_amount_tsh)}</td>
                <td className="p-3">{tsh(c.spent_total_tsh)}</td>
                <td className="p-3">
                  <span
                    className={
                      c.status === "active"
                        ? "badge-green"
                        : c.status === "rejected"
                          ? "badge-red"
                          : "badge-gray"
                    }
                  >
                    {c.status}
                  </span>
                </td>
                <td className="p-3 text-right space-x-2">
                  {c.status !== "paused" && (
                    <button
                      className="text-xs text-gray-700 hover:underline"
                      disabled={setStatus.isPending}
                      onClick={() => setStatus.mutate({ id: c.id, status: "paused" })}
                    >
                      Pause
                    </button>
                  )}
                  {c.status !== "active" && c.status !== "rejected" && (
                    <button
                      className="text-xs text-green-700 hover:underline"
                      disabled={setStatus.isPending}
                      onClick={() => setStatus.mutate({ id: c.id, status: "active" })}
                    >
                      Activate
                    </button>
                  )}
                  {c.status !== "rejected" && (
                    <button
                      className="text-xs text-red-700 hover:underline"
                      disabled={setStatus.isPending}
                      onClick={() => {
                        if (confirm(`Reject "${c.name}"? This blocks all future serves.`))
                          setStatus.mutate({ id: c.id, status: "rejected" });
                      }}
                    >
                      Reject
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!campaigns.isLoading && (campaigns.data?.campaigns.length ?? 0) === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-gray-500">
                  No campaigns yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 className="text-lg font-semibold mb-3">Advertisers</h2>
      <div className="card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="p-3">Company</th>
              <th className="p-3">Email</th>
              <th className="p-3">Balance</th>
              <th className="p-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {advertisers.data?.advertisers.map((a) => (
              <tr key={a.id} className="border-t">
                <td className="p-3 font-medium">{a.company_name}</td>
                <td className="p-3">{a.contact_email}</td>
                <td className="p-3">{tsh(a.balance_tsh)}</td>
                <td className="p-3">
                  <span className={a.status === "active" ? "badge-green" : "badge-gray"}>
                    {a.status}
                  </span>
                </td>
              </tr>
            ))}
            {!advertisers.isLoading && (advertisers.data?.advertisers.length ?? 0) === 0 && (
              <tr>
                <td colSpan={4} className="p-6 text-center text-gray-500">
                  No advertisers yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-xl font-bold mt-1">{value}</div>
    </div>
  );
}
