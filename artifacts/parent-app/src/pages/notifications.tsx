import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Bell, BellOff, ChevronLeft, Send } from "lucide-react";
import { disablePush, enablePush, getPushState, sendTestDigest, pushSupported } from "@/lib/push";

/**
 * Parent-facing notifications page. Lets the parent:
 *   - Enable/disable browser push (handles permission request internally).
 *   - Send a test daily digest to verify the pipeline end-to-end.
 *
 * The toggle reflects the actual subscription state, NOT the permission alone
 * — a parent can have permission "granted" but still no active subscription
 * (e.g. they cleared site data). We poll on mount + after every action.
 */
export default function NotificationsPage() {
  const [, setLocation] = useLocation();
  const { token } = useAuth();
  const [supported, setSupported] = useState(true);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLocation("/login");
      return;
    }
    void refresh();
  }, [token, setLocation]);

  async function refresh() {
    const state = await getPushState();
    setSupported(state.supported);
    setPermission(state.permission);
    setSubscribed(state.subscribed);
  }

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      if (next) await enablePush();
      else await disablePush();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const res = await sendTestDigest();
      if (res.sent === 0) {
        setError("No active subscriptions on file. Enable notifications first.");
      } else {
        setTestResult(`Sent ${res.sent} test notification${res.sent === 1 ? "" : "s"}. Check your phone!`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!token) return null;

  return (
    <Layout>
      <div className="p-6">
        <button onClick={() => setLocation("/profile")} className="flex items-center gap-1 text-sm text-gray-600 mb-4">
          <ChevronLeft className="w-4 h-4" /> Back
        </button>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Notifications</h1>
        <p className="text-gray-500 text-sm mb-6">Get a daily digest of your child's progress, sent straight to your phone.</p>

        {!supported && (
          <Card className="rounded-2xl border-amber-200 bg-amber-50 p-4 mb-4">
            <div className="text-sm text-amber-900">
              <strong>Not supported on this browser.</strong> Install the KobeAI parent app from your home screen, or open it in Chrome / Edge / Firefox to enable notifications.
            </div>
          </Card>
        )}

        <Card className="rounded-3xl border-gray-100 shadow-sm overflow-hidden mb-4">
          <div className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${subscribed ? "bg-emerald-50 text-emerald-600" : "bg-gray-50 text-gray-500"}`}>
                {subscribed ? <Bell className="w-5 h-5" /> : <BellOff className="w-5 h-5" />}
              </div>
              <div>
                <div className="font-medium text-gray-900">Daily digest</div>
                <div className="text-xs text-gray-500">Sent every day around 6 PM</div>
              </div>
            </div>
            <Switch checked={subscribed} onCheckedChange={toggle} disabled={!supported || busy} />
          </div>
          {permission === "denied" && (
            <div className="px-4 pb-4 text-xs text-rose-600">
              Notifications are blocked in your browser settings. Enable them for this site to subscribe.
            </div>
          )}
        </Card>

        {subscribed && (
          <Card className="rounded-2xl border-gray-100 shadow-sm p-4 mb-4">
            <div className="text-sm text-gray-700 mb-3">Want to see what the digest looks like? Send yourself a preview.</div>
            <Button onClick={sendTest} disabled={busy} variant="outline" className="w-full gap-2">
              <Send className="w-4 h-4" /> {busy ? "Sending…" : "Send test notification"}
            </Button>
          </Card>
        )}

        {error && (
          <Card className="rounded-2xl border-rose-200 bg-rose-50 p-4 mb-4 text-sm text-rose-700">{error}</Card>
        )}
        {testResult && (
          <Card className="rounded-2xl border-emerald-200 bg-emerald-50 p-4 mb-4 text-sm text-emerald-700">{testResult}</Card>
        )}
      </div>
    </Layout>
  );
}
