import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "@/lib/api";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
type Child = {
  id: number;
  name: string;
  grade: string;
  printing_funds_tsh: number;
  reserved_tsh: number;
  monthly_limit_tsh: number | null;
  automatic_enabled: boolean;
};
type Pack = {
  id: number;
  student_id: number;
  exam_id: number;
  subject: string;
  title: string;
  kind: string;
  status: string;
  cost_tsh: number;
  hold_reason: string | null;
  collected_at: string | null;
};
export default function SchoolServices() {
  const { token } = useAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const data = useQuery({
    queryKey: ["school-services"],
    queryFn: () =>
      apiGet<{ students: Child[]; packs: Pack[]; extended_cost_tsh: number }>(
        "/v1/parent/school-services",
      ),
    enabled: !!token,
    refetchInterval: 15000,
  });
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["school-services"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again");
    } finally {
      setBusy(false);
    }
  }
  if (!token)
    return (
      <Layout>
        <div className="p-6">
          <Link href="/login">Sign in to view school services</Link>
        </div>
      </Layout>
    );
  return (
    <Layout>
      <div className="p-6 space-y-5">
        <h1 className="text-2xl font-bold">School services</h1>
        <p>Manage printing allowances and see your child's learning packs.</p>
        <Link href="/subscription" className="underline block">
          Pay K9 subscription with PalmPesa
        </Link>
        <p className="text-sm">
          Printing funds below are held by the school office. Live Kobepay
          pocket-money connection is pending.
        </p>
        {(error || data.error) && (
          <p role="alert" className="text-red-700">
            {error || "Unable to load school services"}
          </p>
        )}
        {data.isLoading && <p>Loading…</p>}
        {data.data?.students.map((c) => (
          <Card key={c.id} className="p-5 space-y-3">
            <h2 className="font-bold">
              {c.name} · {c.grade}
            </h2>
            <p>
              Available for printing: TZS{" "}
              {(c.printing_funds_tsh - c.reserved_tsh).toLocaleString()}
            </p>
            <p className="text-sm">
              Held for queued jobs: TZS {c.reserved_tsh.toLocaleString()}
            </p>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const raw = String(f.get("limit") ?? "");
                void act(() =>
                  apiPost(`/v1/parent/school-services/${c.id}/allowance`, {
                    monthly_limit_tsh: raw === "" ? null : Number(raw),
                    automatic_enabled: f.get("enabled") === "on",
                  }),
                );
              }}
            >
              <label className="block">
                Monthly printing limit (TZS)
                <input
                  className="border p-2 w-full rounded"
                  name="limit"
                  type="number"
                  min="0"
                  max="1000000"
                  defaultValue={c.monthly_limit_tsh ?? ""}
                  placeholder="No limit"
                />
              </label>
              <label className="block">
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={c.automatic_enabled}
                />{" "}
                Allow automatic printing
              </label>
              <p className="text-xs">
                Blank means no monthly cap. Zero pauses spending. Changes affect
                unsent jobs; sheets already with the printer may complete.
              </p>
              <Button disabled={busy}>Save allowance</Button>
            </form>
            <h3 className="font-semibold pt-3">Learning packs</h3>
            {data
              .data!.packs.filter((p) => p.student_id === c.id)
              .map((p) => (
                <div key={p.id} className="border-t py-3 space-y-2">
                  <p className="font-medium">
                    {p.subject} · {p.title}
                  </p>
                  <p>
                    {p.kind} · {p.status.replaceAll("_", " ")} · TZS{" "}
                    {p.cost_tsh || "Price pending"}
                  </p>
                  {p.hold_reason && (
                    <p className="text-amber-800">{p.hold_reason}</p>
                  )}
                  {p.status === "printed" && (
                    <p>Ready to collect from the library or stationery.</p>
                  )}
                  {p.collected_at && (
                    <p className="text-sm">
                      Collected: {new Date(p.collected_at).toLocaleString()}
                    </p>
                  )}
                  {p.kind === "quick" && (
                    <Button
                      variant="outline"
                      disabled={
                        busy ||
                        data.data!.packs.some(
                          (x) =>
                            x.student_id === p.student_id &&
                            x.exam_id === p.exam_id &&
                            x.kind === "extended",
                        )
                      }
                      onClick={() =>
                        act(() =>
                          apiPost(
                            `/v1/parent/school-services/packs/${p.id}/extended`,
                            { accepted_cost_tsh: data.data!.extended_cost_tsh },
                          ),
                        )
                      }
                    >
                      Request longer pack · TZS {data.data!.extended_cost_tsh}
                    </Button>
                  )}
                </div>
              ))}
          </Card>
        ))}
      </div>
    </Layout>
  );
}
