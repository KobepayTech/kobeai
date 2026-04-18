import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { ShieldCheck, ShieldX, RefreshCw, Eye } from "lucide-react";

// Super-admin moderation queue for mini-app submissions.
// Only "submitted" apps appear here. Approve flips status to "approved" so
// it shows up in the watch AppStore. Reject sets a `rejection_reason` the
// developer sees on their dashboard.

type QueueApp = {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  category: string;
  type: string;
  price_kp: number;
  price_tsh: number;
  status: string;
  current_version_id: number | null;
  developer: { id: number; name: string; email: string } | null;
  updated_at: string;
};

type AppDetail = {
  app: QueueApp;
  version: { id: number; version: number; manifest: any; status: string } | null;
  developer: any;
};

export default function ModerationApps() {
  const { toast } = useToast();
  const [items, setItems] = useState<QueueApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<AppDetail | null>(null);
  const [reason, setReason] = useState("");

  async function load() {
    setLoading(true);
    try {
      const r = await apiGet<{ apps: QueueApp[] }>("/v1/admin/moderation/queue");
      setItems(r.apps);
    } catch (e: any) {
      toast({ title: "Failed to load queue", description: String(e.message ?? e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function open(id: number) {
    try {
      const r = await apiGet<AppDetail>(`/v1/admin/moderation/apps/${id}`);
      setSelected(r);
      setReason("");
    } catch (e: any) {
      toast({ title: "Failed to load app", description: String(e.message ?? e), variant: "destructive" });
    }
  }

  async function approve(id: number) {
    try {
      await apiPost(`/v1/admin/moderation/apps/${id}/approve`, {});
      toast({ title: "Approved", description: "App is now live in the AppStore." });
      setSelected(null);
      load();
    } catch (e: any) {
      toast({ title: "Approve failed", description: String(e.message ?? e), variant: "destructive" });
    }
  }

  async function reject(id: number) {
    if (!reason.trim()) {
      toast({ title: "Reason required", variant: "destructive" });
      return;
    }
    try {
      await apiPost(`/v1/admin/moderation/apps/${id}/reject`, { reason });
      toast({ title: "Rejected", description: "Developer will be notified." });
      setSelected(null);
      load();
    } catch (e: any) {
      toast({ title: "Reject failed", description: String(e.message ?? e), variant: "destructive" });
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" /> App Moderation
          </h1>
          <p className="text-sm text-muted-foreground">Review submitted mini-apps before they reach students.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4">
          <h2 className="font-semibold mb-3">Pending submissions ({items.length})</h2>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No apps awaiting review.</p>
          ) : (
            <ul className="space-y-2">
              {items.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-3 p-3 rounded-md border hover:bg-accent cursor-pointer"
                  onClick={() => open(a.id)}
                >
                  <div className="text-2xl">{a.icon ?? "📦"}</div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{a.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {a.developer?.name ?? "Unknown dev"} · {a.category} · {a.type}
                    </div>
                  </div>
                  <Badge variant="secondary">{a.price_kp > 0 ? `${a.price_kp} KP` : a.price_tsh > 0 ? `${a.price_tsh} TSh` : "Free"}</Badge>
                  <Button variant="ghost" size="icon"><Eye className="h-4 w-4" /></Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          {!selected ? (
            <p className="text-sm text-muted-foreground">Select an app to review its manifest.</p>
          ) : (
            <div className="space-y-3">
              <div>
                <h2 className="font-bold text-lg flex items-center gap-2">
                  <span className="text-2xl">{selected.app.icon ?? "📦"}</span>{selected.app.name}
                </h2>
                <p className="text-sm text-muted-foreground">{selected.app.description}</p>
                <div className="flex gap-2 mt-2">
                  <Badge>{selected.app.category}</Badge>
                  <Badge variant="outline">{selected.app.type}</Badge>
                  <Badge variant="secondary">v{selected.version?.version ?? "?"}</Badge>
                </div>
              </div>
              <div>
                <h3 className="text-sm font-semibold mb-1">Developer</h3>
                <p className="text-sm">{selected.developer?.display_name} &lt;{selected.developer?.email}&gt;</p>
              </div>
              <div>
                <h3 className="text-sm font-semibold mb-1">Manifest</h3>
                <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-72">
{JSON.stringify(selected.version?.manifest ?? {}, null, 2)}
                </pre>
              </div>
              <div className="space-y-2">
                <Textarea
                  placeholder="Rejection reason (required if rejecting)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                />
                <div className="flex gap-2">
                  <Button onClick={() => approve(selected.app.id)} className="flex-1">
                    <ShieldCheck className="h-4 w-4 mr-1" /> Approve
                  </Button>
                  <Button variant="destructive" onClick={() => reject(selected.app.id)} className="flex-1">
                    <ShieldX className="h-4 w-4 mr-1" /> Reject
                  </Button>
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
