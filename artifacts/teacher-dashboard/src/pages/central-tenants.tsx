import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiGet, apiPost } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Building2, Plus, ArrowRight, Activity, Users, DollarSign } from "lucide-react";

type Tenant = {
  id: number;
  slug: string;
  name: string;
  region: string;
  plan: string;
  active: boolean;
  students_cap: number;
  contact_email: string | null;
  contact_phone: string | null;
  license_key: string;
  last_sync_at: string | null;
  students_total: number;
  students_active: number;
  mrr_tsh: number;
  latest_usage: { ai_questions_24h: number; print_jobs_24h: number } | null;
};

function planColor(plan: string): "default" | "secondary" | "outline" {
  if (plan === "pro") return "default";
  if (plan === "trial") return "outline";
  return "secondary";
}

function formatTSh(n: number): string {
  return `TSh ${n.toLocaleString()}`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export default function CentralTenants() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", slug: "", region: "Tanzania", plan: "standard", contact_email: "", contact_phone: "", students_cap: 500 });

  const { data, isLoading } = useQuery({
    queryKey: ["/central/v1/admin/tenants"],
    queryFn: () => apiGet<{ tenants: Tenant[] }>("/central/v1/admin/tenants"),
    refetchInterval: 30_000,
  });

  const createMut = useMutation({
    mutationFn: (body: typeof form) => apiPost<{ tenant: Tenant }>("/central/v1/admin/tenants", body),
    onSuccess: (res) => {
      toast({
        title: "School added",
        description: `License key: ${res.tenant.license_key.slice(0, 24)}…`,
      });
      qc.invalidateQueries({ queryKey: ["/central/v1/admin/tenants"] });
      setOpen(false);
      setForm({ name: "", slug: "", region: "Tanzania", plan: "standard", contact_email: "", contact_phone: "", students_cap: 500 });
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const tenants = data?.tenants ?? [];
  const totalMrr = tenants.reduce((s, t) => s + t.mrr_tsh, 0);
  const totalActive = tenants.reduce((s, t) => s + t.students_active, 0);
  const totalStudents = tenants.reduce((s, t) => s + t.students_total, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Schools (Central Control)</h1>
          <p className="text-sm text-muted-foreground">Manage every connected school and its student subscriptions.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-school"><Plus className="h-4 w-4 mr-2" />Add school</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Connect a new school</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div><Label>School name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Iringa Girls Secondary" /></div>
              <div><Label>Slug</Label><Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/\s+/g, "-") })} placeholder="iringa-girls" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Region</Label><Input value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></div>
                <div><Label>Plan</Label>
                  <select className="w-full h-9 rounded-md border bg-background px-3 text-sm" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>
                    <option value="trial">Trial</option>
                    <option value="standard">Standard</option>
                    <option value="pro">Pro</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Contact email</Label><Input value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} /></div>
                <div><Label>Contact phone</Label><Input value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} /></div>
              </div>
              <div><Label>Student cap</Label><Input type="number" value={form.students_cap} onChange={(e) => setForm({ ...form, students_cap: Number(e.target.value) })} /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={() => createMut.mutate(form)} disabled={!form.name || !form.slug || createMut.isPending}>
                {createMut.isPending ? "Creating…" : "Create + issue license"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card><CardContent className="pt-6"><div className="flex items-center justify-between"><div><div className="text-xs text-muted-foreground">Connected schools</div><div className="text-2xl font-bold">{tenants.length}</div></div><Building2 className="h-8 w-8 text-primary opacity-60" /></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="flex items-center justify-between"><div><div className="text-xs text-muted-foreground">Active subscriptions</div><div className="text-2xl font-bold">{totalActive} <span className="text-sm font-normal text-muted-foreground">/ {totalStudents}</span></div></div><Users className="h-8 w-8 text-primary opacity-60" /></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="flex items-center justify-between"><div><div className="text-xs text-muted-foreground">Monthly recurring</div><div className="text-2xl font-bold">{formatTSh(totalMrr)}</div></div><DollarSign className="h-8 w-8 text-primary opacity-60" /></div></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle>All schools</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
          ) : tenants.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">No schools yet. Add one to get started.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>School</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Students</TableHead>
                  <TableHead>MRR</TableHead>
                  <TableHead>Last sync</TableHead>
                  <TableHead>AI / Print (24h)</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.map((t) => (
                  <TableRow key={t.id} data-testid={`row-tenant-${t.slug}`}>
                    <TableCell>
                      <div className="font-medium">{t.name}</div>
                      <div className="text-xs text-muted-foreground">{t.region} · {t.slug}</div>
                    </TableCell>
                    <TableCell><Badge variant={planColor(t.plan)}>{t.plan}</Badge></TableCell>
                    <TableCell><span className="font-medium">{t.students_active}</span> <span className="text-muted-foreground">/ {t.students_total}</span></TableCell>
                    <TableCell>{formatTSh(t.mrr_tsh)}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1 text-sm">
                        <Activity className={`h-3 w-3 ${t.last_sync_at && Date.now() - new Date(t.last_sync_at).getTime() < 5 * 60_000 ? "text-green-500" : "text-muted-foreground"}`} />
                        {relativeTime(t.last_sync_at)}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">{t.latest_usage ? `${t.latest_usage.ai_questions_24h} / ${t.latest_usage.print_jobs_24h}` : <span className="text-muted-foreground">–</span>}</TableCell>
                    <TableCell><Link href={`/central/${t.id}`}><Button size="sm" variant="ghost">Manage <ArrowRight className="h-4 w-4 ml-1" /></Button></Link></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
