import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Download, Share, X, Smartphone } from "lucide-react";

// Chromium fires this — Safari does not, so we render a manual iOS sheet.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "kobeai.install.dismissed";
const DISMISS_HOURS = 72;

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPadOS reports as Mac — detect via touch points.
  return (
    /iPhone|iPad|iPod/i.test(ua) ||
    (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)
  );
}

function recentlyDismissed(): boolean {
  try {
    const ts = localStorage.getItem(DISMISS_KEY);
    if (!ts) return false;
    return Date.now() - Number(ts) < DISMISS_HOURS * 3600 * 1000;
  } catch {
    return false;
  }
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosSheet, setIosSheet] = useState(false);
  const [installed, setInstalled] = useState(isStandalone());

  useEffect(() => {
    if (installed) return;
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [installed]);

  if (installed) return null;
  if (recentlyDismissed()) return null;

  // iOS Safari: surface a help button after 4s on first paint.
  const showIos = isIos() && !deferred;

  if (!deferred && !showIos) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    setDeferred(null);
    setIosSheet(false);
  };

  const accept = async () => {
    if (deferred) {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome !== "accepted") dismiss();
      setDeferred(null);
      return;
    }
    if (showIos) setIosSheet(true);
  };

  return (
    <>
      <div
        className="fixed left-3 right-3 bottom-3 z-50 rounded-2xl shadow-2xl border border-emerald-100 bg-white p-3 flex items-center gap-3"
        data-testid="install-prompt-banner"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }}
      >
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "linear-gradient(135deg,#00A86B,#008A57)" }}
        >
          <Smartphone className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold leading-tight">Install KobeAI</div>
          <div className="text-[11px] text-gray-500 leading-tight mt-0.5">
            Add to your Home Screen — opens like a regular app, no Play Store needed.
          </div>
        </div>
        <Button
          size="sm"
          onClick={accept}
          className="h-9 px-3 shrink-0"
          data-testid="install-prompt-cta"
        >
          {deferred ? (
            <>
              <Download className="w-4 h-4 mr-1" /> Install
            </>
          ) : (
            "How"
          )}
        </Button>
        <button
          aria-label="Dismiss"
          onClick={dismiss}
          className="text-gray-400 hover:text-gray-600 p-1"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <Sheet open={iosSheet} onOpenChange={setIosSheet}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader>
            <SheetTitle>Install on iPhone / iPad</SheetTitle>
          </SheetHeader>
          <ol className="mt-4 space-y-3 text-sm">
            <li className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold flex items-center justify-center shrink-0">
                1
              </span>
              <span>
                Tap the <Share className="w-4 h-4 inline -mt-0.5 mx-1" /> Share
                button at the bottom of Safari.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold flex items-center justify-center shrink-0">
                2
              </span>
              <span>
                Scroll down and tap <strong>Add to Home Screen</strong>.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold flex items-center justify-center shrink-0">
                3
              </span>
              <span>
                Confirm the name "KobeAI" and tap <strong>Add</strong>. The icon
                will appear on your Home Screen — open it from there to use it
                fullscreen.
              </span>
            </li>
          </ol>
          <Button onClick={dismiss} className="w-full mt-5 h-11 rounded-xl">
            Got it
          </Button>
        </SheetContent>
      </Sheet>
    </>
  );
}
