/* TAO & YAN 相处日记 - Service Worker */
const CACHE_NAME = 'couple-pwa-v26';
const URLS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './img/favicon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(URLS_TO_CACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        // 通知所有客户端强制刷新
        return self.clients.matchAll().then(clients => {
          clients.forEach(client => client.postMessage({ type: 'FORCE_RELOAD' }));
        });
      })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // 对 HTML 文件使用"网络优先"策略（确保及时更新）
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request).then((response) => {
        const cloned = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned).catch(() => {}));
        return response;
      }).catch(() => caches.match(event.request).then(r => r || new Response('', { status: 302, headers: { Location: './' } })))
    );
    return;
  }

  // 其他资源用"缓存优先"策略
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') return response;
        const cloned = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, cloned).catch(() => {});
        });
        return response;
      }).catch(() => cached);
    })
  );
});
