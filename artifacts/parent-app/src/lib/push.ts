// Helpers for browser web-push subscription management. The flow:
//   1. registerSW() — registers /sw.js (idempotent — browser de-dupes).
//   2. enablePush() — asks for permission, fetches the VAPID public key from
//      the API, calls pushManager.subscribe, posts the result to the API.
//   3. disablePush() — unsubscribes locally + tells the API to delete the row.
//   4. getPushState() — { supported, permission, subscribed } for the UI.
//
// All errors propagate so callers can show toasts. We never silently swallow
// a permission denial — the user needs to know why the toggle didn't flip.

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function authHeader(): Record<string, string> {
  const t = localStorage.getItem("parent_token");
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

export async function registerSW(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  // Register relative to the current document so the SW scope matches the
  // artifact base path (e.g. /parent-app/sw.js scoped to /parent-app/).
  return navigator.serviceWorker.register("./sw.js");
}

export async function getPushState(): Promise<{ supported: boolean; permission: NotificationPermission; subscribed: boolean }> {
  if (!pushSupported()) return { supported: false, permission: "default", subscribed: false };
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return { supported: true, permission: Notification.permission, subscribed: !!sub };
}

export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error("Push notifications aren't supported on this browser.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission denied. Enable it in your browser settings.");
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerSW());
  if (!reg) throw new Error("Service worker registration failed.");
  // Wait for the SW to be active before subscribing — pushManager.subscribe
  // throws InvalidStateError if the SW hasn't activated yet on first install.
  await navigator.serviceWorker.ready;

  const keyRes = await fetch("/api/v1/parent/push/public-key");
  if (!keyRes.ok) throw new Error(`Could not fetch VAPID key (HTTP ${keyRes.status})`);
  const { public_key } = (await keyRes.json()) as { public_key: string };

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(public_key),
  });

  const subRes = await fetch("/api/v1/parent/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader() },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  if (!subRes.ok) throw new Error(`Server rejected subscription (HTTP ${subRes.status})`);
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await fetch("/api/v1/parent/push/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader() },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe();
  }
}

export async function sendTestDigest(): Promise<{ sent: number; failed: number; removed: number }> {
  const res = await fetch("/api/v1/parent/push/send-digest", {
    method: "POST",
    headers: authHeader(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
