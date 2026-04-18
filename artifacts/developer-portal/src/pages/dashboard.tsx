import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiGet } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface MiniApp {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  category: string;
  type: string;
  price_kp: number;
  price_tsh: number;
  status: string;
  total_installs: number;
  rating_count: number;
  rating_sum: number;
  rejection_reason: string | null;
  updated_at: string;
}

const STATUS_BADGE: Record<string, string> = {
  draft: "badge-gray",
  submitted: "badge-amber",
  approved: "badge-green",
  rejected: "badge-red",
  removed: "badge-gray",
};

function formatTSh(n: number) {
  return `TSh ${n.toLocaleString()}`;
}

export default function DashboardPage() {
  const { developer } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ["dev-apps"],
    queryFn: () => apiGet<{ apps: MiniApp[] }>("/v1/dev/apps"),
  });

  const planActive = developer?.plan_status === "active";
  const planPending = developer?.plan_status === "pending_payment";

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">My Apps</h1>
          <p className="text-sm text-gray-600">
            Manage your mini-apps for the KobeAI watch AppStore.
          </p>
        </div>
        <Link href="/apps/new">
          <button className="btn-primary" disabled={!planActive}>
            + New mini-app
          </button>
        </Link>
      </div>

      {!planActive && (
        <div className="card mb-6" style={{ borderLeft: "4px solid #00A86B" }}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-semibold mb-1">
                {planPending
                  ? "Payment received — awaiting verification"
                  : "Subscribe to publish apps"}
              </h3>
              <p className="text-sm text-gray-600">
                {planPending
                  ? "Our team is verifying your M-Pesa payment. Apps unlock as soon as it's confirmed."
                  : "Choose a plan to start publishing mini-apps. Indie is TSh 50,000/year, Studio is TSh 200,000/year."}
              </p>
            </div>
            <Link href="/billing">
              <button className="btn-primary whitespace-nowrap">
                {planPending ? "View payment" : "Choose plan"}
              </button>
            </Link>
          </div>
        </div>
      )}

      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">Failed to load apps.</p>}

      {data && data.apps.length === 0 && (
        <div className="card text-center py-12">
          <p className="text-lg font-semibold mb-2">No apps yet</p>
          <p className="text-sm text-gray-600 mb-4">
            {planActive
              ? "Tap “New mini-app” to create your first one."
              : "Subscribe to a developer plan, then come back to publish."}
          </p>
        </div>
      )}

      {data && data.apps.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.apps.map((app) => {
            const rating = app.rating_count > 0 ? (app.rating_sum / app.rating_count).toFixed(1) : "—";
            const price =
              app.price_kp === 0 && app.price_tsh === 0
                ? "Free"
                : app.price_kp > 0
                  ? `${app.price_kp} KP`
                  : formatTSh(app.price_tsh);
            return (
              <div key={app.id} className="card">
                <div className="flex items-start gap-3 mb-3">
                  <div
                    className="text-3xl flex-shrink-0 w-12 h-12 rounded-lg flex items-center justify-center"
                    style={{ background: "#f0f4f2" }}
                  >
                    {app.icon || "📱"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold truncate">{app.name}</h3>
                    </div>
                    <span className={`badge ${STATUS_BADGE[app.status] || "badge-gray"}`}>
                      {app.status}
                    </span>
                  </div>
                </div>
                <p className="text-sm text-gray-600 mb-3 line-clamp-2 min-h-[2.5rem]">
                  {app.description || "No description."}
                </p>
                <div className="grid grid-cols-3 gap-2 text-xs text-gray-600 border-t pt-3">
                  <div>
                    <div className="font-semibold text-gray-900">{app.total_installs}</div>
                    <div>Installs</div>
                  </div>
                  <div>
                    <div className="font-semibold text-gray-900">★ {rating}</div>
                    <div>{app.rating_count} reviews</div>
                  </div>
                  <div>
                    <div className="font-semibold text-gray-900">{price}</div>
                    <div>{app.type}</div>
                  </div>
                </div>
                {app.status === "rejected" && app.rejection_reason && (
                  <p className="text-xs text-red-600 mt-3 italic">
                    Rejected: {app.rejection_reason}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
