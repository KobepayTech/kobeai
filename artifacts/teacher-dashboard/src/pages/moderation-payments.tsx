import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Wallet, Check, X, RefreshCw } from "lucide-react";

// Super-admin queue for verifying developer-portal subscription payments
// (M-Pesa till receipts). Once verified the developer's `plan` flips to
// active and they can publish more apps.

type Payment = {
  id: number;
  developer_id: number;
  kind: string;
  plan: string | null;
  amount_tsh: number;
  reference: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  developer: { id: number; name: string; email: string } | null;
};

export default function ModerationPayments() {
  const { toast } = useToast();
  const [items, setItems] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<Record<number, string>>({});

  async function load() {
    setLoading(true);
    try {
      const r = await apiGet<{ payments: Payment[] }>("/v1/admin/moderation/payments");
      setItems(r.payments);
    } catch (e: any) {
      toast({ title: "Failed to load", description: String(e.message ?? e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function verify(id: number) {
    try {
      await apiPost(`/v1/admin/moderation/payments/${id}/verify`, {});
      toast({ title: "Verified", description: "Developer plan activated." });
      load();
    } catch (e: any) {
      toast({ title: "Verify failed", description: String(e.message ?? e), variant: "destructive" });
    }
  }

  async function reject(id: number) {
    try {
      await apiPost(`/v1/admin/moderation/payments/${id}/reject`, { notes: notes[id] ?? "" });
      toast({ title: "Rejected" });
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
            <Wallet className="h-6 w-6 text-primary" /> Developer Payments
          </h1>
          <p className="text-sm text-muted-foreground">Verify M-Pesa till receipts before activating subscriptions.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <Card className="p-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pending payments.</p>
        ) : (
          <div className="space-y-3">
            {items.map((p) => (
              <div key={p.id} className="border rounded-md p-3 flex flex-col md:flex-row md:items-center gap-3">
                <div className="flex-1">
                  <div className="font-medium">{p.developer?.name ?? "Unknown"} <span className="text-muted-foreground text-sm">&lt;{p.developer?.email ?? "?"}&gt;</span></div>
                  <div className="text-sm text-muted-foreground">
                    {p.plan ? `${p.plan} plan` : p.kind} · {p.amount_tsh.toLocaleString()} TSh · ref: <code>{p.reference ?? "—"}</code>
                  </div>
                  <div className="text-xs text-muted-foreground">{new Date(p.created_at).toLocaleString()}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{p.status}</Badge>
                  <Input
                    placeholder="Notes (optional)"
                    className="w-44"
                    value={notes[p.id] ?? ""}
                    onChange={(e) => setNotes({ ...notes, [p.id]: e.target.value })}
                  />
                  <Button size="sm" onClick={() => verify(p.id)}>
                    <Check className="h-4 w-4 mr-1" /> Verify
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => reject(p.id)}>
                    <X className="h-4 w-4 mr-1" /> Reject
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
