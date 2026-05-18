// =====================================================================
// supabase.js — cliente Supabase compartido (app cliente + admin).
//
// El SDK se carga como bundle UMD LOCAL desde el HTML
// (js/vendor/supabase.umd.js), NO desde un CDN externo. Así la app
// arranca sin depender de internet de terceros — el SDK viaja dentro
// de la PWA y queda precacheado por el service worker.
//
// Las 4 páginas que arrancan la app (index.html del cliente +
// admin/{index,cliente,perro}.html) cargan el <script> del UMD vendor
// ANTES de su <script type="module">, así window.supabase ya existe
// cuando este módulo se evalúa.
//
// Persistencia de sesión: ver el bloque "Storage resistente" más abajo.
// =====================================================================

const SUPABASE_URL = 'https://sydzfwwiruxqaxojymdz.supabase.co';

// =====================================================================
// Publishable key de Victoria (proyecto sydzfwwiruxqaxojymdz,
// Supabase Dashboard → Settings → API → anon key).
// La key vive en cliente — usa siempre la "publishable" (anon),
// nunca la service_role.
// =====================================================================
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_-ooEdkLOkFgPlHp4zhaqjQ_0cBVQJ3B';

// Project ref derivado de la URL — define la storageKey de Supabase Auth
// (`sb-<ref>-auth-token`, igual que el default del SDK).
const SUPABASE_REF = new URL(SUPABASE_URL).hostname.split('.')[0];
const AUTH_STORAGE_KEY = `sb-${SUPABASE_REF}-auth-token`;

if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    throw new Error('[supabase] SDK UMD no cargado — revisar el <script> de vendor en el HTML');
}

// =====================================================================
// Storage resistente para la sesión de Auth.
//
// iOS/Safari evicta el localStorage de los sitios web (regla de los 7
// días + presión de almacenamiento). Si la sesión vive solo en
// localStorage, desaparece y la clienta queda deslogueada al reabrir.
//
// Solución: guardamos el token en DOS capas — localStorage (rápido, lo
// normal) + IndexedDB (respaldo, que iOS evicta menos). Si localStorage
// aparece vacío, getItem lo recupera de IndexedDB y lo re-siembra. Todo
// best-effort: si una capa falla, la otra sigue.
// =====================================================================

const IDB_NAME = 'pdli-clases-auth';
const IDB_STORE = 'kv';
let _dbPromise = null;

function idbOpen() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('IndexedDB no disponible')); return; }
        let req;
        try {
            req = window.indexedDB.open(IDB_NAME, 1);
        } catch (e) { reject(e); return; }
        req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB bloqueada'));
    });
    return _dbPromise;
}

async function idbGet(key) {
    try {
        const db = await idbOpen();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error);
        });
    } catch (_e) {
        return null;
    }
}

async function idbSet(key, value) {
    try {
        const db = await idbOpen();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (_e) { /* best-effort: el respaldo no es crítico */ }
}

async function idbDel(key) {
    try {
        const db = await idbOpen();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (_e) { /* best-effort */ }
}

// Storage adapter que le pasamos a Supabase Auth. Es async — el SDK v2
// soporta storage async (hace await sobre estos métodos).
const resilientStorage = {
    async getItem(key) {
        // 1) localStorage primero — es lo normal y lo más rápido.
        try {
            const ls = window.localStorage.getItem(key);
            if (ls !== null) {
                idbSet(key, ls);   // mantenemos el respaldo al día, sin bloquear
                return ls;
            }
        } catch (_e) { /* localStorage puede no estar disponible */ }
        // 2) localStorage vacío (evictado o primer arranque) → IndexedDB.
        const backup = await idbGet(key);
        if (backup != null) {
            // Restauramos en localStorage para las próximas lecturas.
            try { window.localStorage.setItem(key, backup); } catch (_e) {}
            return backup;
        }
        return null;
    },
    async setItem(key, value) {
        try { window.localStorage.setItem(key, value); } catch (_e) {}
        await idbSet(key, value);
    },
    async removeItem(key) {
        try { window.localStorage.removeItem(key); } catch (_e) {}
        await idbDel(key);
    },
};

// Le pedimos al navegador almacenamiento persistente (exento de
// evicción). Best-effort: iOS puede ignorarlo — no rompe nada si falla.
if (navigator.storage && typeof navigator.storage.persist === 'function') {
    navigator.storage.persist().catch(() => {});
}

export const supabase = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
    {
        auth: {
            // La sesión se guarda y sobrevive al cierre del navegador.
            persistSession: true,
            // El access token se renueva solo con el refresh token —
            // sin esto la sesión vence y no se renueva.
            autoRefreshToken: true,
            // Al volver del magic link, parsea el token desde la URL.
            detectSessionInUrl: true,
            // Storage resistente (localStorage + respaldo IndexedDB).
            storage: resilientStorage,
            storageKey: AUTH_STORAGE_KEY,
        },
    },
);

/**
 * getSession() con timeout de seguridad. Si el SDK cuelga (sesión
 * corrupta, almacenamiento trabado, red de Auth caída), rechaza a los
 * `ms` ms en vez de dejar el arranque congelado para siempre. Devuelve
 * la misma forma que supabase.auth.getSession(): { data: { session } }.
 *
 * El default (8s) lo usan las 3 páginas del admin. La app cliente lo
 * llama con un valor más tolerante y, si vence, NO descarta la sesión:
 * la rescata con recuperarSesionDeStorage().
 */
export async function getSessionConTimeout(ms = 8000) {
    return Promise.race([
        supabase.auth.getSession(),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout getSession')), ms),
        ),
    ]);
}

/**
 * Rescata la sesión leyéndola directamente del storage resistente
 * (localStorage + respaldo IndexedDB), sin pasar por getSession().
 *
 * Lo usa el arranque de la app cliente cuando getSession() tarda
 * demasiado: en vez de mandar al login, intenta recuperar la sesión
 * que sí está guardada. Devuelve el objeto sesión o null.
 */
export async function recuperarSesionDeStorage() {
    let raw;
    try {
        raw = await resilientStorage.getItem(AUTH_STORAGE_KEY);
    } catch (_e) {
        return null;
    }
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        // El SDK v2 guarda el objeto sesión directo; cubrimos también
        // formas envueltas por si una versión del SDK las usa.
        const session = (parsed && parsed.access_token)
            ? parsed
            : (parsed && (parsed.currentSession || parsed.session)) || null;
        if (session && session.user && session.access_token) return session;
        return null;
    } catch (_e) {
        return null;
    }
}
