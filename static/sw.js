// Book Tracker's service worker. It only lets the app be installed; everything still comes
// live from your server (nothing is cached), so you always see your latest books.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
