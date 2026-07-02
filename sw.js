// Ledger PWA service worker
// FIX(v2.9.1): precached files are now served CACHE-ONLY. The old handler
// revalidated each cached file in the background per-fetch, which could mix
// modules from two deploys in one cache (new db.js + old app.js = a torn,
// undebuggable module graph). Now the VERSION bump is the one and only
// update mechanism: every load is a coherent snapshot of a single release,
// and app.js shows an "update ready" toast when a new SW has installed.
const VERSION = 'ledger-v2.9.1';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  // FIX(v1.2): seed.json was missing from the precache — a first run while
  // offline could never seed the demo data.
  './seed.json',
  // NEW(v2.9.1): SheetJS vendored locally — export/import/reconcile now work
  // offline, and no third-party CDN script runs in a page holding finances.
  './js/vendor/xlsx.full.min.js',
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
  // NEW(v2.0)
  './js/reconcile.js',
  './js/goals.js',
  './js/trash.js',
  './js/pace.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
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
    caches.match(req).then((cached) => {
      // Precached (and previously fetched same-origin) files: cache-only.
      // No background revalidation — updates arrive solely via VERSION bump.
      if (cached) return cached;
      // Anything else (fonts CSS, uncached extras): network, snapshot
      // same-origin 200s into this version's cache for offline reuse.
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
