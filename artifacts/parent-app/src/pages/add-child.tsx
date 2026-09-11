import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { apiPost, apiGet } from "@/lib/api";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft } from "lucide-react";

// Parents link a child by typing/pasting the CLAIM CODE the school issued
// (printed on the report card or sent over WhatsApp/SMS).

type LinkedChild = { id: number; name: string; grade: string | null; student_code: string | null };

export default function AddChildPage() {
  const { token } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) setLocation("/login");
  }, [token, setLocation]);

  const submitCode = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const r = await apiPost<{ ok: boolean; child: LinkedChild }>(
        "/v1/parent/children/claim",
        { code: trimmed },
      );
      toast({ title: `${r.child.name} linked`, description: "You'll see them on your dashboard." });
      setLocation("/dashboard");
    } catch (e) {
      toast({ title: "Couldn't link", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Layout>
      <div className="px-6 pt-12 pb-6 bg-primary text-white rounded-b-[40px] shadow-sm">
        <Link href="/dashboard">
          <button className="mb-4 flex items-center gap-1 text-sm text-white/80 hover:text-white">
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
        </Link>
        <h1 className="text-2xl font-bold">Add a child</h1>
        <p className="text-sm text-white/80 mt-1">
          Link your child's KobeAI account to your phone.
        </p>
      </div>

      <div className="px-6 -mt-4 relative z-20 space-y-4">
        <Card className="p-6 rounded-3xl border-gray-100 space-y-4">
          <div>
            <p className="text-sm text-gray-700">
              The school printed a claim code on your child's report card or
              sent it to you on WhatsApp. It looks like:{" "}
              <span className="font-mono text-primary">MARI-7K3P-9XQ2</span>
            </p>
          </div>
          <Input
            placeholder="MARI-7K3P-9XQ2"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            className="font-mono uppercase tracking-wider text-center text-lg h-14"
            data-testid="input-claim-code"
            autoCapitalize="characters"
            autoCorrect="off"
          />
          <Button
            className="w-full h-12 rounded-2xl"
            disabled={busy || code.trim().length < 8}
            onClick={submitCode}
            data-testid="submit-claim"
          >
            {busy ? "Linking..." : "Link child"}
          </Button>
          <p className="text-xs text-gray-500 text-center">
            You can add as many children as you have — each gets its own code.
          </p>
        </Card>
      </div>
    </Layout>
  );
}

// Helper hook for other pages that want to list linked children.
export function useChildrenList() {
  return apiGet<{ children: LinkedChild[] }>("/v1/parent/children");
}
