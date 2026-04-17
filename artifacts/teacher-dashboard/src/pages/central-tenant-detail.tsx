import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import { apiGet, apiPost } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, KeyRound, Plus, Eye, EyeOff } from "lucide-react";

type Subscription = {
  id: number;
  student_code: string;
  student_name: string;
  plan: string;
  status: string;
  monthly_price_tsh: number;
  parent_phone: string | null;
  expires_at: string | null;
  last_payment_at: string | null;
};

type Tenant = {
  id: number;
  name: string;
  slug: string;
  plan: string;
  region: string;
  contact_email: string | null;
  contact_phone: string | null;
  license_key: string;
  last_sync_at: string | null;
  students_cap: number;
};

type Detail = { tenant: Tenant; subscriptions: Subscription[]; usage: Array<{ snapshot_at: string; students_active_24h: number; ai_questions_24h: number; print_jobs_24h: number }> };

const STATUS_COLOR: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  trial: "outline",
  grace: "secondary",
  expired: "destructive",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

export default function CentralTenantDetail() {
  const [, params] = useRoute("/central/:id");
  const id = params?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showKey, setShowKey] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Subscription | null>(null);
  const [form, setForm] = useState({ student_code: "", student_name: "", plan: "basic", status: "active", monthly_price_tsh: 5000, parent_phone: "", expires_at: "" });

  const { data, isLoading } = useQuery({
    queryKey: ["/central/v1/admin/tenants", id],
    queryFn: () => apiGet<Detail>(`/central/v1/admin/tenants/${id}`),
    enabled: !!id,
    refetchInterval: 30_000,
  });

  const upsertMut = useMutation({
    mutationFn: (body: typeof form) => apiPost(`/central/v1/admin/tenants/${id}/subscriptions`, {
      ...body,
      expires_at: body.expires_at || null,
    }),
    onSuccess: () => {
      toast({ title: editing ? "Subscription updated" : "Subscription added" });
      qc.invalidateQueries({ queryKey: ["/central/v1/admin/tenants", id] });
      qc.invalidateQueries({ queryKey: ["/central/v1/admin/tenants"] });
      setOpen(false);
      setEditing(null);
      setForm({ student_code: "", student_name: "", plan: "basic", status: "active", monthly_price_tsh: 5000, parent_phone: "", expires_at: "" });
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  function openEdit(s: Subscription) {
    setEditing(s);
    setForm({
      student_code: s.student_code,
      student_name: s.student_name,
      plan: s.plan,
      status: s.status,
      monthly_price_tsh: s.monthly_price_tsh,
      parent_phone: s.parent_phone ?? "",
      expires_at: s.expires_at ? s.expires_at.slice(0, 10) : "",
    });
    setOpen(true);
  }

  function openCreate() {
    setEditing(null);
    setForm({ student_code: "", student_name: "", plan: "basic", status: "active", monthly_price_tsh: 5000, parent_phone: "", expires_at: "" });
    setOpen(true);
  }

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!data) return <div className="text-sm text-muted-foreground">Not found.</div>;

  const t = data.tenant;
  const activeCount = data.subscriptions.filter((s) => s.status === "active").length;
  const mrr = data.subscriptions.filter((s) => s.status === "active").reduce((sum, s) => sum + s.monthly_price_tsh, 0);

  return (
    <div className="space-y-6">
      <Link href="/central"><Button variant="ghost" size="sm" className="mb-2"><ArrowLeft className="h-4 w-4 mr-1" />All schools</Button></Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.name}</h1>
        <div className="text-sm text-muted-foreground flex items-center gap-1">{t.region} · {t.slug} · <Badge variant="outline" className="ml-1">{t.plan}</Badge></div>
      </div>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> License key</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-muted rounded text-xs font-mono break-all" data-testid="text-license-key">
              {showKey ? t.license_key : t.license_key.replace(/./g, (c, i) => (i < 12 || i > t.license_key.length - 4 ? c : "•"))}
            </code>
            <Button size="sm" variant="outline" onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button>
            <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(t.license_key); toast({ title: "Copied" }); }}>Copy</Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">Set <code>TENANT_LICENSE_KEY</code> on this school's local server, alongside <code>CENTRAL_BASE_URL</code> pointing at this central server. The school will start polling for subscription updates within a minute.</p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-4">
        <Card><CardContent className="pt-6"><div className="text-xs text-muted-foreground">Students</div><div className="text-2xl font-bold">{data.subscriptions.length} <span className="text-sm font-normal text-muted-foreground">/ {t.students_cap}</span></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="text-xs text-muted-foreground">Active subscriptions</div><div className="text-2xl font-bold">{activeCount}</div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="text-xs text-muted-foreground">Monthly recurring</div><div className="text-2xl font-bold">TSh {mrr.toLocaleString()}</div></CardContent></Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Student subscriptions</CardTitle>
          <Button size="sm" onClick={openCreate} data-testid="button-add-subscription"><Plus className="h-4 w-4 mr-1" />Add student</Button>
        </CardHeader>
        <CardContent>
          {data.subscriptions.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">No subscriptions yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Price/mo</TableHead>
                  <TableHead>Parent</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.subscriptions.map((s) => (
                  <TableRow key={s.id} data-testid={`row-sub-${s.student_code}`}>
                    <TableCell>
                      <div className="font-medium">{s.student_name}</div>
                      <div className="text-xs text-muted-foreground font-mono">{s.student_code}</div>
                    </TableCell>
                    <TableCell><Badge variant="outline">{s.plan}</Badge></TableCell>
                    <TableCell><Badge variant={STATUS_COLOR[s.status] ?? "secondary"}>{s.status}</Badge></TableCell>
                    <TableCell>TSh {s.monthly_price_tsh.toLocaleString()}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{s.parent_phone ?? "—"}</TableCell>
                    <TableCell className="text-sm">{fmtDate(s.expires_at)}</TableCell>
                    <TableCell><Button size="sm" variant="ghost" onClick={() => openEdit(s)}>Edit</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {data.usage.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Recent usage snapshots</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Active 24h</TableHead><TableHead>AI questions</TableHead><TableHead>Print jobs</TableHead></TableRow></TableHeader>
              <TableBody>
                {data.usage.map((u, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm">{new Date(u.snapshot_at).toLocaleString()}</TableCell>
                    <TableCell>{u.students_active_24h}</TableCell>
                    <TableCell>{u.ai_questions_24h}</TableCell>
                    <TableCell>{u.print_jobs_24h}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? `Edit ${editing.student_name}` : "Add student subscription"}</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Student code</Label><Input value={form.student_code} onChange={(e) => setForm({ ...form, student_code: e.target.value })} disabled={!!editing} placeholder="TEST006" /></div>
              <div><Label>Name</Label><Input value={form.student_name} onChange={(e) => setForm({ ...form, student_name: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Plan</Label>
                <select className="w-full h-9 rounded-md border bg-background px-3 text-sm" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>
                  <option value="trial">Trial</option><option value="basic">Basic</option><option value="premium">Premium</option>
                </select>
              </div>
              <div><Label>Status</Label>
                <select className="w-full h-9 rounded-md border bg-background px-3 text-sm" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  <option value="active">Active</option><option value="trial">Trial</option><option value="grace">Grace</option><option value="expired">Expired</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Price (TSh / month)</Label><Input type="number" value={form.monthly_price_tsh} onChange={(e) => setForm({ ...form, monthly_price_tsh: Number(e.target.value) })} /></div>
              <div><Label>Expires at</Label><Input type="date" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} /></div>
            </div>
            <div><Label>Parent phone</Label><Input value={form.parent_phone} onChange={(e) => setForm({ ...form, parent_phone: e.target.value })} placeholder="+255 …" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => upsertMut.mutate(form)} disabled={!form.student_code || !form.student_name || upsertMut.isPending} data-testid="button-save-subscription">
              {upsertMut.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
