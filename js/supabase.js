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
// =====================================================================

const SUPABASE_URL = 'https://sydzfwwiruxqaxojymdz.supabase.co';

// =====================================================================
// Publishable key de Victoria (proyecto sydzfwwiruxqaxojymdz,
// Supabase Dashboard → Settings → API → anon key).
// La key vive en cliente — usa siempre la "publishable" (anon),
// nunca la service_role.
// =====================================================================
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_-ooEdkLOkFgPlHp4zhaqjQ_0cBVQJ3B';

if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    throw new Error('[supabase] SDK UMD no cargado — revisar el <script> de vendor en el HTML');
}

export const supabase = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
);

/**
 * getSession() con timeout de seguridad. Si el SDK cuelga (sesión
 * corrupta, almacenamiento trabado, red de Auth caída), rechaza a los
 * `ms` ms en vez de dejar el arranque congelado para siempre. Devuelve
 * la misma forma que supabase.auth.getSession(): { data: { session } }.
 *
 * Lo usan los bootstrap() de la app cliente y de las 3 páginas del
 * admin — así el peor caso es "cae al login a los 8s", no "pantalla
 * Cargando para siempre".
 */
export async function getSessionConTimeout(ms = 8000) {
    return Promise.race([
        supabase.auth.getSession(),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout getSession')), ms),
        ),
    ]);
}
