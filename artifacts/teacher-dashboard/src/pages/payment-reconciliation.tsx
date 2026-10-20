import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiErrorText } from "@/lib/api";
import { Button } from "@/components/ui/button";
type Payment = {
  id: number;
  tenant_id: number;
  student_name: string;
  student_code: string;
  amount_tsh: number;
  months: number;
  status: string;
  provider_status: string;
  mpesa_receipt: string | null;
  last_error: string | null;
};
export default function PaymentReconciliation() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const data = useQuery({
    queryKey: ["palmpesa-reconciliation"],
    queryFn: () =>
      apiGet<{ payments: Payment[] }>("/central/v1/admin/palmpesa"),
    refetchInterval: 15000,
  });
  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-bold">PalmPesa subscription payments</h1>
      <p>
        Verified payments activate subscriptions once. Recheck queries the
        existing order; it does not create another charge.
      </p>
      {(error || data.error) && (
        <p role="alert" className="text-red-700">
          {error || apiErrorText(data.error)}
        </p>
      )}
      {data.isLoading && <p>Loading payments…</p>}
      <div className="overflow-auto">
        <table className="w-full text-left">
          <thead>
            <tr>
              {[
                "Payment",
                "School / student",
                "Amount",
                "Status",
                "Receipt / issue",
                "Action",
              ].map((x) => (
                <th className="p-3" key={x}>
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.data?.payments.map((p) => (
              <tr className="border-t" key={p.id}>
                <td className="p-3">#{p.id}</td>
                <td className="p-3">
                  School {p.tenant_id} · {p.student_name} ({p.student_code})
                </td>
                <td className="p-3">
                  TZS {p.amount_tsh.toLocaleString()} / {p.months} months
                </td>
                <td className="p-3">
                  {p.status} · {p.provider_status}
                </td>
                <td className="p-3">
                  {p.mpesa_receipt || p.last_error || "Awaiting confirmation"}
                </td>
                <td className="p-3">
                  <Button
                    disabled={busy || p.status === "success"}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        await apiPost(
                          `/central/v1/admin/palmpesa/${p.id}/recheck`,
                          {},
                        );
                        await qc.invalidateQueries({
                          queryKey: ["palmpesa-reconciliation"],
                        });
                      } catch (e) {
                        setError(apiErrorText(e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Recheck order
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
