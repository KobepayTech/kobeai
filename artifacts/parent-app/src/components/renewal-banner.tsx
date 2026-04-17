import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { AlertTriangle, ChevronRight } from "lucide-react";

type RenewalNotification = {
  id: string;
  kind: "renewal_due";
  severity: "urgent" | "warning" | "info";
  child_id: string | null;
  child_name: string;
  student_code: string;
  amount_tsh: number;
  days_remaining: number;
  expires_at: string;
  title: string;
  body: string;
};

const SEVERITY_STYLES: Record<RenewalNotification["severity"], string> = {
  urgent: "bg-rose-50 border-rose-200 text-rose-900",
  warning: "bg-amber-50 border-amber-200 text-amber-900",
  info: "bg-sky-50 border-sky-200 text-sky-900",
};

const SEVERITY_ICON: Record<RenewalNotification["severity"], string> = {
  urgent: "text-rose-500",
  warning: "text-amber-500",
  info: "text-sky-500",
};

/**
 * Polls /v1/parent/notifications and renders an actionable banner per
 * expiring/expired child subscription. Tapping the banner deep-links into
 * /subscription so the parent can pay immediately.
 */
export function RenewalBanner() {
  const { token } = useAuth();
  const [, setLocation] = useLocation();
  const { data } = useQuery<{ notifications: RenewalNotification[] }>({
    queryKey: ["parent-notifications"],
    queryFn: async () => {
      const res = await fetch("/api/v1/parent/notifications", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!token,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const items = data?.notifications ?? [];
  if (items.length === 0) return null;

  return (
    <div className="space-y-2">
      {items.map((n) => (
        <button
          key={n.id}
          onClick={() => setLocation("/subscription")}
          data-testid={`banner-renewal-${n.student_code}`}
          className={`w-full text-left rounded-2xl border p-4 flex items-start gap-3 hover:shadow-sm transition-shadow ${SEVERITY_STYLES[n.severity]}`}
        >
          <AlertTriangle className={`w-5 h-5 mt-0.5 shrink-0 ${SEVERITY_ICON[n.severity]}`} />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm leading-tight">{n.title}</p>
            <p className="text-xs opacity-80 mt-0.5">
              Pay TSh {n.amount_tsh.toLocaleString()} via M-Pesa
            </p>
          </div>
          <ChevronRight className="w-5 h-5 mt-0.5 shrink-0 opacity-60" />
        </button>
      ))}
    </div>
  );
}
