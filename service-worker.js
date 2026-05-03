const CACHE_VERSION = 'v3';
const CACHE_NAME = `clases-${CACHE_VERSION}`;

const PRECACHE_URLS = [
    './',
    './index.html',
    './css/styles.css',
    './js/app.js',
    './js/supabase.js',
    './img/logo.png'
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
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    event.respondWith(
        fetch(event.request).catch(async () => {
            const cached = await caches.match(event.request, { ignoreSearch: true });
            return cached || Response.error();
        })
    );
});
