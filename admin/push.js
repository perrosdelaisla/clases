/* Notificaciones push del admin — Perros de la Isla.
   Usa el cliente Supabase ya configurado (sesión del admin) y la edge function enviar-push.
   activarNotificaciones(): pide permiso, registra el SW de push, suscribe y guarda la suscripción.
   probarPush(): dispara un push de prueba a todos los dispositivos suscritos. */

import { getSupabase } from '../js/supabase.js';
const supabase = getSupabase('admin');

const VAPID_PUBLIC = 'BJUH9P-NqieRIGgq71z2E1NcyxVZDquadmLJ7rSfYX1KoSnoKIXOafWTQWEY1z2JXy1lNjmDqexwoyjPR43mGms';

// 01/10/2026 — EL SCOPE IMPORTA. Este SW se registraba sin `scope`, o sea en
// /clases/admin/, y como un scope solo admite UNA registracion, pasaba a ser el
// que controla todo el admin, tapando a service-worker.js. Y push-sw.js no
// tiene manejador `fetch`: sin eso Chrome no considera instalable el admin, lo
// baja como atajo en vez de como app, y deja fija la notificacion
// "Toca para copiar la URL de esta aplicacion".
// La app del cliente ya lo tenia bien (js/push-cliente.js, scope /clases/push/);
// el admin se habia quedado sin arreglar.
const PUSH_SW_URL = 'push-sw.js';
const PUSH_SW_SCOPE = '/clases/admin/push/';
const SCOPE_VIEJO = '/clases/admin/';

// navigator.serviceWorker.ready resuelve con el SW que CONTROLA la pagina (el
// de cache), no con este. Hay que esperar a este en concreto.
function esperarActivo(reg) {
  if (reg.active) return Promise.resolve();
  const sw = reg.installing || reg.waiting;
  if (!sw) return Promise.resolve();
  return new Promise((resolve) => {
    sw.addEventListener('statechange', () => {
      if (sw.state === 'activated') resolve();
    });
  });
}

async function suscribirYGuardar(reg) {
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC)
    });
  }
  const { data: { user } } = await supabase.auth.getUser();
  const json = sub.toJSON();
  const { error } = await supabase.from('push_subscriptions').insert({
    endpoint: sub.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    user_agent: navigator.userAgent,
    auth_user_id: user ? user.id : null
  });
  if (error && !/duplicate|unique|already exists/i.test(error.message || '')) throw error;
  return sub;
}

// Migracion silenciosa para los dispositivos que ya tienen la registracion
// ancha. Se llama en cada arranque del admin. Si habia permiso concedido se
// resuscribe en el scope nuevo ANTES de borrar la vieja, para no dejar a nadie
// sin avisos por el camino.
export async function migrarScopePush() {
  if (!('serviceWorker' in navigator)) return false;
  try {
    const vieja = await navigator.serviceWorker.getRegistration(SCOPE_VIEJO);
    if (!vieja || vieja.scope.replace(location.origin, '') !== SCOPE_VIEJO) return false;

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const nueva = await navigator.serviceWorker.register(PUSH_SW_URL, { scope: PUSH_SW_SCOPE });
      await esperarActivo(nueva);
      try { await suscribirYGuardar(nueva); } catch (e) { console.warn('[push] resuscripcion:', e); }
      const subVieja = await vieja.pushManager.getSubscription();
      if (subVieja) {
        const ep = subVieja.endpoint;
        await subVieja.unsubscribe();
        await supabase.from('push_subscriptions').delete().eq('endpoint', ep);
      }
    }

    await vieja.unregister();
    console.info('[push] scope viejo /clases/admin/ liberado: el admin ya puede instalarse como app');
    return true;
  } catch (e) {
    console.warn('[push] no se pudo migrar el scope:', e);
    return false;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export async function estadoNotificaciones() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'no-soportado';
  if (Notification.permission === 'denied') return 'bloqueado';
  try {
    const reg = await navigator.serviceWorker.getRegistration(PUSH_SW_SCOPE);
    const sub = reg && await reg.pushManager.getSubscription();
    return sub ? 'activo' : 'inactivo';
  } catch (e) { return 'inactivo'; }
}

export async function activarNotificaciones() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Este navegador no soporta notificaciones push.');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('No diste permiso para las notificaciones.');

  await migrarScopePush();

  const reg = await navigator.serviceWorker.register(PUSH_SW_URL, { scope: PUSH_SW_SCOPE });
  await esperarActivo(reg);

  // auth_user_id: sin esto la suscripcion queda huerfana y no hay forma de
  // mandarle un push SOLO a Charly.
  await suscribirYGuardar(reg);
  return true;
}

export async function desactivarNotificaciones() {
  const reg = await navigator.serviceWorker.getRegistration(PUSH_SW_SCOPE);
  if (reg) {
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const ep = sub.endpoint;
      await sub.unsubscribe();
      await supabase.from('push_subscriptions').delete().eq('endpoint', ep);
    }
  }
  return true;
}

export async function probarPush() {
  const { data, error } = await supabase.functions.invoke('enviar-push', {
    // solo_admin: la prueba se la manda Charly a si mismo. Antes iba a TODAS
    // las suscripciones, clientes incluidos.
    body: { solo_admin: true, title: 'Perros de la Isla', body: '🔔 Notificación de prueba — ¡funciona!', url: '/clases/admin/' }
  });
  if (error) throw error;
  return data;
}
