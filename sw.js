// オフラインでも開けるようにファイルをキャッシュする
// 更新するときは index.html の app-version と version.json も同じ番号にそろえる
const VERSION = 'worklog-v2';
const SUPABASE_LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js';
const FILES = [
  './',
  './index.html',
  './style.css',
  './icons.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  SUPABASE_LIB,
];

self.addEventListener('install', e => {
  // cache:'reload' で、ブラウザに残った古いコピーではなく必ずサーバーから取る
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(FILES.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// アプリのファイルとライブラリだけを扱う（Supabase との通信はキャッシュしない）
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isOwn = url.origin === self.location.origin;
  if (!isOwn && req.url !== SUPABASE_LIB) return;
  // 版の確認は常にサーバーに聞く（キャッシュしない）
  if (isOwn && url.pathname.endsWith('/version.json')) return;

  // ライブラリはバージョン固定なのでキャッシュ優先
  if (req.url === SUPABASE_LIB) {
    e.respondWith(caches.match(req).then(r => r || fetch(req)));
    return;
  }
  // 自分のファイルはネット優先、つながらなければキャッシュ
  // cache:'no-cache' = ブラウザの一時保存を使う前に、サーバーに「変わった？」と必ず確認する
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});

// ---------- プッシュ通知 ----------
self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { title: 'ワンタッチ報告', body: e.data && e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(p.title || 'ワンタッチ報告', {
      body: p.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: p.tag || undefined,
      data: { url: p.url || './' },
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if (c.url.startsWith(self.registration.scope)) return c.focus();
      return self.clients.openWindow(target);
    })
  );
});
