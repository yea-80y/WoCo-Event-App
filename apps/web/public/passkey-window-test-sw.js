// Window-design test: keep the sign-in window page in the browser so the second
// open does not wait on eth.limo. Scoped to that one page; it touches nothing else.
var CACHE = "woco-window-test-v1";
var PAGE = new URL("./passkey-window-test.html", self.location).pathname;

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.add(PAGE); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname !== PAGE) return;
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(PAGE).then(function (hit) {
      var fresh = fetch(e.request).then(function (r) { if (r.ok) c.put(PAGE, r.clone()); return r; }).catch(function () { return null; });
      return hit || fresh.then(function (r) { return r || Response.error(); });
    });
  }));
});
