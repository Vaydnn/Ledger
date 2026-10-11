// Ledger PWA service worker
// FIX(v2.9.1): precached files are served CACHE-ONLY. The VERSION bump is the
// one and only update mechanism: every load is a coherent snapshot of a
// single release, and app.js shows an "update ready" toast when a new SW has
// installed.
// FIX(v3.0): install fetches every file with `cache: 'reload'`. GitHub Pages
// serves files with Cache-Control: max-age=600, so a new version installed
// within 10 minutes of the previous one could fill its cache with the OLD
// files straight out of the browser's HTTP cache — a new sw.js running last
// release's code.
const VERSION = 'ledger-v3.0.0';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './seed.json',
  // NEW(v3.0): self-hosted fonts (were Google Fonts, uncached offline)
  './fonts/geist.woff2',
  './fonts/instrument-serif.woff2',
  './fonts/instrument-serif-italic.woff2',
  './fonts/jetbrains-mono.woff2',
  './js/app.js',
  './js/util.js',
  './js/db.js',
  './js/effects.js',
  './js/sheet.js',
  './js/home.js',
  './js/bills.js',
  './js/add.js',
  './js/txns.js',
  './js/debts.js',
  './js/more.js',
  './js/budgets.js',
  './js/balances.js',
  './js/networth.js',
  './js/subscriptions.js',
  './js/manage.js',
  './js/merchants.js',
  './js/insights.js',
  './js/breakdown.js',
  './js/yearview.js',
  './js/forecast.js',
  './js/reconcile.js',
  './js/goals.js',
  './js/trash.js',
  './js/pace.js',
  './js/layout.js'     // NEW(v3.1)
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then((cached) => {
      // Precached (and previously fetched same-origin) files: cache-only.
      if (cached) return cached;
      // Anything else: network, snapshot same-origin 200s into this
      // version's cache for offline reuse.
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() =>
        // FIX(v2.10.2): offline miss → app shell for navigations, clean error otherwise.
        req.mode === 'navigate' ? caches.match('./index.html') : Response.error()
      );
    })
  );
});
