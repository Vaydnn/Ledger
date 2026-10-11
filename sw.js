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
const VERSION = 'ledger-v3.1.0';
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
  './js/layout.js',    // NEW(v3.1)
  './js/remind-core.js',
  './js/reminders.js',
  './js/settings.js',
  './js/lock.js',
  './js/appearance.js',
  './js/payday.js',
  './js/tags.js',
  './js/recurring.js',
  './js/statement.js',
  './js/charts.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

/* ── NEW(v3.1): bill reminders + app badge (items 21–22) ──────────────
   Chromium's Periodic Background Sync wakes the worker (roughly every 12h,
   at the browser's discretion) even with the app closed. The worker reads
   the bills straight from IndexedDB, shows ONE summary notification for
   what's due (at most once a day), and sets the app-icon badge to the
   number overdue/due today. remind-core.js holds the due-date logic the
   app uses too. */
try { importScripts('./js/remind-core.js'); } catch (e) { /* offline first install — the app still works */ }

function idbOpen(){
  return new Promise((res, rej) => {
    const r = indexedDB.open('ledger');            // current version, whatever it is
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onupgradeneeded = (e) => { e.target.transaction.abort(); };  // never create the DB from here
  });
}
function idbGetAll(db, store){
  return new Promise((res, rej) => {
    if (!db.objectStoreNames.contains(store)) return res([]);
    const q = db.transaction(store, 'readonly').objectStore(store).getAll();
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
}
function idbPut(db, store, rec){
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(rec);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}

async function runReminders(){
  const R = self.LedgerRemind;
  if (!R) return;
  let db;
  try { db = await idbOpen(); } catch (e) { return; }
  try {
    const [bills, meta] = await Promise.all([idbGetAll(db, 'bills'), idbGetAll(db, 'meta')]);
    const flags = meta.find(m => m.id === 'flags') || {};
    const settings = flags.reminders || {};
    const today = R.iso(new Date());
    if (settings.badge !== false && self.navigator && self.navigator.setAppBadge){
      const n = R.badgeCount(bills, today);
      try { n ? await self.navigator.setAppBadge(n) : await self.navigator.clearAppBadge(); } catch (e) {}
    }
    if (!settings.enabled) return;
    const due = R.dueBills(bills, today, { daysAhead: settings.daysAhead != null ? settings.daysAhead : 2 });
    const log = meta.find(m => m.id === 'remindLog') || { id: 'remindLog' };
    if (!due.length || log.date === today) return;   // once a day
    const s = R.summary(due, { hideAmounts: !!flags.privacy });
    await self.registration.showNotification(s.title, {
      body: s.body, tag: 'ledger-bills', renotify: false,
      icon: './icon-192.png', badge: './icon-192.png',
      data: { url: './index.html?view=bills' }
    });
    await idbPut(db, 'meta', { id: 'remindLog', date: today, ids: due.map(d => d.id) });
  } finally { db.close(); }
}
self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'ledger-bill-reminders') e.waitUntil(runReminders());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './index.html', self.location.href).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.navigate && c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});

// NEW(v3.1): files shared INTO Ledger from Android's share sheet (manifest
// "share_target") arrive as a POST to ./share-target. The file is parked in
// its own small cache and the app is opened with ?share=1 to pick it up.
const SHARE_CACHE = 'ledger-share-inbox';
const SHARE_KEY = 'shared-file';

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION && k !== SHARE_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

async function receiveShare(req){
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (file && typeof file !== 'string') {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put(SHARE_KEY, new Response(await file.arrayBuffer(), { headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name || 'shared-file')
      } }));
    }
  } catch (err) { console.warn('[Ledger SW] share target failed', err); } // a bad share just opens the app
  return Response.redirect(new URL('index.html?share=1', self.location.href).href, 303);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(req));
    return;
  }
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
