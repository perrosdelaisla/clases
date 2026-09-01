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

const CACHE_VERSION = 'v286';
const CACHE_NAME = `clases-${CACHE_VERSION}`;

const PRECACHE_URLS = [
    '/clases/',
    '/clases/index.html',
    '/clases/manifest.json',
    '/clases/css/styles.css',
    '/clases/css/seguimiento.css',
    '/clases/js/app.js',
    '/clases/js/supabase.js',
    '/clases/js/tutorial-pasos.js',
    '/clases/js/tutorial.js',
    '/clases/js/vendor/supabase.umd.js',
    '/clases/img/logo.png',
    '/clases/img/logo-ucm.png',
    '/clases/img/jaime.png',
    '/clases/img/jaime-durmiendo.png',
    '/clases/img/jaime-pensando.png',
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
        // `cache: 'no-store'` es la clave: un fetch normal respeta el cache
        // HTTP del navegador, y GitHub Pages sirve el HTML con 10 minutos de
        // vida. Sin esto, tras un despliegue el móvil seguía recibiendo el
        // HTML viejo durante 10 minutos — y con él, los `?v=` viejos de CSS y
        // JS, así que "no se veía el cambio" aunque estuviera publicado.
        // Solo afecta a navegaciones (HTML): los assets siguen con su
        // cacheFirst de siempre, que ya se invalida con el `?v=`.
        const fresh = await fetch(req, { cache: 'no-store' });
        // Guardamos CADA página en su propia clave, no todas bajo la home.
        // Antes se cacheaba siempre como '/clases/index.html', así que sin red
        // una página del admin devolvía la app del cliente.
        if (fresh && fresh.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
    } catch (_err) {
        // Sin red: primero la propia página; si nunca se visitó, la home.
        const cached = (await caches.match(req))
                    || (await caches.match('/clases/index.html'));
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
