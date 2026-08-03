// Zed — basic service worker for PWA installability and offline shell caching
const CACHE_NAME = "zed-cache-v1";
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
  let data = { title: "Zed", body: "You have a new update.", url: "/app.html" };
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
  if (event.tag === "zed-flush-sync-queue") {
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
        clientList.forEach((client) => client.postMessage({ type: "ZED_FLUSH_SYNC_QUEUE" }));
      })
    );
  }
});
