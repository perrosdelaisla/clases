/* Notificaciones push del cliente — Perros de la Isla.
   Calcado de admin/push.js, con dos diferencias clave:
   - Usa la sesión del cliente (getSupabase('cliente')).
   - Guarda auth_user_id en push_subscriptions: la edge function de
     recordatorios de salud filtra por ese campo.
   Registra push-sw.js en un scope propio (/clases/push/) para NO pisar la
   registración del SW de caché (service-worker.js, scope /clases/): un scope
   solo admite una registración, y /clases/ ya es del SW de caché. */

import { getSupabase } from './supabase.js';
const supabase = getSupabase('cliente');

const VAPID_PUBLIC = 'BJUH9P-NqieRIGgq71z2E1NcyxVZDquadmLJ7rSfYX1KoSnoKIXOafWTQWEY1z2JXy1lNjmDqexwoyjPR43mGms';
const PUSH_SW_URL = '/clases/push-sw.js';
const PUSH_SW_SCOPE = '/clases/push/';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// Esperar a que el SW de push esté activo. No sirve navigator.serviceWorker.ready:
// eso resuelve con el SW que controla la página (el de caché), no con este.
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
    throw new Error('Este navegador no admite notificaciones push.');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('No diste permiso para las notificaciones.');

  const reg = await navigator.serviceWorker.register(PUSH_SW_URL, { scope: PUSH_SW_SCOPE });
  await esperarActivo(reg);

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC)
    });
  }

  // auth_user_id: imprescindible para que la función de recordatorios de
  // salud encuentre la suscripción de este tutor.
  const { data: { user } } = await supabase.auth.getUser();

  const json = sub.toJSON();
  const { error } = await supabase.from('push_subscriptions').insert({
    endpoint: sub.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    user_agent: navigator.userAgent,
    auth_user_id: user ? user.id : null
  });
  // Si ya estaba registrada (endpoint único), no es un error real.
  if (error && !/duplicate|unique|already exists/i.test(error.message || '')) throw error;
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
