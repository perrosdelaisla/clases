import { supabase } from './supabase.js';

function showStatus(message, kind) {
    const el = document.getElementById('status');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('error', 'ok');
    if (kind) el.classList.add(kind);
}

async function probeSupabase() {
    try {
        const result = await supabase
            .from('ejercicios')
            .select('*', { count: 'exact', head: true });

        // Si tenemos un código HTTP (200, 401, 403, 406…), el servidor
        // está accesible. RLS sin policies es lo esperado en este punto.
        if (result.status) {
            showStatus(
                'Conectado a Supabase ✅ (RLS activo, sin policies aún — esperado)',
                'ok'
            );
        } else {
            console.error('[supabase] sin status HTTP:', result.error);
            showStatus('Error de conexión ❌ — revisa URL y key', 'error');
        }
    } catch (err) {
        console.error('[supabase] excepción:', err);
        showStatus('Error de conexión ❌ — revisa URL y key', 'error');
    }
}

async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        console.log('[sw] no soportado en este navegador');
        return;
    }
    try {
        const reg = await navigator.serviceWorker.register('./service-worker.js');
        console.log('[sw] registrado, scope:', reg.scope);
    } catch (err) {
        console.error('[sw] error al registrar:', err);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    registerServiceWorker();
    probeSupabase();
});
