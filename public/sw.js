const CACHE_NAME = "moshpit-__BUILD_ID__";
const PRECACHE = [];

self.addEventListener("install", (event) => {
  // A failed asset keeps the current worker and its complete cache in place.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("moshpit-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "ACTIVATE_UPDATE") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  )
    return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) return response;
        } catch {
          // The complete, versioned shell remains available without the bridge.
        }
        const cache = await caches.open(CACHE_NAME);
        return (
          (await cache.match("/index.html")) ??
          new Response("Connect once to make moshpit available offline.", {
            status: 503,
          })
        );
      })(),
    );
    return;
  }

  if (PRECACHE.includes(url.pathname) || url.pathname.startsWith("/assets/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        // A module script is requested with an Origin header that the
        // precache request did not carry, so a server's `Vary: Origin` made
        // every lookup miss and the app came up blank offline. These files
        // are hashed and immutable: the same bytes whatever the Origin.
        return (await cache.match(request, { ignoreVary: true })) ?? fetch(request);
      })(),
    );
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    return;
  }
  if (data.type !== "block" && data.type !== "turn") return;
  const blocked = data.type === "block";
  const title = data.name ?? data.agent ?? "moshpit";
  const body =
    data.prompt ??
    (blocked ? "An agent is blocked." : "An agent finished its turn.");
  const url = data.url ?? "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: `${data.type}:${data.agent ?? ""}`,
      renotify: blocked,
      requireInteraction: blocked,
      data: { url, agent: data.agent },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((all) => {
        // Reuse the installed window when it is already open, so a tap does not
        // pile up duplicate standalone instances.
        for (const client of all) {
          if ("focus" in client) {
            client.navigate?.(url);
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
