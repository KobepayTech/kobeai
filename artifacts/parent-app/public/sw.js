// KobeAI parent PWA — service worker.
//
// Two responsibilities:
//   1) Web push notifications (VAPID, see /api/v1/parent/push/*).
//   2) Lightweight offline shell so the app opens even with no network.
//      We use a network-first strategy for HTML navigations (so updates ship
//      immediately when online) with a cached fallback when offline. Static
//      assets (JS/CSS/icons) use cache-first since Vite fingerprints filenames.
//
// Bumping CACHE_VERSION invalidates the old cache on activate. Do this on
// every release that ships UI changes you want offline users to see.

const CACHE_VERSION = "kobeai-parent-v2";
const APP_SHELL = ["./", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png", "./favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Best-effort precache — failures here must NOT block install (some
      // assets may 404 on a cold start before the build is fully copied).
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {}),
        ),
      ),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Never cache API calls — they must always hit the network.
  if (url.pathname.includes("/api/")) return;
  // Don't intercept cross-origin (fonts, etc.) — let the browser handle.
  if (url.origin !== self.location.origin) return;

  // Navigation (HTML) requests: network-first, fall back to cached shell.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          // Fall back to the scope root (the SPA entrypoint).
          const root = await caches.match("./");
          return root ?? new Response("Offline", { status: 503 });
        }),
    );
    return;
  }

  // Static assets: cache-first with background revalidation.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchAndUpdate = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchAndUpdate;
    }),
  );
});

// ---------------------------------------------------------------------------
// Web push (unchanged contract)
// ---------------------------------------------------------------------------
self.addEventListener("push", (event) => {
  let payload = { title: "KobeAI", body: "You have a new update", url: "/", tag: "kobeai" };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      badge: "icon-192.png",
      icon: "icon-192.png",
      data: { url: payload.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url ?? "/";
  const baseUrl = self.registration.scope; // ends in trailing slash
  const url = new URL(targetUrl.replace(/^\//, ""), baseUrl).toString();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(baseUrl) && "focus" in client) {
          client.navigate?.(url).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
