import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Bot, CalendarDays, Phone, Send, Sparkles } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Event = { id: number; title: string; description: string | null; event_type: string; starts_at: string; ends_at: string | null; location: string | null; };
type Child = { student_code: string; student_name: string | null; plan: string; status: string; expires_at: string | null };

export default function MiniK9Page() {
  const [, setLocation] = useLocation();
  const { token } = useAuth();
  const [message, setMessage] = useState("");
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => { if (!token) setLocation("/login"); }, [token, setLocation]);
  const { data } = useQuery({
    queryKey: ["mini-k9-overview"],
    queryFn: () => apiGet<{ children: Child[]; upcoming: Event[] }>("/v1/parent/k9/overview"),
    enabled: !!token,
  });
  async function askK9() {
    if (!message.trim() || sending) return;
    setSending(true); setAnswer("");
    try {
      const r = await fetch("/api/v1/parent/k9/chat", {
        method: "POST", headers: { "content-type": "application/json", Authorization: \`Bearer \${token}\` },
        body: JSON.stringify({ message }),
      });
      const b = await r.json();
      setAnswer(r.ok ? b.answer : (b.error ?? "Mini K9 could not answer right now."));
    } finally { setSending(false); }
  }
  async function requestCall() {
    const child = data?.children?.[0];
    if (!child) return setAnswer("Link a child first.");
    const phone = window.prompt("Phone number for Mini K9 to call");
    if (!phone) return;
    const r = await fetch("/api/v1/parent/k9/call", {
      method: "POST", headers: { "content-type": "application/json", Authorization: \`Bearer \${token}\` },
      body: JSON.stringify({ phone, student_code: child.student_code, reason: "Parent requested a Mini K9 school update call" }),
    });
    const b = await r.json();
    setAnswer(r.ok ? b.message : (b.error ?? "Call request failed."));
  }
  if (!token) return null;
  return (
    <Layout>
      <div className="px-6 pt-10 pb-8 bg-primary text-white rounded-b-[36px]">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-white/15 flex items-center justify-center"><Bot className="w-6 h-6" /></div>
          <div><p className="text-xs uppercase tracking-wide text-white/70">Parent assistant</p><h1 className="text-2xl font-bold">Mini K9</h1></div>
        </div>
        <p className="mt-3 text-sm text-white/80">Your window into your child's boarding-school schedule and learning journey.</p>
      </div>
      <div className="px-5 -mt-5 relative space-y-4 pb-8">
        <Card className="p-5 rounded-3xl shadow-sm">
          <div className="flex items-center gap-2 font-semibold"><Sparkles className="w-4 h-4 text-primary" /> Ask Mini K9</div>
          <div className="flex gap-2 mt-3">
            <Input value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void askK9(); }} placeholder="How is my child doing this week?" />
            <Button onClick={() => void askK9()} disabled={sending || !message.trim()} size="icon"><Send className="w-4 h-4" /></Button>
          </div>
          {answer && <div className="mt-3 rounded-2xl bg-gray-50 p-4 text-sm whitespace-pre-wrap">{answer}</div>}
        </Card>
        <Card className="p-5 rounded-3xl shadow-sm">
          <div className="flex items-center gap-2 font-semibold"><CalendarDays className="w-4 h-4 text-primary" /> School calendar</div>
          <div className="mt-3 space-y-3">
            {(data?.upcoming ?? []).slice(0, 8).map(e => (
              <div key={e.id} className="border-b last:border-0 pb-3 last:pb-0">
                <div className="font-medium">{e.title}</div>
                <div className="text-xs text-gray-500">{new Date(e.starts_at).toLocaleString()} {e.location ? \` · \${e.location}\` : ""}</div>
                {e.description && <div className="text-xs text-gray-600 mt-1">{e.description}</div>}
              </div>
            ))}
            {!data?.upcoming?.length && <p className="text-sm text-gray-500">No upcoming school events yet.</p>}
          </div>
        </Card>
        <Card className="p-5 rounded-3xl shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center"><Phone className="w-5 h-5 text-primary" /></div>
            <div className="flex-1"><div className="font-semibold">Mini K9 voice call</div><p className="text-xs text-gray-500">Active Premium only. Calls are opt-in.</p></div>
          </div>
          <Button onClick={() => void requestCall()} variant="outline" className="w-full mt-4 rounded-xl">Request a call</Button>
        </Card>
      </div>
    </Layout>
  );
}
