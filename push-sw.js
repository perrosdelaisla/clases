/* Service worker de notificaciones push del cliente — Perros de la Isla.
   Solo maneja push + click. No cachea nada, así no interfiere con el SW de
   caché (service-worker.js). Se registra en un scope propio (/clases/push/)
   para no pisar la registración del SW de caché (scope /clases/). */

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: 'Perros de la Isla', body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'Perros de la Isla';
  const options = {
    body: data.body || 'Tienes un aviso nuevo',
    icon: '/clases/img/icon-192.png',
    badge: '/clases/img/icon-192.png',
    tag: data.tag || 'pdli-cliente',
    data: { url: data.url || '/clases/' },
    vibrate: [80, 40, 80]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/clases/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        // Ventana del cliente ya abierta (cualquier ruta de /clases/ que no sea admin).
        if (c.url.includes('/clases') && !c.url.includes('/admin') && 'focus' in c) {
          return c.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
