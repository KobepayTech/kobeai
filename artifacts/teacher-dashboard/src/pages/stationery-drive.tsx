import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Package, Plus, Minus, Search, Send, Check, Clock, X } from "lucide-react";

// Teacher pre-fills stationery orders for any of their students. Each
// submission lands in a "pending parent approval" state, so the parent gets
// a notification and can approve/reject from the parent app.

type Item = { id: number; name: string; category: string; unit: string; price_tsh: number };
type Drive = { id: number; title: string; description: string | null; closes_at: string };
type Student = {
  id: number;
  name: string;
  student_code: string | null;
  grade: string | null;
  class_id: number | null;
  class_name: string | null;
};
type Order = {
  id: number;
  student_user_id: number;
  student_name: string;
  status: string;
  total_tsh: number;
  placed_by: string;
  class_name: string | null;
  created_at: string;
};

export default function StationeryDrivePage() {
  const { toast } = useToast();
  const [drive, setDrive] = useState<Drive | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [filter, setFilter] = useState("");
  const [classFilter, setClassFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Student | null>(null);
  const [cart, setCart] = useState<Map<number, number>>(new Map());
  const [submitting, setSubmitting] = useState(false);

  const refreshAll = async () => {
    const [d, s] = await Promise.all([
      apiGet<{ drive: Drive | null; items: Item[]; orders: Order[] }>(
        "/v1/teacher/stationery/drive",
      ),
      apiGet<{ students: Student[] }>("/v1/teacher/stationery/students"),
    ]);
    setDrive(d.drive);
    setItems(d.items);
    setOrders(d.orders);
    setStudents(s.students);
  };

  useEffect(() => {
    refreshAll().catch((e) =>
      toast({ title: "Couldn't load", description: (e as Error).message, variant: "destructive" }),
    );
  }, []);

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const ordersByStudent = useMemo(() => {
    const m = new Map<number, Order>();
    for (const o of orders) m.set(o.student_user_id, o);
    return m;
  }, [orders]);

  const classes = useMemo(() => {
    const c = new Set<string>();
    students.forEach((s) => s.class_name && c.add(s.class_name));
    return Array.from(c).sort();
  }, [students]);

  const filteredStudents = useMemo(() => {
    return students.filter((s) => {
      if (classFilter !== "all" && s.class_name !== classFilter) return false;
      if (filter) {
        const q = filter.toLowerCase();
        if (
          !s.name.toLowerCase().includes(q) &&
          !(s.student_code ?? "").toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
  }, [students, classFilter, filter]);

  const cartTotal = useMemo(() => {
    let t = 0;
    cart.forEach((qty, id) => {
      const it = itemsById.get(id);
      if (it) t += it.price_tsh * qty;
    });
    return t;
  }, [cart, itemsById]);

  const setQty = (id: number, qty: number) => {
    setCart((p) => {
      const n = new Map(p);
      if (qty <= 0) n.delete(id);
      else n.set(id, qty);
      return n;
    });
  };

  const send = async () => {
    if (!selected || cart.size === 0) return;
    setSubmitting(true);
    try {
      await apiPost("/v1/teacher/stationery/order", {
        student_user_id: selected.id,
        lines: Array.from(cart.entries()).map(([item_id, qty]) => ({ item_id, qty })),
      });
      toast({
        title: "Sent for parent approval",
        description: `${selected.name} — TSh ${cartTotal.toLocaleString()}`,
      });
      setCart(new Map());
      setSelected(null);
      await refreshAll();
    } catch (e) {
      toast({ title: "Couldn't send", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Package className="w-6 h-6 text-primary" /> Stationery Drive
        </h1>
        {drive ? (
          <p className="text-sm text-muted-foreground">
            {drive.title} · closes {new Date(drive.closes_at).toLocaleDateString()}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No drive open right now.</p>
        )}
      </div>

      {/* Order summary metrics */}
      {drive && (
        <div className="grid grid-cols-4 gap-4">
          <Metric label="Total orders" value={String(orders.length)} />
          <Metric
            label="Approved"
            value={String(orders.filter((o) => o.status === "approved" || o.status === "packed").length)}
          />
          <Metric
            label="Pending parent"
            value={String(orders.filter((o) => o.status === "pending_parent_approval").length)}
          />
          <Metric
            label="TSh approved"
            value={orders
              .filter((o) => o.status === "approved" || o.status === "packed")
              .reduce((s, o) => s + o.total_tsh, 0)
              .toLocaleString()}
          />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Student picker */}
        <Card className="p-4 space-y-3">
          <h2 className="font-bold">Pick a student</h2>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Search className="w-4 h-4 absolute left-3 top-3 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search by name or code…"
                className="pl-9"
                data-testid="search-student"
              />
            </div>
            <select
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              className="border rounded-md px-2 text-sm"
              data-testid="class-filter"
            >
              <option value="all">All classes</option>
              {classes.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="max-h-[420px] overflow-y-auto divide-y" data-testid="student-list">
            {filteredStudents.map((s) => {
              const existing = ordersByStudent.get(s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => setSelected(s)}
                  data-testid={`student-${s.id}`}
                  className={`w-full text-left p-3 hover:bg-muted rounded-md ${
                    selected?.id === s.id ? "bg-primary/5 ring-1 ring-primary" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm">{s.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {s.student_code ?? "—"}
                        {s.class_name ? ` · ${s.class_name}` : ""}
                      </p>
                    </div>
                    {existing && <OrderBadge status={existing.status} />}
                  </div>
                </button>
              );
            })}
            {filteredStudents.length === 0 && (
              <p className="text-sm text-muted-foreground p-4 text-center">No students match.</p>
            )}
          </div>
        </Card>

        {/* Cart / picker */}
        <Card className="p-4 space-y-3">
          {!selected ? (
            <p className="text-sm text-muted-foreground">
              Pick a student on the left to start an order.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-bold">{selected.name}</h2>
                  <p className="text-xs text-muted-foreground">
                    {selected.student_code} · {selected.class_name ?? "—"}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>

              <div className="max-h-[320px] overflow-y-auto border rounded-md divide-y">
                {items.map((it) => {
                  const qty = cart.get(it.id) ?? 0;
                  return (
                    <div key={it.id} className="flex items-center justify-between p-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{it.name}</p>
                        <p className="text-xs text-muted-foreground">
                          TSh {it.price_tsh.toLocaleString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon"
                          variant="outline"
                          onClick={() => setQty(it.id, qty - 1)}
                          disabled={qty === 0}
                        >
                          <Minus className="w-3 h-3" />
                        </Button>
                        <span className="w-6 text-center text-sm font-bold" data-testid={`qty-${it.id}`}>
                          {qty}
                        </span>
                        <Button
                          size="icon"
                          variant="outline"
                          onClick={() => setQty(it.id, qty + 1)}
                          data-testid={`plus-${it.id}`}
                        >
                          <Plus className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center justify-between border-t pt-3">
                <p className="font-bold">Total: TSh {cartTotal.toLocaleString()}</p>
                <Button onClick={send} disabled={submitting || cart.size === 0} data-testid="send-order">
                  <Send className="w-4 h-4 mr-1" />
                  {submitting ? "Sending…" : "Send to parent"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Parent will receive a notification to approve. They can edit before paying.
              </p>
            </>
          )}
        </Card>
      </div>

      {/* All orders for this drive */}
      <Card className="p-4">
        <h2 className="font-bold mb-3">All orders</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="pb-2">Student</th>
              <th className="pb-2">Class</th>
              <th className="pb-2">Placed by</th>
              <th className="pb-2">Status</th>
              <th className="pb-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {orders.map((o) => (
              <tr key={o.id} data-testid={`order-${o.id}`}>
                <td className="py-2">{o.student_name}</td>
                <td className="py-2">{o.class_name ?? "—"}</td>
                <td className="py-2 capitalize">{o.placed_by.replace("_", " ")}</td>
                <td className="py-2">
                  <OrderBadge status={o.status} />
                </td>
                <td className="py-2 text-right">TSh {o.total_tsh.toLocaleString()}</td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-muted-foreground">
                  No orders yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
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

function OrderBadge({ status }: { status: string }) {
  if (status === "approved")
    return (
      <Badge className="bg-green-100 text-green-800 border-green-200">
        <Check className="w-3 h-3 mr-1" /> Approved
      </Badge>
    );
  if (status === "packed")
    return <Badge className="bg-blue-100 text-blue-800 border-blue-200">Packed</Badge>;
  if (status === "pending_parent_approval")
    return (
      <Badge className="bg-amber-100 text-amber-800 border-amber-200">
        <Clock className="w-3 h-3 mr-1" /> Pending parent
      </Badge>
    );
  if (status === "rejected")
    return (
      <Badge className="bg-red-100 text-red-800 border-red-200">
        <X className="w-3 h-3 mr-1" /> Rejected
      </Badge>
    );
  return <Badge variant="outline">{status}</Badge>;
}
