// No offline cache: Jarvis is useless offline. The worker exists so the app installs and can receive pushes.
self.addEventListener('fetch', () => {});

// jarvisd sends { title, body, url, tag } (daemon/push.ts). Asks stay on screen until the owner acts on them.
self.addEventListener('push', e => {
  const m = e.data ? e.data.json() : { title: 'Jarvis', body: '', url: '/', tag: 'jarvis' };
  e.waitUntil(self.registration.showNotification(m.title, {
    body: m.body, tag: m.tag, renotify: true, requireInteraction: true,
    icon: '/icon.svg', badge: '/icon.svg', vibrate: [200, 100, 200], data: { url: m.url },
  }));
});

// Tapping opens the app on the ask: an open window is focused and told which ask, otherwise a new one opens at the URL.
// An ask with a report has the report's address after the `#` (/?item=<id>#reports/<path>): the report opens first.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  const at = new URL(url, self.location.origin);
  const id = at.searchParams.get('item'), hash = at.hash;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => new URL(w.url).origin === self.location.origin);
    if (!win) return self.clients.openWindow(url);
    await win.focus();
    if (id) win.postMessage({ type: 'item', id, ...(hash ? { hash } : {}) });
  })());
});
