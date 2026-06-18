/* Notificaciones push del admin — Perros de la Isla.
   Usa el cliente Supabase ya configurado (sesión del admin) y la edge function enviar-push.
   activarNotificaciones(): pide permiso, registra el SW de push, suscribe y guarda la suscripción.
   probarPush(): dispara un push de prueba a todos los dispositivos suscritos. */

import { getSupabase } from '../js/supabase.js';
const supabase = getSupabase('admin');

const VAPID_PUBLIC = 'BJUH9P-NqieRIGgq71z2E1NcyxVZDquadmLJ7rSfYX1KoSnoKIXOafWTQWEY1z2JXy1lNjmDqexwoyjPR43mGms';

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
    const reg = await navigator.serviceWorker.getRegistration('push-sw.js');
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

  const reg = await navigator.serviceWorker.register('push-sw.js');
  await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC)
    });
  }

  const json = sub.toJSON();
  const { error } = await supabase.from('push_subscriptions').insert({
    endpoint: sub.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    user_agent: navigator.userAgent
  });
  // Si ya estaba registrada (endpoint único), no es error real.
  if (error && !/duplicate|unique|already exists/i.test(error.message || '')) throw error;
  return true;
}

export async function desactivarNotificaciones() {
  const reg = await navigator.serviceWorker.getRegistration('push-sw.js');
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
    body: { title: 'Perros de la Isla', body: '🔔 Notificación de prueba — ¡funciona!', url: '/clases/admin/' }
  });
  if (error) throw error;
  return data;
}
