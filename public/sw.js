// Service worker du Prédicteur Coupe du Monde 2026
// Rôle : permettre l'installation de l'app sur le téléphone, et garder une
// version utilisable même sans connexion (les données en direct ne se
// chargeront pas hors-ligne, mais l'app elle-même s'ouvrira normalement).

const CACHE_NAME = "predicteur-cdm-v2";
const PRECACHE_ASSETS = [
  "/",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Stratégie : on essaie toujours le réseau en premier (pour avoir les
// dernières données), et on retombe sur le cache seulement si le réseau échoue
// (hors-ligne, ou serveur Render endormi qui ne répond pas encore).
self.addEventListener("fetch", (event) => {
  // Ne jamais mettre en cache les appels à l'API : ces données changent
  // constamment et doivent toujours venir du réseau quand il est disponible.
  if (event.request.url.includes("/api/")) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
