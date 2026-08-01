/* Service worker: shell en caché, datos red-primero con respaldo. */
const SHELL_CACHE = 'vigia-shell-v89';
const DATA_CACHE = 'vigia-data-v21';
// Tiles del mapa base (CARTO): caché propia con límite LRU aproximado, para
// que el mapa siga siendo usable sin conexión (ver fetch handler abajo).
const TILES_CACHE = 'vigia-tiles-v1';
const TILES_MAX = 400;
const TILES_TRIM = 50;
// Tiles fijados a mano por "Preparar mi zona" (app.js): sin límite LRU, no se
// purga en activate. El usuario decide qué guarda; "Preparar de nuevo" la
// borra y repuebla explícitamente (mensaje pin-clear más abajo).
const PACK_CACHE = 'vigia-tiles-pack-v1';
const SHELL = [
  './',
  'index.html',
  'emergencia.html',
  'emergencia.js?v=1',
  'theme.js?v=1',
  'app.css?v=107',
  'app.js?v=107',
  'manifest.webmanifest',
  'vendor/chart.umd.min.js',
  'vendor/leaflet.js',
  'vendor/leaflet.css',
  'fonts/fonts.css',
  'fonts/BricolageGrotesque-300-800-0.woff2',
  'fonts/IBMPlexMono-400-1.woff2',
  'fonts/IBMPlexMono-500-2.woff2',
  'fonts/IBMPlexMono-600-3.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE && k !== TILES_CACHE && k !== PACK_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Mensajes desde app.js para "Preparar mi zona": fijar tiles a mano en
// PACK_CACHE (sin límite LRU) y avisar progreso a la pestaña que preguntó.
self.addEventListener('message', (e) => {
  const data = e.data || {};

  if (data.type === 'pin-clear') {
    e.waitUntil(
      caches.delete(PACK_CACHE)
        .then(() => caches.open(PACK_CACHE))
        .then(() => { if (e.source) e.source.postMessage({ type: 'pin-cleared' }); })
    );
    return;
  }

  if (data.type === 'pin-tiles') {
    const urls = Array.isArray(data.urls) ? data.urls : [];
    const client = e.source;
    const LOTE = 8;
    e.waitUntil((async () => {
      const cache = await caches.open(PACK_CACHE);
      const total = urls.length;
      let done = 0;
      let fallidos = 0;
      for (let i = 0; i < urls.length; i += LOTE) {
        const lote = urls.slice(i, i + LOTE);
        await Promise.all(lote.map((url) =>
          fetch(url)
            .then((res) => { if (res.ok) return cache.put(url, res); fallidos++; })
            .catch(() => { fallidos++; })
        ));
        done += lote.length;
        if (client) client.postMessage({ type: 'pin-progress', done, total });
      }
      if (client) client.postMessage({ type: 'pin-done', ok: total - fallidos, fallidos });
    })());
  }
});

// LRU aproximado: keys() conserva el orden de inserción razonablemente, así
// que borrar las primeras N es un FIFO suficiente para no crecer sin límite
// (no es un LRU real por fecha de acceso, pero para tiles de mapa alcanza).
function trimTilesCache(cache) {
  cache.keys().then((keys) => {
    if (keys.length <= TILES_MAX) return;
    Promise.all(keys.slice(0, TILES_TRIM).map((k) => cache.delete(k)));
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Tiles del mapa base (CARTO): red primero, con respaldo en caché para que
  // el mapa siga usable offline. Las respuestas son opacas (Leaflet no pone
  // crossOrigin en las <img> de tiles) pero SÍ se pueden cachear y servir.
  // OJO CSP: este fetch() desde el SW se rige por connect-src (no img-src) de
  // la CSP que nginx adjunta a sw.js — cartocdn debe estar en AMBAS listas de
  // deploy/nginx.conf o el fetch falla, el respaldo sale undefined y el mapa
  // queda en blanco en toda carga controlada por el SW (bug real 2026-07).
  // Sin red y sin tile cacheado, se deja fallar el fetch tal cual: se ve un
  // tile roto, aceptable en modo offline (mejor que romper todo el mapa).
  // Los tiles de Esri World Imagery (modo base "Satelital", app.js) NO entran
  // aquí a propósito: quedan network-only, sin caché ni LRU propios. Server.
  // arcgisonline.com solo está en img-src de la CSP (no en connect-src), así
  // que un fetch() del SW hacia ese host fallaría (ver nota de cartocdn más
  // abajo); dejarlo pasar sin interceptar evita ese problema y matchea el
  // uso real: "Preparar mi zona" (offline) sigue siendo solo calles, la
  // imagen satelital pesa el doble y su caso de uso es online.
  if (url.hostname.endsWith('.basemaps.cartocdn.com')) {
    e.respondWith(
      caches.open(PACK_CACHE).then((pack) => pack.match(e.request)).then((pinned) => {
        // Tile fijado a mano por "Preparar mi zona": cache-first, nunca expira.
        if (pinned) return pinned;
        return fetch(e.request)
          .then((res) => {
            const copy = res.clone();
            caches.open(TILES_CACHE).then((c) => { c.put(e.request, copy); trimTilesCache(c); });
            return res;
          })
          .catch(() => caches.match(e.request));
      })
    );
    return;
  }

  // Solo gestionamos lo nuestro: same-origin y las APIs de Open-Meteo.
  // Cualquier otro recurso cross-origin el navegador lo maneja directo.
  const isOpenMeteo = url.hostname.endsWith('open-meteo.com');
  if (url.origin !== location.origin && !isOpenMeteo) return;

  // APIs de datos: red primero, respaldo en caché (último pronóstico visto offline).
  const isData = isOpenMeteo ||
    /\/(status|verificacion|estaciones|aire|bias|avisos|sismos|incendios|alertas|volcanes|emergencia|remociones|tsunami_vias|tsunami_areas|marea|tsunami|comunas|cortes|farmacias|esval|combustible|crecidas)\.json$/.test(url.pathname);
  if (isData) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(DATA_CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // El documento HTML: RED primero. Así el index.html siempre referencia los
  // assets versionados actuales y nunca queda un HTML viejo cacheado que no
  // calce con un app.js nuevo (eso rompía el render). Respaldo a caché offline.
  if (e.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('index.html')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html')))
    );
    return;
  }

  // Assets versionados (?v=N) y fuentes: caché primero, refresco en segundo plano.
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const refresh = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    })
  );
});

// Avisos de emergencia (Web Push): el payload trae { title, body }. Si no
// llega JSON válido, se arma una notificación mínima con el texto crudo.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch (_) { d = { title: 'Vigía — aviso de emergencia', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Vigía', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    lang: 'es', tag: 'vigia-emergencia', renotify: true, data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) if ('focus' in c) return c.focus();
    return clients.openWindow(url);
  }));
});
