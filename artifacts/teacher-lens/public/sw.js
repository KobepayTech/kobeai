/* K9 offline app shell. Never cache /api, auth, examination results or student images.
 * The browser stores queued photos separately in IndexedDB (uploadQueue.ts).
 * Only static versioned assets and the generic application shell are cached.
 */
const CACHE = "k9-teacher-static-v1";
const SCOPE = new URL(self.registration.scope);
const shell = new URL("./", SCOPE).href;
const staticAsset = (url) =>
  url.origin === SCOPE.origin &&
  url.pathname.startsWith(SCOPE.pathname + "assets/") &&
  /\.(?:js|css|woff2?|png|svg|webp|ico)$/.test(url.pathname);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // A first successful online visit installs the app shell for offline restart.
      const response = await fetch(shell, { cache: "no-store" });
      if (!response.ok) throw new Error("K9 shell not available for offline installation");
      await cache.put(shell, response);
    }).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      await Promise.all(keys.filter((key) => key.startsWith("k9-teacher-static-") && key !== CACHE)
        .map((key) => caches.delete(key)));
      await self.clients.claim();
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  if (url.pathname.includes("/api/") || url.pathname.includes("/auth/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          const cache = await caches.open(CACHE);
          await cache.put(shell, response.clone());
        }
        return response;
      } catch {
        const cached = await caches.match(shell, { cacheName: CACHE });
        return cached || Response.error();
      }
    })());
    return;
  }

  if (staticAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") await cache.put(request, response.clone());
      return response;
    })());
  }
});
