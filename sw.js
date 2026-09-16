/* TAO & YAN 相处日记 - Service Worker */
const CACHE_NAME = 'couple-pwa-v140';
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
        return self.clients.matchAll().then(clients => {
          clients.forEach(client => client.postMessage({ type: 'FORCE_RELOAD' }));
        });
      })
  );
});

self.addEventListener('fetch', (event) => {
  // 非 GET 请求直接放行（POST/DELETE 等不经过 SW）
  if (event.request.method !== 'GET') return;

  // 跨域请求（API 调用）直接放行，不经过 SW 缓存
  // 防止 SW 缓存云端数据导致 YAN/TAO 看不到对方最新数据
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // 导航请求：网络优先，缓存兜底
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

  // 样式/脚本：网络优先，缓存兜底
  if (event.request.destination === 'style' || event.request.destination === 'script') {
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned).catch(() => {}));
        }
        return response;
      }).catch(() => caches.match(event.request).then(r => r || new Response('', { status: 503 })))
    );
    return;
  }

  // 同源静态资源：缓存优先（图片等）
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') return response;
        const cloned = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, cloned).catch(() => {});
        });
        return response;
      }).catch(() => cached)
    })
  );
});
