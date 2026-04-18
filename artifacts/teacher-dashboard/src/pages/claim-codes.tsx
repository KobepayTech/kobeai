import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { KeyRound, Search, Copy, Check, Printer, Send } from "lucide-react";

// Teachers issue claim codes that parents type into the parent app to link
// to a student. Each student can have many *historical* codes but only one
// unconsumed at a time — issuing a new one expires the old one.

type Student = {
  id: number;
  name: string;
  student_code: string | null;
  grade: string | null;
  class_name: string | null;
};

type Code = {
  id: number;
  student_user_id: number;
  student_name: string;
  student_code: string | null;
  grade: string | null;
  code_prefix: string;
  consumed_at: string | null;
  expires_at: string | null;
  created_at: string;
};

export default function ClaimCodesPage() {
  const { toast } = useToast();
  const [students, setStudents] = useState<Student[]>([]);
  const [codes, setCodes] = useState<Code[]>([]);
  const [filter, setFilter] = useState("");
  const [issuing, setIssuing] = useState<number | null>(null);
  const [recent, setRecent] = useState<Map<number, { code: string; expires_at: string }>>(
    new Map(),
  );

  const refresh = async () => {
    const [s, c] = await Promise.all([
      apiGet<{ students: Student[] }>("/v1/teacher/stationery/students"),
      apiGet<{ codes: Code[] }>("/v1/teacher/claim-codes"),
    ]);
    setStudents(s.students);
    setCodes(c.codes);
  };

  useEffect(() => {
    refresh().catch((e) =>
      toast({ title: "Couldn't load", description: (e as Error).message, variant: "destructive" }),
    );
  }, []);

  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    return students.filter(
      (s) =>
        !q ||
        s.name.toLowerCase().includes(q) ||
        (s.student_code ?? "").toLowerCase().includes(q),
    );
  }, [students, filter]);

  const codeStatusByStudent = useMemo(() => {
    const m = new Map<number, "active" | "consumed" | "expired" | "none">();
    for (const c of codes) {
      const cur = m.get(c.student_user_id);
      if (cur === "active") continue;
      if (c.consumed_at) {
        if (!cur) m.set(c.student_user_id, "consumed");
        continue;
      }
      const expired = c.expires_at && new Date(c.expires_at).getTime() < Date.now();
      m.set(c.student_user_id, expired ? "expired" : "active");
    }
    return m;
  }, [codes]);

  const issue = async (s: Student) => {
    setIssuing(s.id);
    try {
      const r = await apiPost<{ code: string; expires_at: string }>(
        `/v1/teacher/students/${s.id}/claim-code`,
        {},
      );
      setRecent((p) => {
        const n = new Map(p);
        n.set(s.id, { code: r.code, expires_at: r.expires_at });
        return n;
      });
      toast({
        title: `Code for ${s.name}`,
        description: r.code,
      });
      await refresh();
    } catch (e) {
      toast({ title: "Couldn't issue", description: (e as Error).message, variant: "destructive" });
    } finally {
      setIssuing(null);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied" });
    } catch {
      toast({ title: "Couldn't copy", variant: "destructive" });
    }
  };

  const print = (s: Student, code: string) => {
    const w = window.open("", "_blank", "width=600,height=400");
    if (!w) return;
    w.document.write(`<!doctype html><html><head><title>Claim code — ${s.name}</title>
      <style>body{font-family:sans-serif;text-align:center;padding:48px}
      h1{color:#00A86B}.code{font-family:monospace;font-size:48px;letter-spacing:6px;margin:32px 0;color:#1A1A2E}
      .small{color:#666}</style></head><body>
      <h1>KobeAI</h1>
      <p>Claim code for <strong>${s.name}</strong></p>
      <p class="code">${code}</p>
      <p class="small">A parent can type this in the KobeAI Parent app to link to this child.</p>
      <p class="small">Code expires in 30 days.</p>
      </body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 300);
  };

  const sms = (s: Student, code: string) => {
    const body = encodeURIComponent(
      `KobeAI: Use this code to link to ${s.name} in the Parent app: ${code}`,
    );
    window.location.href = `sms:?body=${body}`;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <KeyRound className="w-6 h-6 text-primary" /> Parent Claim Codes
        </h1>
        <p className="text-sm text-muted-foreground">
          Issue a code for any student. Parents type this code into the Parent
          app to link to the child. One code per student at a time.
        </p>
      </div>

      <Card className="p-4 space-y-3">
        <div className="relative max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-3 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search by name or code…"
            className="pl-9"
            data-testid="search"
          />
        </div>
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="pb-2">Student</th>
              <th className="pb-2">Class / Grade</th>
              <th className="pb-2">Status</th>
              <th className="pb-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map((s) => {
              const status = codeStatusByStudent.get(s.id) ?? "none";
              const r = recent.get(s.id);
              return (
                <tr key={s.id} data-testid={`row-${s.id}`}>
                  <td className="py-2">
                    <p className="font-medium">{s.name}</p>
                    <p className="text-xs text-muted-foreground">{s.student_code ?? "—"}</p>
                  </td>
                  <td className="py-2">{s.class_name ?? s.grade ?? "—"}</td>
                  <td className="py-2">
                    {status === "active" && (
                      <Badge className="bg-amber-100 text-amber-800 border-amber-200">
                        Code outstanding
                      </Badge>
                    )}
                    {status === "consumed" && (
                      <Badge className="bg-green-100 text-green-800 border-green-200">
                        <Check className="w-3 h-3 mr-1" /> Linked
                      </Badge>
                    )}
                    {status === "expired" && <Badge variant="outline">Expired</Badge>}
                    {status === "none" && <Badge variant="outline">No code</Badge>}
                  </td>
                  <td className="py-2 text-right">
                    {r ? (
                      <div className="flex items-center justify-end gap-1">
                        <code className="bg-primary/10 text-primary px-2 py-1 rounded font-bold">
                          {r.code}
                        </code>
                        <Button size="icon" variant="outline" onClick={() => copy(r.code)}>
                          <Copy className="w-3 h-3" />
                        </Button>
                        <Button size="icon" variant="outline" onClick={() => print(s, r.code)}>
                          <Printer className="w-3 h-3" />
                        </Button>
                        <Button size="icon" variant="outline" onClick={() => sms(s, r.code)}>
                          <Send className="w-3 h-3" />
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => issue(s)}
                        disabled={issuing === s.id}
                        data-testid={`issue-${s.id}`}
                      >
                        {issuing === s.id ? "Issuing…" : status === "active" ? "Reissue" : "Issue code"}
                      </Button>
                    )}
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
