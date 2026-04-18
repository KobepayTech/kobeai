import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Copy,
  Download,
  MessageCircle,
  Send,
  Printer,
  Smartphone,
  Apple,
} from "lucide-react";

// The deployed parent PWA lives at /parent/ on the same origin as the
// dashboard (one Replit deployment serves all artifacts via path-based
// routing). Bursars / school admins use this page to hand out the install
// link to every parent — no Play Store, no App Store, no APK.
function parentInstallUrl(): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://kobeai.tz";
  return `${origin}/parent/`;
}

const DEFAULT_MESSAGE = (school: string, link: string) =>
  `Hello! ${school} now uses KobeAI to track your child's learning, attendance and KP rewards.\n\n` +
  `Tap this link to install the parent app on your phone (no Play Store needed):\n${link}\n\n` +
  `On Android: tap "Install" when prompted.\nOn iPhone: tap Share, then "Add to Home Screen".`;

export default function ParentInstallPage() {
  const { toast } = useToast();
  const [school, setSchool] = useState("Karatu Secondary School");
  const [link] = useState(parentInstallUrl());
  const [qr, setQr] = useState<string>("");

  const message = useMemo(() => DEFAULT_MESSAGE(school, link), [school, link]);

  useEffect(() => {
    QRCode.toDataURL(link, {
      width: 512,
      margin: 1,
      color: { dark: "#1A1A2E", light: "#FFFFFF" },
      errorCorrectionLevel: "M",
    })
      .then(setQr)
      .catch(() => setQr(""));
  }, [link]);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `${what} copied to clipboard` });
    } catch {
      toast({
        title: "Copy failed",
        description: "Select and copy manually.",
        variant: "destructive",
      });
    }
  };

  const downloadQr = () => {
    if (!qr) return;
    const a = document.createElement("a");
    a.href = qr;
    a.download = `kobeai-parent-install-qr.png`;
    a.click();
  };

  const waUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
  const smsUrl = `sms:?body=${encodeURIComponent(message)}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Parent App Install Link</h1>
        <p className="text-sm text-muted-foreground">
          Send this link to every parent — they install the app straight from
          their browser. No app store, no APK file, no fees.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">The link</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                value={link}
                readOnly
                className="font-mono"
                data-testid="install-link"
              />
              <Button
                variant="outline"
                onClick={() => copy(link, "Link")}
                data-testid="copy-link"
              >
                <Copy className="w-4 h-4 mr-2" /> Copy
              </Button>
            </div>

            <div>
              <Label className="text-xs">School name (used in the message)</Label>
              <Input
                value={school}
                onChange={(e) => setSchool(e.target.value)}
                className="mt-1"
              />
            </div>

            <div>
              <Label className="text-xs">Message to parents</Label>
              <textarea
                value={message}
                readOnly
                className="mt-1 w-full h-36 rounded-md border border-input bg-background px-3 py-2 text-sm resize-none font-mono"
                data-testid="install-message"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => copy(message, "Message")}
              >
                <Copy className="w-4 h-4 mr-2" /> Copy message
              </Button>
              <a href={waUrl} target="_blank" rel="noopener noreferrer">
                <Button className="bg-emerald-500 hover:bg-emerald-600">
                  <MessageCircle className="w-4 h-4 mr-2" /> Share on WhatsApp
                </Button>
              </a>
              <a href={smsUrl}>
                <Button variant="outline">
                  <Send className="w-4 h-4 mr-2" /> Send via SMS
                </Button>
              </a>
              <Button variant="outline" onClick={() => window.print()}>
                <Printer className="w-4 h-4 mr-2" /> Print poster
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">QR code</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {qr ? (
              <img
                src={qr}
                alt="Parent app install QR"
                className="w-full rounded-lg border bg-white"
                data-testid="install-qr"
              />
            ) : (
              <div className="aspect-square bg-gray-100 rounded-lg animate-pulse" />
            )}
            <Button
              variant="outline"
              className="w-full"
              onClick={downloadQr}
              disabled={!qr}
            >
              <Download className="w-4 h-4 mr-2" /> Download PNG
            </Button>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Print this on the school noticeboard or include it in the school
              calendar — parents scan with their phone camera.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Smartphone className="w-4 h-4 text-emerald-600" /> Android
              parents
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2 text-muted-foreground">
            <p>
              When parents open the link in Chrome, a green{" "}
              <strong>"Install KobeAI"</strong> banner appears at the bottom.
              Tap <strong>Install</strong> — the icon lands on the Home Screen
              and opens fullscreen like a normal app.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Apple className="w-4 h-4" /> iPhone parents
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2 text-muted-foreground">
            <p>
              iOS Safari can't auto-prompt — parents tap the{" "}
              <strong>Share</strong> button at the bottom and choose{" "}
              <strong>Add to Home Screen</strong>. The app shows them this
              walkthrough automatically the first time they open the link.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
