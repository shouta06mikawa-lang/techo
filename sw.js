// オフライン対応：アプリの部品を iPad の中に保存しておき、ネットが無くても開けるようにする。
// 表示は保存済みのものを先に使い、裏で新しい版を取りに行く。
// この版番号が変わると新しい版として入れ替わり、app.js が自動で読み込み直す。
const CACHE = 'techo-v0.9.0';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' … ブラウザに残っている古いファイルではなく、必ずサーバーから新しいものを取る
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const cacheKey = req.mode === 'navigate' ? './index.html' : req;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(cacheKey, { ignoreSearch: true });
      const fresh = fetch(req.mode === 'navigate' ? './index.html' : req, { cache: 'no-cache' }).then((res) => {
        if (res.ok) cache.put(cacheKey, res.clone());
        return res;
      }).catch(() => null);
      if (cached) {
        e.waitUntil(fresh);
        return cached;
      }
      return (await fresh) || Response.error();
    })
  );
});
