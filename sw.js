/* Minimal service worker: exists so the app is installable (Add to Home
   Screen) and launches standalone. It uses a network-first pass-through and
   deliberately does not cache API or media responses. */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
	// Pass through to the network; let the browser/edge handle caching.
	e.respondWith(fetch(e.request).catch(function () { return new Response("", { status: 504 }); }));
});
