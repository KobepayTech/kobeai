import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useGetParentDashboard } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Printer, CheckCircle2, Clock, XCircle, Loader2, ArrowLeft } from "lucide-react";
import { apiGet } from "@/lib/api";

type Job = {
  id: number;
  job_ref: string;
  document_name: string;
  pages: number;
  printer_id: string;
  printer_name: string | null;
  status: "queued" | "downloading" | "printing" | "done" | "failed";
  status_message: string | null;
  created_at: string;
  completed_at: string | null;
};

function statusBadge(status: Job["status"]) {
  switch (status) {
    case "done":
      return { icon: CheckCircle2, label: "Printed", cls: "text-emerald-600 bg-emerald-50" };
    case "failed":
      return { icon: XCircle, label: "Failed", cls: "text-red-600 bg-red-50" };
    case "printing":
    case "downloading":
      return { icon: Loader2, label: status === "printing" ? "Printing" : "Downloading", cls: "text-blue-600 bg-blue-50" };
    default:
      return { icon: Clock, label: "Queued", cls: "text-amber-600 bg-amber-50" };
  }
}

function formatTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function PrintHistoryPage() {
  const [, setLocation] = useLocation();
  const { token } = useAuth();
  useEffect(() => { if (!token) setLocation("/login"); }, [token, setLocation]);

  const { data: dash, isLoading: loadingDash } = useGetParentDashboard({
    request: { headers: { Authorization: `Bearer ${token}` } },
  });

  const [activeChildId, setActiveChildId] = useState<string | null>(null);
  useEffect(() => {
    if (!activeChildId && dash?.children?.[0]) setActiveChildId(dash.children[0].id);
  }, [dash, activeChildId]);

  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [childName, setChildName] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!activeChildId || !token) return;
    setLoading(true);
    setErr(null);
    apiGet<{ child_name: string; jobs: Job[] }>(`/v1/parent/child/${activeChildId}/print-history`)
      .then((r) => { setJobs(r.jobs); setChildName(r.child_name); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [activeChildId, token]);

  if (!token) return null;

  const totalPages = jobs?.filter((j) => j.status === "done").reduce((s, j) => s + j.pages, 0) ?? 0;

  return (
    <Layout>
      <div className="px-6 pt-12 pb-6 bg-primary text-white rounded-b-[40px] shadow-sm relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/4"></div>
        <div className="relative z-10">
          <button
            onClick={() => setLocation("/print")}
            className="inline-flex items-center text-sm text-primary-foreground/80 mb-2"
            data-testid="button-back-to-print"
          >
            <ArrowLeft className="w-4 h-4 mr-1" /> Back
          </button>
          <h1 className="text-sm font-medium text-primary-foreground/80 mb-1">Activity log</h1>
          <h2 className="text-2xl font-bold">Print history</h2>
          <p className="text-primary-foreground/80 text-sm mt-2">
            {childName ? `${childName} — ` : ""}{totalPages} page{totalPages === 1 ? "" : "s"} printed
          </p>
        </div>
      </div>

      <div className="px-6 -mt-8 relative z-20 space-y-4">
        {loadingDash ? (
          <Card className="p-6 rounded-3xl shadow-sm border-none">
            <div className="h-10 bg-gray-100 animate-pulse rounded-xl"></div>
          </Card>
        ) : (dash?.children?.length ?? 0) > 1 ? (
          <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
            {dash!.children!.map((c) => {
              const active = c.id === activeChildId;
              return (
                <button
                  key={c.id}
                  onClick={() => setActiveChildId(c.id)}
                  data-testid={`tab-history-child-${c.id}`}
                  className={`shrink-0 px-4 py-2 rounded-full text-sm font-medium transition-colors ${active ? "bg-primary text-white" : "bg-white text-gray-600 border border-gray-200"}`}
                >
                  {c.name}
                </button>
              );
            })}
          </div>
        ) : null}

        <Card className="p-5 rounded-3xl shadow-sm border-gray-100">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-gray-400">
              <Loader2 className="w-5 h-5 mr-2 animate-spin" />Loading…
            </div>
          ) : err ? (
            <div className="py-6 text-center text-sm text-red-500">Couldn't load print history.</div>
          ) : !jobs || jobs.length === 0 ? (
            <div className="text-center py-10">
              <Printer className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500 text-sm">No prints yet.</p>
              <p className="text-gray-400 text-xs mt-1">Jobs your child sends from their watch will appear here.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {jobs.map((j) => {
                const badge = statusBadge(j.status);
                const Icon = badge.icon;
                const spinning = j.status === "printing" || j.status === "downloading";
                return (
                  <div key={j.id} className="py-4 flex items-start gap-3" data-testid={`row-print-job-${j.id}`}>
                    <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                      <Printer className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 truncate">{j.document_name}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {j.pages} page{j.pages === 1 ? "" : "s"} · {j.printer_name ?? j.printer_id}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">{formatTime(j.created_at)}</p>
                    </div>
                    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full ${badge.cls}`}>
                      <Icon className={`w-3.5 h-3.5 ${spinning ? "animate-spin" : ""}`} />
                      {badge.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </Layout>
  );
}
