/* Service Worker：接收服务器 Web Push 并弹出系统通知 */
'use strict';

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: '山东高考报名', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || '山东高考报名', {
    body: d.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: 'sdzk-' + (d.kind || 'n'),
    renotify: true,
    vibrate: [200, 100, 200],
    requireInteraction: d.kind === 'open',
    data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) { if (c.url.includes('sdzk')) return c.focus(); }
    return self.clients.openWindow(url);
  })());
});
