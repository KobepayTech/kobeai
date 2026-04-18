import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useGetParentDashboard } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { FileText, Printer, BookOpen, Loader2, Clock } from "lucide-react";
import { apiGet } from "@/lib/api";
import { Link } from "wouter";

type Doc = {
  id: number;
  name: string;
  subject: string;
  pages: number;
  size_kb: number;
  assigned_at: string;
};

export default function PrintPage() {
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

  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [childName, setChildName] = useState<string>("");
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!activeChildId || !token) return;
    setLoadingDocs(true);
    setErr(null);
    apiGet<{ child_name: string; documents: Doc[] }>(`/v1/parent/child/${activeChildId}/documents`)
      .then((r) => { setDocs(r.documents); setChildName(r.child_name); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoadingDocs(false));
  }, [activeChildId, token]);

  if (!token) return null;

  return (
    <Layout>
      <div className="px-6 pt-12 pb-6 bg-primary text-white rounded-b-[40px] shadow-sm relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/4"></div>
        <div className="relative z-10">
          <h1 className="text-sm font-medium text-primary-foreground/80 mb-1">Tap-to-print</h1>
          <h2 className="text-2xl font-bold">Assigned documents</h2>
          <p className="text-primary-foreground/80 text-sm mt-2">What your child can print from their watch.</p>
          <Link
            href="/print/history"
            className="inline-flex items-center gap-1.5 mt-3 text-xs font-medium text-white/90 hover:text-white bg-white/15 hover:bg-white/25 px-3 py-1.5 rounded-full transition-colors"
            data-testid="link-print-history"
          >
            <Clock className="w-3.5 h-3.5" />
            View print history
          </Link>
        </div>
      </div>

      <div className="px-6 -mt-8 relative z-20 space-y-4">
        {loadingDash ? (
          <Card className="p-6 rounded-3xl shadow-sm border-none"><div className="h-10 bg-gray-100 animate-pulse rounded-xl"></div></Card>
        ) : (dash?.children?.length ?? 0) > 1 ? (
          <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
            {dash!.children!.map((c) => {
              const active = c.id === activeChildId;
              return (
                <button
                  key={c.id}
                  onClick={() => setActiveChildId(c.id)}
                  data-testid={`tab-child-${c.id}`}
                  className={`shrink-0 px-4 py-2 rounded-full text-sm font-medium transition-colors ${active ? "bg-primary text-white" : "bg-white text-gray-600 border border-gray-200"}`}
                >
                  {c.name}
                </button>
              );
            })}
          </div>
        ) : null}

        <Card className="p-5 rounded-3xl shadow-sm border-gray-100">
          {loadingDocs ? (
            <div className="flex items-center justify-center py-10 text-gray-400">
              <Loader2 className="w-5 h-5 mr-2 animate-spin" />Loading…
            </div>
          ) : err ? (
            <div className="py-6 text-center text-sm text-red-500">Couldn't load documents.</div>
          ) : !docs || docs.length === 0 ? (
            <div className="text-center py-10">
              <BookOpen className="w-12 h-12 mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500 text-sm">No documents assigned to {childName || "this child"}'s class yet.</p>
              <p className="text-gray-400 text-xs mt-1">Teachers upload PDFs and assign them to a class. They show up here automatically.</p>
            </div>
          ) : (
            <div className="space-y-3" data-testid="documents-list">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm text-gray-500">
                  {docs.length} document{docs.length === 1 ? "" : "s"} for {childName}
                </p>
              </div>
              {docs.map((d) => (
                <div key={d.id} className="flex items-start gap-3 p-3 rounded-2xl bg-gray-50 hover:bg-gray-100 transition-colors" data-testid={`doc-${d.id}`}>
                  <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <FileText className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{d.name}</p>
                    <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
                      <span className="px-2 py-0.5 rounded-full bg-white border border-gray-200">{d.subject}</span>
                      <span>{d.pages} page{d.pages === 1 ? "" : "s"}</span>
                      <span>·</span>
                      <span>{d.size_kb} KB</span>
                    </div>
                  </div>
                  <Printer className="w-5 h-5 text-gray-300 mt-1.5" />
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-4 rounded-3xl shadow-sm border-gray-100 bg-primary/5">
          <p className="text-xs text-gray-600 leading-relaxed">
            <span className="font-semibold text-primary">How it works:</span> your child taps their watch on a tap-box, picks one of these documents, and the school printer prints it. No paper goes home until they ask for it.
          </p>
        </Card>
      </div>
    </Layout>
  );
}
