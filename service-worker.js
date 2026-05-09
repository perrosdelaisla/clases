// =====================================================================
// service-worker.js — SW de la app cliente Perros de la Isla.
//
// Scope: /clases/  (lo asigna Pages al estar el archivo en /clases/).
// Estrategia:
//   · Asset shell precacheado en install: CSS, JS, íconos, manifest, logo.
//   · HTML / navigation requests → NetworkFirst con fallback a /clases/.
//   · Assets propios cacheados → CacheFirst.
//   · Cualquier otra cosa (Supabase, Google Fonts, CDN del SDK) → red sin
//     cache, así nunca servimos respuestas autenticadas viejas.
//
// NO interfiere con el SW del root (paseos-seguros), porque el browser
// resuelve cada request al SW del scope más específico.
// =====================================================================

const CACHE_VERSION = 'v10';
const CACHE_NAME = `clases-${CACHE_VERSION}`;

const PRECACHE_URLS = [
    '/clases/',
    '/clases/index.html',
    '/clases/manifest.json',
    '/clases/css/styles.css',
    '/clases/js/app.js',
    '/clases/js/supabase.js',
    '/clases/img/logo.png',
    '/clases/img/icon-192.png',
    '/clases/img/icon-512.png',
    '/clases/img/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key.startsWith('clases-') && key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Solo manejamos requests del propio origin dentro de /clases/.
    // Cualquier otra cosa (Supabase, Google Fonts, jsDelivr) la dejamos
    // pasar tal cual, así nunca cacheamos respuestas autenticadas o
    // assets de terceros.
    if (url.origin !== self.location.origin) return;
    if (!url.pathname.startsWith('/clases/')) return;

    // Navegación / HTML → NetworkFirst con fallback a la home cacheada.
    const esNavegacion =
        req.mode === 'navigate' ||
        (req.destination === 'document') ||
        (req.headers.get('accept') || '').includes('text/html');

    if (esNavegacion) {
        event.respondWith(networkFirstHTML(req));
        return;
    }

    // Resto de assets → CacheFirst con revalidación en background.
    event.respondWith(cacheFirst(req));
});

async function networkFirstHTML(req) {
    try {
        const fresh = await fetch(req);
        // Refrescamos el cache de la home con la última versión válida.
        if (fresh && fresh.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put('/clases/index.html', fresh.clone()).catch(() => {});
        }
        return fresh;
    } catch (_err) {
        const cached = await caches.match('/clases/index.html');
        return cached || Response.error();
    }
}

async function cacheFirst(req) {
    // Match estricto (incluye query string): así un cache-bust `?v=N` nuevo
    // nunca matchea la entrada `?v=N-1` cacheada y obliga a ir a network.
    const cached = await caches.match(req);
    if (cached) {
        // Stale-while-revalidate: refrescamos en background sin bloquear.
        fetch(req)
            .then(async (fresh) => {
                if (fresh && fresh.ok) {
                    const cache = await caches.open(CACHE_NAME);
                    cache.put(req, fresh.clone()).catch(() => {});
                }
            })
            .catch(() => {});
        return cached;
    }
    try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
    } catch (_err) {
        return Response.error();
    }
}
