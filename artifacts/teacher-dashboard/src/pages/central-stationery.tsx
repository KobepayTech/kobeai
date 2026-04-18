import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, apiPatch } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Package,
  Plus,
  Save,
  Trash2,
  FileText,
  Download,
  Calendar,
  Building2,
} from "lucide-react";

// Super-admin Stationery control plane.
// Three sections in tabs:
//   1. Catalog — master list of items, prices & categories
//   2. Drives — create / open / close termly drives
//   3. Compilation — see aggregate orders + PDF invoice download

type Item = {
  id: number;
  name: string;
  category: string;
  unit: string;
  default_price_tsh: number;
  active: boolean;
};
type Drive = {
  id: number;
  title: string;
  description: string | null;
  status: "open" | "closed" | "invoiced";
  opens_at: string;
  closes_at: string;
};
type Compilation = {
  drive: Drive;
  items: {
    item_id: number;
    item_name: string;
    total_qty: number;
    total_revenue_tsh: number;
    schools: { tenant_id: number; tenant_name: string; qty: number; revenue_tsh: number }[];
  }[];
  schools: {
    tenant_id: number;
    name: string;
    slug: string;
    qty: number;
    revenue_tsh: number;
    orders: number;
  }[];
  grand_qty: number;
  grand_revenue_tsh: number;
};

export default function CentralStationeryPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<"catalog" | "drives" | "compilation">("catalog");
  const [items, setItems] = useState<Item[]>([]);
  const [drives, setDrives] = useState<Drive[]>([]);
  const [compilation, setCompilation] = useState<Compilation | null>(null);
  const [selectedDrive, setSelectedDrive] = useState<number | null>(null);

  const loadCatalog = async () => {
    const r = await apiGet<{ items: Item[] }>("/central/v1/admin/stationery/items");
    setItems(r.items);
  };
  const loadDrives = async () => {
    const r = await apiGet<{ drives: Drive[] }>("/central/v1/admin/stationery/drives");
    setDrives(r.drives);
    if (!selectedDrive && r.drives[0]) setSelectedDrive(r.drives[0].id);
  };
  const loadCompilation = async (id: number) => {
    const r = await apiGet<Compilation>(
      `/central/v1/admin/stationery/compilation/${id}`,
    );
    setCompilation(r);
  };

  useEffect(() => {
    loadCatalog().catch((e) => toast({ title: "Catalog load failed", description: (e as Error).message, variant: "destructive" }));
    loadDrives().catch((e) => toast({ title: "Drives load failed", description: (e as Error).message, variant: "destructive" }));
  }, []);

  useEffect(() => {
    if (tab === "compilation" && selectedDrive) {
      loadCompilation(selectedDrive).catch((e) =>
        toast({ title: "Couldn't load compilation", description: (e as Error).message, variant: "destructive" }),
      );
    }
  }, [tab, selectedDrive]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Package className="w-6 h-6 text-primary" /> Stationery (Super Admin)
        </h1>
        <p className="text-sm text-muted-foreground">
          Master catalog, termly drives, and per-school compilation across all
          KobeAI schools.
        </p>
      </div>

      <div className="flex gap-2 border-b">
        {([
          ["catalog", "Catalog"],
          ["drives", "Drives"],
          ["compilation", "Compilation & Invoice"],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition ${
              tab === k ? "border-primary text-primary" : "border-transparent text-muted-foreground"
            }`}
            data-testid={`tab-${k}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "catalog" && <CatalogTab items={items} reload={loadCatalog} />}
      {tab === "drives" && (
        <DrivesTab
          drives={drives}
          reload={loadDrives}
          select={(id) => {
            setSelectedDrive(id);
            setTab("compilation");
          }}
        />
      )}
      {tab === "compilation" && (
        <CompilationTab
          drives={drives}
          selected={selectedDrive}
          setSelected={setSelectedDrive}
          compilation={compilation}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
function CatalogTab({ items, reload }: { items: Item[]; reload: () => Promise<void> }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState({ name: "", category: "", default_price_tsh: 0, unit: "each" });
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState<Record<number, Partial<Item>>>({});

  const create = async () => {
    if (!draft.name.trim()) return;
    setBusy(true);
    try {
      await apiPost("/central/v1/admin/stationery/items", draft);
      toast({ title: "Item added" });
      setDraft({ name: "", category: "", default_price_tsh: 0, unit: "each" });
      await reload();
    } catch (e) {
      toast({ title: "Couldn't add", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const save = async (id: number) => {
    const patch = edits[id];
    if (!patch) return;
    try {
      await apiPatch(`/central/v1/admin/stationery/items/${id}`, patch);
      setEdits((p) => {
        const n = { ...p };
        delete n[id];
        return n;
      });
      await reload();
      toast({ title: "Saved" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    }
  };

  const archive = async (id: number) => {
    if (!confirm("Archive this item? Existing orders will keep working.")) return;
    try {
      await fetch(`${import.meta.env.BASE_URL}api/central/v1/admin/stationery/items/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${localStorage.getItem("teacher_token") ?? ""}` },
      });
      await reload();
      toast({ title: "Archived" });
    } catch (e) {
      toast({ title: "Couldn't archive", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="font-bold mb-3">Add catalog item</h2>
        <div className="grid grid-cols-12 gap-2 items-end">
          <div className="col-span-4">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              data-testid="new-name"
            />
          </div>
          <div className="col-span-3">
            <label className="text-xs text-muted-foreground">Category</label>
            <Input
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
              data-testid="new-category"
            />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground">Price TSh</label>
            <Input
              type="number"
              value={draft.default_price_tsh}
              onChange={(e) => setDraft({ ...draft, default_price_tsh: Number(e.target.value) })}
              data-testid="new-price"
            />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground">Unit</label>
            <Input
              value={draft.unit}
              onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
            />
          </div>
          <div className="col-span-1">
            <Button onClick={create} disabled={busy} data-testid="add-item">
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground bg-muted/30">
            <tr>
              <th className="p-3">Name</th>
              <th className="p-3">Category</th>
              <th className="p-3 text-right">Price TSh</th>
              <th className="p-3">Unit</th>
              <th className="p-3">Active</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((it) => {
              const draft = { ...it, ...(edits[it.id] ?? {}) } as Item;
              const dirty = !!edits[it.id];
              const update = (patch: Partial<Item>) =>
                setEdits((p) => ({ ...p, [it.id]: { ...p[it.id], ...patch } }));
              return (
                <tr key={it.id} data-testid={`item-${it.id}`}>
                  <td className="p-3">
                    <Input value={draft.name} onChange={(e) => update({ name: e.target.value })} />
                  </td>
                  <td className="p-3">
                    <Input
                      value={draft.category}
                      onChange={(e) => update({ category: e.target.value })}
                    />
                  </td>
                  <td className="p-3 text-right">
                    <Input
                      type="number"
                      value={draft.default_price_tsh}
                      onChange={(e) => update({ default_price_tsh: Number(e.target.value) })}
                      className="text-right"
                    />
                  </td>
                  <td className="p-3">
                    <Input value={draft.unit} onChange={(e) => update({ unit: e.target.value })} />
                  </td>
                  <td className="p-3">
                    <input
                      type="checkbox"
                      checked={draft.active}
                      onChange={(e) => update({ active: e.target.checked })}
                    />
                  </td>
                  <td className="p-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" onClick={() => save(it.id)} disabled={!dirty}>
                        <Save className="w-3 h-3" />
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => archive(it.id)}>
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drives
// ---------------------------------------------------------------------------
function DrivesTab({
  drives,
  reload,
  select,
}: {
  drives: Drive[];
  reload: () => Promise<void>;
  select: (id: number) => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState({ title: "", description: "", closes_at: "" });

  const create = async () => {
    if (!draft.title || !draft.closes_at) return;
    try {
      await apiPost("/central/v1/admin/stationery/drives", {
        title: draft.title,
        description: draft.description,
        closes_at: new Date(draft.closes_at).toISOString(),
      });
      setDraft({ title: "", description: "", closes_at: "" });
      await reload();
      toast({ title: "Drive opened" });
    } catch (e) {
      toast({ title: "Couldn't open drive", description: (e as Error).message, variant: "destructive" });
    }
  };

  const setStatus = async (id: number, status: Drive["status"]) => {
    try {
      await apiPatch(`/central/v1/admin/stationery/drives/${id}`, { status });
      await reload();
    } catch (e) {
      toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="font-bold mb-3">Open new drive</h2>
        <div className="grid grid-cols-12 gap-2 items-end">
          <div className="col-span-4">
            <label className="text-xs text-muted-foreground">Title</label>
            <Input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="Term 3 Stationery — Sept 2026"
              data-testid="drive-title"
            />
          </div>
          <div className="col-span-5">
            <label className="text-xs text-muted-foreground">Description</label>
            <Input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground">Closes</label>
            <Input
              type="date"
              value={draft.closes_at}
              onChange={(e) => setDraft({ ...draft, closes_at: e.target.value })}
              data-testid="drive-closes"
            />
          </div>
          <div className="col-span-1">
            <Button onClick={create} data-testid="open-drive">
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Opening a new drive automatically closes any drive currently open.
        </p>
      </Card>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground bg-muted/30">
            <tr>
              <th className="p-3">Title</th>
              <th className="p-3">Status</th>
              <th className="p-3">Opened</th>
              <th className="p-3">Closes</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {drives.map((d) => (
              <tr key={d.id} data-testid={`drive-${d.id}`}>
                <td className="p-3">
                  <p className="font-medium">{d.title}</p>
                  {d.description && <p className="text-xs text-muted-foreground">{d.description}</p>}
                </td>
                <td className="p-3">
                  <Badge
                    variant={d.status === "open" ? "default" : "outline"}
                    className={
                      d.status === "open"
                        ? "bg-green-100 text-green-800 border-green-200"
                        : d.status === "invoiced"
                        ? "bg-blue-100 text-blue-800 border-blue-200"
                        : ""
                    }
                  >
                    {d.status}
                  </Badge>
                </td>
                <td className="p-3">{new Date(d.opens_at).toLocaleDateString()}</td>
                <td className="p-3">{new Date(d.closes_at).toLocaleDateString()}</td>
                <td className="p-3 text-right">
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="outline" onClick={() => select(d.id)}>
                      <FileText className="w-3 h-3 mr-1" /> Compile
                    </Button>
                    {d.status === "open" ? (
                      <Button size="sm" variant="outline" onClick={() => setStatus(d.id, "closed")}>
                        Close
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setStatus(d.id, "open")}>
                        Re-open
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {drives.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-muted-foreground">
                  No drives yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------
function CompilationTab({
  drives,
  selected,
  setSelected,
  compilation,
}: {
  drives: Drive[];
  selected: number | null;
  setSelected: (id: number) => void;
  compilation: Compilation | null;
}) {
  const downloadInvoice = () => {
    if (!selected) return;
    const url = `${import.meta.env.BASE_URL}api/central/v1/admin/stationery/invoice/${selected}`;
    const token = localStorage.getItem("teacher_token") ?? "";
    // We can't add headers to a window.open — so fetch + blob.
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.blob())
      .then((b) => {
        const u = URL.createObjectURL(b);
        const a = document.createElement("a");
        a.href = u;
        a.download = `kobeai-stationery-invoice-${selected}.pdf`;
        a.click();
        URL.revokeObjectURL(u);
      });
  };

  return (
    <div className="space-y-4">
      <Card className="p-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm">Drive</span>
          <select
            value={selected ?? ""}
            onChange={(e) => setSelected(Number(e.target.value))}
            className="border rounded-md px-2 py-1 text-sm"
            data-testid="drive-select"
          >
            {drives.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title} ({d.status})
              </option>
            ))}
          </select>
        </div>
        <Button onClick={downloadInvoice} disabled={!selected} data-testid="download-invoice">
          <Download className="w-4 h-4 mr-1" /> Download PDF invoice
        </Button>
      </Card>

      {!compilation && <p className="text-sm text-muted-foreground">Loading…</p>}
      {compilation && (
        <>
          <div className="grid grid-cols-3 gap-4">
            <Metric label="Schools" value={String(compilation.schools.length)} />
            <Metric label="Total units" value={compilation.grand_qty.toLocaleString()} />
            <Metric label="Revenue (TSh)" value={compilation.grand_revenue_tsh.toLocaleString()} />
          </div>

          <Card className="p-0 overflow-hidden">
            <h2 className="font-bold p-4 border-b flex items-center gap-2">
              <Building2 className="w-4 h-4" /> Per-school totals
            </h2>
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground bg-muted/30">
                <tr>
                  <th className="p-3">School</th>
                  <th className="p-3 text-right">Orders</th>
                  <th className="p-3 text-right">Units</th>
                  <th className="p-3 text-right">Revenue (TSh)</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {compilation.schools.map((s) => (
                  <tr key={s.tenant_id}>
                    <td className="p-3">{s.name}</td>
                    <td className="p-3 text-right">{s.orders}</td>
                    <td className="p-3 text-right">{s.qty.toLocaleString()}</td>
                    <td className="p-3 text-right">{s.revenue_tsh.toLocaleString()}</td>
                  </tr>
                ))}
                {compilation.schools.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-4 text-center text-muted-foreground">
                      No approved orders yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>

          <Card className="p-0 overflow-hidden">
            <h2 className="font-bold p-4 border-b flex items-center gap-2">
              <Package className="w-4 h-4" /> Per-item totals
            </h2>
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground bg-muted/30">
                <tr>
                  <th className="p-3">Item</th>
                  <th className="p-3 text-right">Qty</th>
                  <th className="p-3 text-right">Revenue</th>
                  <th className="p-3">Schools</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {compilation.items.map((i) => (
                  <tr key={i.item_id}>
                    <td className="p-3 font-medium">{i.item_name}</td>
                    <td className="p-3 text-right">{i.total_qty.toLocaleString()}</td>
                    <td className="p-3 text-right">TSh {i.total_revenue_tsh.toLocaleString()}</td>
                    <td className="p-3 text-xs text-muted-foreground">
                      {i.schools.map((s) => `${s.tenant_name} (${s.qty})`).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
    </Card>
  );
}
