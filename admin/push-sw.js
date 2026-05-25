/* Service worker de notificaciones push del admin — Perros de la Isla.
   Solo maneja push + click. No cachea nada (no interfiere con el SW del cliente). */

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: 'Perros de la Isla', body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'Perros de la Isla';
  const options = {
    body: data.body || 'Tenés un aviso nuevo',
    icon: 'img/icon.png',
    badge: 'img/icon.png',
    tag: data.tag || 'pdli-admin',
    data: { url: data.url || '/clases/admin/' },
    vibrate: [80, 40, 80]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/clases/admin/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if (c.url.includes('/admin') && 'focus' in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
