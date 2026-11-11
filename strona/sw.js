// Service worker aplikacji Dotacjo (instalacja na telefonie).
// Zasada: zawsze najpierw internet, żeby po wdrożeniu nikt nie widział starej wersji strony.
// Z pamięci podręcznej korzystamy tylko bez internetu. /api/ (konta, płatności, wyniki) nigdy nie trafia do pamięci.
const CACHE = "dotacjo-v1";
const OFFLINE = "/offline.html";
const PRECACHE = [OFFLINE, "/brand/svg/dotacjo-horizontal.svg", "/brand/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
    return;
  }
  // Grafiki, skrypty, style: z sieci, kopia na wypadek braku internetu.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || Response.error()))
  );
});
