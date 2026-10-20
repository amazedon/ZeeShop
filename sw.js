// ZeeShop — basic service worker for PWA installability and offline shell caching
// v4 = the service worker no longer caches API data (see the fetch handler). v3 = new app icon (icons are cached cache-first, so they only change when this name changes). Earlier, v2: the old worker kept sync-engine.js cache-first FOREVER, so phones never received sync fixes.
// Bump this number again whenever you want every device to drop its cached files.
const CACHE_NAME = "zeeshop-cache-v4";
const CORE_ASSETS = [
  "/app.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Network-first for navigation/HTML so users always get fresh app logic when online;
// fall back to cache when offline. Cache-first for static assets.
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // The service worker only ever handles this site's OWN GET requests (pages, scripts, icons). Everything else —
  // calls to Supabase, Squad, Flutterwave, Termii and any POST — goes straight to the network, untouched.
  // Previously every request passed through the cache-first rule below, so a data request such as
  // /rest/v1/shops?... was answered from the first copy ever saved and NEVER refreshed: the same device kept
  // showing old shop settings while another device (with no saved copy) showed the new ones.
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/app.html")))
    );
    return;
  }

  // App code (JS/CSS/HTML such as sync-engine.js): network-first, so a deployed fix reaches phones the next time they
  // are online; the cached copy is used only when offline. Everything else (icons, images, fonts): cache-first.
  const url = new URL(request.url);
  const isAppCode = url.origin === self.location.origin && /\.(js|css|html|json)$/.test(url.pathname);
  if (isAppCode) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      return (
        cached ||
        fetch(request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
      );
    })
  );
});

/* ============================================================
   PUSH NOTIFICATIONS
   ============================================================ */
self.addEventListener("push", (event) => {
  let data = { title: "ZeeShop", body: "You have a new update.", url: "/app.html" };
  try{ if(event.data) data = { ...data, ...event.data.json() }; }catch(e){ /* fall back to defaults */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/app.html" }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/app.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes("app.html") && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

/* ============================================================
   BACKGROUND SYNC
   ============================================================
   Chrome/Android only (no iOS Safari support) — lets a pending sync
   queue flush even if the app is closed, not just while it's open.
   The actual queue logic lives in sync-engine.js (page context, since
   it needs localStorage) — this just asks any open/recently-open page
   to run it. If no page responds in time, the normal in-app sync
   (on load, on reconnect) still covers it the next time it's opened.
   ============================================================ */
self.addEventListener("sync", (event) => {
  if (event.tag === "zeeshop-flush-sync-queue") {
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
        clientList.forEach((client) => client.postMessage({ type: "ZEESHOP_FLUSH_SYNC_QUEUE" }));
      })
    );
  }
});
