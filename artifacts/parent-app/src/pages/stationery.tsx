import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { apiGet, apiPost } from "@/lib/api";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Plus,
  Minus,
  Check,
  Trash2,
  ShoppingBag,
  CheckCircle2,
  Clock,
} from "lucide-react";

// Stationery picker page.
//
// UX (matching watch flow): the user sees a scrollable list. They tap an
// item to open a quantity sheet (+/- with a checkmark). Once confirmed, the
// item disappears from the main list and shows up in the Cart with a count.
// They can re-open Cart to edit/remove (which puts the item back in the
// list). When they're happy, they pick a child and tap "Send order".

type Item = { id: number; name: string; category: string; unit: string; price_tsh: number };
type Drive = { id: number; title: string; description: string | null; closes_at: string };
type Child = { id: number; name: string; grade: string | null; student_code: string | null };
type ExistingOrder = {
  id: number;
  status: string;
  total_tsh: number;
  student_user_id: number;
  student_name: string;
  placed_by: string;
  items: { item_id: number; item_name: string; qty: number; line_total_tsh: number }[];
};

export default function StationeryPage() {
  const { token } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [drive, setDrive] = useState<Drive | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [children, setChildren] = useState<Child[]>([]);
  const [orders, setOrders] = useState<ExistingOrder[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedChildId, setSelectedChildId] = useState<number | null>(null);
  const [cart, setCart] = useState<Map<number, number>>(new Map());
  const [pickerItemId, setPickerItemId] = useState<number | null>(null);
  const [showCart, setShowCart] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) setLocation("/login");
  }, [token, setLocation]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [d, c, o] = await Promise.all([
          apiGet<{ drive: Drive | null; items: Item[] }>("/v1/parent/stationery/drive"),
          apiGet<{ children: Child[] }>("/v1/parent/children"),
          apiGet<{ orders: ExistingOrder[] }>("/v1/parent/stationery/orders"),
        ]);
        if (cancelled) return;
        setDrive(d.drive);
        setItems(d.items);
        setChildren(c.children);
        setOrders(o.orders);
        if (c.children.length > 0 && selectedChildId == null) {
          setSelectedChildId(c.children[0]!.id);
        }
      } catch (e) {
        toast({ title: "Couldn't load drive", description: (e as Error).message, variant: "destructive" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const visibleItems = useMemo(() => items.filter((i) => !cart.has(i.id)), [items, cart]);
  const cartTotal = useMemo(() => {
    let t = 0;
    cart.forEach((qty, id) => {
      const it = itemsById.get(id);
      if (it) t += it.price_tsh * qty;
    });
    return t;
  }, [cart, itemsById]);

  const setQty = (id: number, qty: number) => {
    setCart((prev) => {
      const next = new Map(prev);
      if (qty <= 0) next.delete(id);
      else next.set(id, qty);
      return next;
    });
  };

  const submit = async () => {
    if (!selectedChildId || cart.size === 0) return;
    setSubmitting(true);
    try {
      const lines = Array.from(cart.entries()).map(([item_id, qty]) => ({ item_id, qty }));
      await apiPost("/v1/parent/stationery/order", {
        student_user_id: selectedChildId,
        lines,
      });
      toast({ title: "Order sent", description: `Total TSh ${cartTotal.toLocaleString()}` });
      setCart(new Map());
      setShowCart(false);
      // Refresh orders
      const o = await apiGet<{ orders: ExistingOrder[] }>("/v1/parent/stationery/orders");
      setOrders(o.orders);
    } catch (e) {
      toast({ title: "Couldn't send order", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const approve = async (id: number) => {
    try {
      await apiPost(`/v1/parent/stationery/order/${id}/approve`, {});
      toast({ title: "Approved" });
      const o = await apiGet<{ orders: ExistingOrder[] }>("/v1/parent/stationery/orders");
      setOrders(o.orders);
    } catch (e) {
      toast({ title: "Couldn't approve", description: (e as Error).message, variant: "destructive" });
    }
  };

  const reject = async (id: number) => {
    try {
      await apiPost(`/v1/parent/stationery/order/${id}/reject`, {});
      toast({ title: "Rejected" });
      const o = await apiGet<{ orders: ExistingOrder[] }>("/v1/parent/stationery/orders");
      setOrders(o.orders);
    } catch (e) {
      toast({ title: "Couldn't reject", description: (e as Error).message, variant: "destructive" });
    }
  };

  const pickerItem = pickerItemId != null ? itemsById.get(pickerItemId) : null;

  return (
    <Layout>
      <div className="px-6 pt-12 pb-6 bg-primary text-white rounded-b-[40px] shadow-sm">
        <Link href="/dashboard">
          <button className="mb-4 flex items-center gap-1 text-sm text-white/80 hover:text-white">
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
        </Link>
        <h1 className="text-2xl font-bold">Stationery</h1>
        {drive ? (
          <>
            <p className="text-sm text-white/90 mt-1">{drive.title}</p>
            <p className="text-xs text-white/70">
              Closes {new Date(drive.closes_at).toLocaleDateString()}
            </p>
          </>
        ) : null}
      </div>

      <div className="px-6 -mt-4 relative z-20 space-y-4">
        {!drive && !loading && (
          <Card className="p-6 rounded-3xl border-gray-100 text-center text-sm text-gray-600">
            No stationery drive open right now. We'll notify you when the next
            one starts.
          </Card>
        )}

        {/* Pending orders awaiting parent approval */}
        {orders
          .filter((o) => o.status === "pending_parent_approval")
          .map((o) => (
            <Card key={o.id} className="p-5 rounded-3xl border-amber-200 bg-amber-50">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <p className="text-xs uppercase tracking-wide text-amber-700 font-bold">
                    Awaiting your approval
                  </p>
                  <p className="font-bold text-gray-900">{o.student_name}</p>
                  <p className="text-xs text-gray-600">
                    {o.placed_by === "teacher" ? "Submitted by teacher" : "Submitted from watch"}
                  </p>
                </div>
                <p className="text-lg font-bold">TSh {o.total_tsh.toLocaleString()}</p>
              </div>
              <ul className="text-sm space-y-1 mb-3">
                {o.items.map((it) => (
                  <li key={it.item_id} className="flex justify-between">
                    <span>
                      {it.qty}× {it.item_name}
                    </span>
                    <span className="text-gray-600">TSh {it.line_total_tsh.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button onClick={() => approve(o.id)} className="flex-1" data-testid={`approve-${o.id}`}>
                  <Check className="w-4 h-4 mr-1" /> Approve
                </Button>
                <Button variant="outline" onClick={() => reject(o.id)} data-testid={`reject-${o.id}`}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </Card>
          ))}

        {/* Approved (paid) summary */}
        {orders
          .filter((o) => o.status === "approved" || o.status === "packed")
          .map((o) => (
            <Card key={o.id} className="p-5 rounded-3xl border-green-200 bg-green-50">
              <div className="flex items-start justify-between mb-1">
                <div>
                  <p className="text-xs uppercase tracking-wide text-green-700 font-bold flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> {o.status === "packed" ? "Packed" : "Approved"}
                  </p>
                  <p className="font-bold text-gray-900">{o.student_name}</p>
                </div>
                <p className="text-lg font-bold">TSh {o.total_tsh.toLocaleString()}</p>
              </div>
              <p className="text-xs text-gray-600">
                {o.items.length} item{o.items.length === 1 ? "" : "s"}
              </p>
            </Card>
          ))}

        {/* Child picker */}
        {drive && children.length > 0 && (
          <Card className="p-4 rounded-3xl border-gray-100">
            <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">
              Ordering for
            </p>
            <div className="flex gap-2 flex-wrap">
              {children.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedChildId(c.id)}
                  data-testid={`child-${c.id}`}
                  className={`px-3 py-2 rounded-xl text-sm font-semibold transition ${
                    selectedChildId === c.id
                      ? "bg-primary text-white"
                      : "bg-gray-100 text-gray-700"
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </Card>
        )}

        {drive && children.length === 0 && (
          <Card className="p-5 rounded-3xl border-gray-100">
            <p className="text-sm text-gray-700 mb-3">
              You haven't linked any children yet. Add one to start ordering.
            </p>
            <Link href="/add-child">
              <Button className="w-full">Add a child</Button>
            </Link>
          </Card>
        )}

        {/* Cart pill */}
        {drive && children.length > 0 && (
          <button
            onClick={() => setShowCart(true)}
            data-testid="open-cart"
            className="w-full bg-white rounded-2xl border border-gray-100 p-4 flex items-center justify-between hover:bg-gray-50 transition"
          >
            <div className="flex items-center gap-2">
              <ShoppingBag className="w-5 h-5 text-primary" />
              <span className="font-semibold">
                Cart: {cart.size} item{cart.size === 1 ? "" : "s"}
              </span>
            </div>
            <span className="text-sm text-gray-600">
              TSh {cartTotal.toLocaleString()}
            </span>
          </button>
        )}

        {/* Item list (hides items already in cart, like the watch flow) */}
        {drive && (
          <Card className="p-2 rounded-3xl border-gray-100">
            {loading ? (
              <p className="text-center text-sm text-gray-500 py-6">Loading…</p>
            ) : visibleItems.length === 0 ? (
              <p className="text-center text-sm text-gray-500 py-6">
                All items added. Open cart to send.
              </p>
            ) : (
              <ul className="divide-y" data-testid="item-list">
                {visibleItems.map((it) => (
                  <li key={it.id}>
                    <button
                      onClick={() => setPickerItemId(it.id)}
                      data-testid={`pick-${it.id}`}
                      className="w-full flex items-center justify-between p-3 hover:bg-gray-50 rounded-xl text-left"
                    >
                      <div>
                        <p className="font-medium text-sm">{it.name}</p>
                        <p className="text-xs text-gray-500">
                          {it.category} · TSh {it.price_tsh.toLocaleString()}
                          {it.unit !== "each" ? `/${it.unit}` : ""}
                        </p>
                      </div>
                      <Plus className="w-4 h-4 text-primary" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>

      {/* Quantity picker overlay */}
      {pickerItem && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center"
          onClick={() => setPickerItemId(null)}
        >
          <div
            className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold">{pickerItem.name}</h2>
            <p className="text-sm text-gray-500">
              TSh {pickerItem.price_tsh.toLocaleString()} each
            </p>
            <QtyPicker
              initial={cart.get(pickerItem.id) ?? 1}
              onConfirm={(qty) => {
                setQty(pickerItem.id, qty);
                setPickerItemId(null);
              }}
              onCancel={() => setPickerItemId(null)}
            />
          </div>
        </div>
      )}

      {/* Cart drawer */}
      {showCart && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center"
          onClick={() => setShowCart(false)}
        >
          <div
            className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl p-6 space-y-4 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold">Your cart</h2>
            {cart.size === 0 && (
              <p className="text-sm text-gray-500">No items yet — pick from the list.</p>
            )}
            <ul className="space-y-2" data-testid="cart-list">
              {Array.from(cart.entries()).map(([id, qty]) => {
                const it = itemsById.get(id);
                if (!it) return null;
                return (
                  <li key={id} className="flex items-center justify-between gap-2 border-b pb-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{it.name}</p>
                      <p className="text-xs text-gray-500">
                        TSh {(it.price_tsh * qty).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" onClick={() => setQty(id, qty - 1)}>
                        <Minus className="w-3 h-3" />
                      </Button>
                      <span className="w-8 text-center font-bold">{qty}</span>
                      <Button size="sm" variant="outline" onClick={() => setQty(id, qty + 1)}>
                        <Plus className="w-3 h-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setQty(id, 0)}
                        data-testid={`remove-${id}`}
                      >
                        <Trash2 className="w-3 h-3 text-red-500" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {cart.size > 0 && (
              <>
                <div className="border-t pt-3 flex justify-between font-bold">
                  <span>Total</span>
                  <span>TSh {cartTotal.toLocaleString()}</span>
                </div>
                <Button
                  className="w-full h-12 rounded-2xl"
                  disabled={submitting || !selectedChildId}
                  onClick={submit}
                  data-testid="send-order"
                >
                  {submitting ? "Sending…" : "Send order"}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
}

function QtyPicker({
  initial,
  onConfirm,
  onCancel,
}: {
  initial: number;
  onConfirm: (qty: number) => void;
  onCancel: () => void;
}) {
  const [qty, setQty] = useState(Math.max(1, initial));
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-center gap-6">
        <Button
          variant="outline"
          size="lg"
          className="rounded-full w-14 h-14"
          onClick={() => setQty((q) => Math.max(1, q - 1))}
          data-testid="qty-minus"
        >
          <Minus className="w-6 h-6" />
        </Button>
        <span className="text-4xl font-bold w-16 text-center" data-testid="qty-value">
          {qty}
        </span>
        <Button
          variant="outline"
          size="lg"
          className="rounded-full w-14 h-14"
          onClick={() => setQty((q) => Math.min(1000, q + 1))}
          data-testid="qty-plus"
        >
          <Plus className="w-6 h-6" />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onConfirm(qty)} data-testid="qty-confirm">
          <Check className="w-4 h-4 mr-1" /> Add
        </Button>
      </div>
    </div>
  );
}
