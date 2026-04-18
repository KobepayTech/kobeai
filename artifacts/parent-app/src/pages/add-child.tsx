import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { apiPost, apiGet } from "@/lib/api";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, KeyRound, Camera, Check } from "lucide-react";

// Linking uses one of two paths:
//   1) Type/paste a CLAIM CODE the school issued (printed on the report card).
//   2) SCAN a QR code shown briefly on the child's watch.
//
// Both POST to the same backend; the only difference is the request body.

type LinkedChild = { id: number; name: string; grade: string | null; student_code: string | null };

export default function AddChildPage() {
  const { token } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [tab, setTab] = useState<"code" | "scan">("code");
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
        <div className="grid grid-cols-2 gap-2 bg-white p-1 rounded-2xl shadow-sm">
          <button
            onClick={() => setTab("code")}
            data-testid="tab-code"
            className={`py-2 rounded-xl text-sm font-semibold transition ${
              tab === "code" ? "bg-primary text-white" : "text-gray-600"
            }`}
          >
            <KeyRound className="w-4 h-4 inline mr-1" /> Enter code
          </button>
          <button
            onClick={() => setTab("scan")}
            data-testid="tab-scan"
            className={`py-2 rounded-xl text-sm font-semibold transition ${
              tab === "scan" ? "bg-primary text-white" : "text-gray-600"
            }`}
          >
            <Camera className="w-4 h-4 inline mr-1" /> Scan watch QR
          </button>
        </div>

        {tab === "code" && (
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
        )}

        {tab === "scan" && <ScanTab onScanned={(t) => { setCode(t); setTab("code"); }} />}
      </div>
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// Camera-based QR scanner using the browser BarcodeDetector API where
// available (Chrome 83+). Falls back to a "paste the code" manual entry box
// for browsers without it (Safari iOS — until they ship BarcodeDetector).
// ---------------------------------------------------------------------------
function ScanTab({ onScanned }: { onScanned: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [pasteValue, setPasteValue] = useState("");

  useEffect(() => {
    setSupported("BarcodeDetector" in window);
  }, []);

  useEffect(() => {
    if (!supported) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    let raf = 0;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setStreaming(true);
        }
        // @ts-expect-error — BarcodeDetector not in TS lib yet
        const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
        const tick = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const results = await detector.detect(videoRef.current);
            if (results && results.length > 0) {
              const raw = results[0].rawValue as string;
              const token = extractToken(raw);
              if (token) {
                stopped = true;
                onScanned(token);
                return;
              }
            }
          } catch {
            // benign — keep scanning
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        setError((e as Error).message || "Camera not available");
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [supported, onScanned]);

  return (
    <Card className="p-6 rounded-3xl border-gray-100 space-y-4">
      <p className="text-sm text-gray-700">
        On your child's watch, open <strong>KobeAI → Link Parent</strong>. A QR
        code appears for 2 minutes — point your camera at it.
      </p>
      {supported === false ? (
        <div className="text-sm text-amber-700 bg-amber-50 p-3 rounded-xl">
          Your browser doesn't support in-app camera scanning. Read the code
          off the watch and paste it below.
        </div>
      ) : null}
      {error && (
        <div className="text-sm text-red-700 bg-red-50 p-3 rounded-xl">{error}</div>
      )}
      {supported && !error && (
        <div className="rounded-2xl overflow-hidden bg-black aspect-square relative">
          <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
          {!streaming && (
            <div className="absolute inset-0 flex items-center justify-center text-white text-sm">
              Starting camera…
            </div>
          )}
          <div className="absolute inset-8 border-2 border-primary rounded-2xl pointer-events-none" />
        </div>
      )}
      <div className="border-t pt-4">
        <p className="text-xs text-gray-500 mb-2">Or paste the token shown on the watch:</p>
        <div className="flex gap-2">
          <Input
            value={pasteValue}
            onChange={(e) => setPasteValue(e.target.value.toUpperCase())}
            placeholder="ABCD-EFGH-IJKL"
            className="font-mono uppercase"
          />
          <Button
            variant="outline"
            disabled={pasteValue.trim().length < 8}
            onClick={() => onScanned(pasteValue.trim())}
          >
            <Check className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

// QR may carry either the raw token or our JSON envelope { v, app, kind, t }.
function extractToken(raw: string): string | null {
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.t === "string") return j.t;
  } catch {
    // not JSON
  }
  // Fallback: any 8+ char token-shaped string
  const m = raw.match(/[A-Z0-9-]{8,}/i);
  return m ? m[0] : null;
}

// Pairing flow returns `token` for the manual entry box; the parent app
// hands it back to add-child via the `onScanned` callback.
export async function consumePairingToken(token: string): Promise<LinkedChild> {
  const r = await apiPost<{ ok: boolean; child: LinkedChild }>(
    "/v1/parent/children/pair",
    { token },
  );
  return r.child;
}

// Helper hook for other pages that want to list linked children.
export function useChildrenList() {
  return apiGet<{ children: LinkedChild[] }>("/v1/parent/children");
}
