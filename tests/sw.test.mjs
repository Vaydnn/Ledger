/* v3.1 service worker, run in a node vm sandbox with clean globals (no
   jsdom — its File breaks Node's multipart parser): share target POST,
   install with cache:'reload', activate cleanup, offline navigation
   fallback, and (items 21–22) periodic bill reminders + app badge. */
import fs from 'fs';
import vm from 'vm';
import { makeChecker } from './_env.mjs';
const { check, done } = makeChecker();

function makeCaches(){
  const store = new Map();
  const api = {
    store,
    open: async (n) => {
      if (!store.has(n)) store.set(n, new Map());
      const m = store.get(n);
      return { put: async (k, r) => { m.set(String(k?.url ?? k), r); }, match: async (k) => m.get(String(k?.url ?? k)),
               delete: async (k) => m.delete(String(k)), addAll: async (reqs) => { for (const r of reqs) m.set(r.url, new Response('ok')); api.added = reqs; } };
    },
    keys: async () => [...store.keys()], delete: async (n) => store.delete(n),
    match: async (req, opts) => {
      for (const m of store.values()){
        const key = req.url ?? String(req);
        if (m.has(key)) return m.get(key);
        if (opts?.ignoreSearch){ const bare = key.split('?')[0]; if (m.has(bare)) return m.get(bare); }
      }
      return undefined;
    }
  };
  return api;
}

// The sandbox's global object IS `self` (as in a real worker), so scripts
// pulled in with importScripts() that set globalThis.X are visible as self.X.
export function loadSW(extra = {}){
  const listeners = {};
  const caches = makeCaches();
  const ctx = {
    addEventListener: (t, f) => { listeners[t] = f; },
    location: { href: 'https://x.test/Ledger/sw.js' },
    clients: { claim: async () => {}, matchAll: async () => extra.clients || [], openWindow: async (u) => { ctx.opened = u; } },
    skipWaiting: async () => {},
    registration: { showNotification: async (t, o) => { (ctx.shown ||= []).push({ t, o }); } },
    navigator: extra.navigator || {},
    caches, URL, FormData, Blob, Response, console, setTimeout, Promise, Date, Object, Math, String, Number, JSON,
    indexedDB: extra.indexedDB,
    fetch: extra.fetch || (async () => { throw new Error('offline'); })
  };
  ctx.self = ctx;
  // A real SW resolves relative URLs against its own location; Node needs absolute ones.
  ctx.Request = class SWRequest extends Request { constructor(u, o){ super(typeof u === 'string' ? new URL(u, ctx.location.href).href : u, o); } };
  ctx.importScripts = (...paths) => { for (const p of paths) vm.runInContext(fs.readFileSync(new URL('../' + p.replace(/^\.\//, ''), import.meta.url), 'utf8'), ctx); };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), ctx);
  return { listeners, caches, self: ctx, ctx };
}

/* ── install / activate / fetch basics ── */
{
  const { listeners, caches } = loadSW();
  const ev = { waitUntil(p){ this.p = p; } };
  listeners.install(ev); await ev.p;
  check('install precaches every core file with cache:reload', caches.added?.length > 30 && caches.added.every(r => r.cache === 'reload'));
  const cached = new Set(caches.added.map(r => new URL(r.url).pathname.replace('/Ledger/', '')));
  const missing = fs.readdirSync(new URL('../js/', import.meta.url)).filter(f => f.endsWith('.js') && !cached.has('js/' + f));
  check('every js/ module is precached (works offline)', missing.length === 0, missing.join(','));
  caches.store.set('ledger-v0.0.0', new Map()); caches.store.set('ledger-share-inbox', new Map());
  const act = { waitUntil(p){ this.p = p; } };
  listeners.activate(act); await act.p;
  check('activate drops old versions, keeps the share inbox', !caches.store.has('ledger-v0.0.0') && caches.store.has('ledger-share-inbox'));
  const nav = { request: new Request('https://x.test/Ledger/index.html?action=add&type=Income', { mode: 'same-origin' }), respondWith(p){ this.p = p; } };
  Object.defineProperty(nav.request, 'mode', { value: 'navigate' });
  listeners.fetch(nav);
  const r = await nav.p;
  check('a shortcut URL (with a query) is served the cached app', r && (await r.text()) === 'ok');
}

/* ── 20. share target ── */
{
  const { listeners, caches } = loadSW();
  const csv = 'Date,Description,Amount\n2026-10-01,SHARED ROW,12.00\n';
  const fd = new FormData();
  fd.append('file', new File([csv], 'Date range.CSV', { type: 'application/octet-stream' }));
  const ev = { request: new Request('https://x.test/Ledger/share-target', { method: 'POST', body: fd }), respondWith(p){ this.p = p; } };
  listeners.fetch(ev);
  const res = await ev.p;
  check('share POST → 303 into the app with ?share=1', res.status === 303 && /\/Ledger\/index\.html\?share=1$/.test(res.headers.get('location')), res.headers.get('location'));
  const parked = caches.store.get('ledger-share-inbox')?.get('shared-file');
  check('the shared file is parked with its name', !!parked && decodeURIComponent(parked.headers.get('X-File-Name')) === 'Date range.CSV');
  check('…and its exact content', parked && (await parked.text()) === csv);
  const bad = { request: new Request('https://x.test/Ledger/share-target', { method: 'POST', body: 'not multipart' }), respondWith(p){ this.p = p; } };
  const warn = console.warn; console.warn = () => {};
  listeners.fetch(bad);
  const r2 = await bad.p;
  console.warn = warn;
  check('a malformed share still just opens the app', r2.status === 303);
}

/* ── 21–22. reminder core (shared with the app) ── */
{
  const { ctx } = loadSW();
  const R = ctx.LedgerRemind;
  check('remind-core loads into the worker via importScripts', !!R && typeof R.dueBills === 'function');
  const bills = [
    { id:'rent', name:'Rent', recurrence:'monthly', dueDay:15, amount:1200, active:true, paidMonths:{} },
    { id:'net', name:'Internet', recurrence:'monthly', dueDay:16, amount:70, active:true, paidMonths:{} },
    { id:'gym', name:'Gym', recurrence:'monthly', dueDay:10, amount:30, active:true, paidMonths:{} },          // overdue
    { id:'paid', name:'Phone', recurrence:'monthly', dueDay:15, amount:60, active:true, paidMonths:{ '2026-10':'t' } },
    { id:'off', name:'Paused', recurrence:'monthly', dueDay:15, amount:5, active:false, paidMonths:{} },
    { id:'far', name:'Insurance', recurrence:'monthly', dueDay:28, amount:99, active:true, paidMonths:{} },
    { id:'cc', name:'Card', recurrence:'auto-cc', closeDay:20, graceDays:25, active:true, paidMonths:{} },     // due day 15
    { id:'once', name:'Repair', recurrence:'once', dueDate:'2026-09-30', amount:450, active:true, paidMonths:{} } // carried, overdue
  ];
  const due = R.dueBills(bills, '2026-10-15', { daysAhead: 2 });
  const ids = due.map(d => d.id);
  check('due today / tomorrow / overdue are in; paid, paused and far-off are out',
    ids.includes('rent') && ids.includes('net') && ids.includes('gym') && ids.includes('cc') && ids.includes('once')
    && !ids.includes('paid') && !ids.includes('off') && !ids.includes('far'), ids.join(','));
  check('sorted soonest (most overdue) first', due[0].id === 'once' && due[0].overdue && due[0].daysUntil === -15);
  check('auto-CC amount unknown to the worker → null', due.find(d => d.id === 'cc').amount === null);
  check('badge = overdue + due today', R.badgeCount(bills, '2026-10-15') === 4);
  const s = R.summary(due.filter(d => d.id === 'rent'));
  check('single-bill summary', s.title === 'Rent is due today' && s.body.includes('$1,200.00'));
  check('multi-bill summary', R.summary(due).title === `${due.length} bills due soon`);
  check('a due day past month-end clamps (31 → 30 in Nov)', R.dueBills([{ id:'x', name:'X', recurrence:'monthly', dueDay:31, amount:1, active:true }], '2026-11-30', { daysAhead:0 }).length === 1);
}

/* ── 21–22. background reminder run (periodic sync) ── */
{
  const { indexedDB: fakeIDB } = await import('fake-indexeddb');
  await new Promise((res, rej) => {
    const r = fakeIDB.open('ledger', 5);
    r.onupgradeneeded = () => { for (const s of ['bills','meta']) r.result.createObjectStore(s, { keyPath:'id' }); };
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction(['bills','meta'], 'readwrite');
      const pad = (n) => String(n).padStart(2, '0');
      const d = new Date();
      tx.objectStore('bills').put({ id:'rent', name:'Rent', recurrence:'monthly', dueDay: d.getDate(), amount:1200, active:true, paidMonths:{} });
      tx.objectStore('meta').put({ id:'flags', reminders:{ enabled:true, daysAhead:2, badge:true } });
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    r.onerror = () => rej(r.error);
  });
  const badge = { n: null };
  const { listeners, self } = loadSW({ indexedDB: fakeIDB, navigator: { setAppBadge: async (n) => { badge.n = n; }, clearAppBadge: async () => { badge.n = 0; } } });
  const run = async () => { const ev = { tag: 'ledger-bill-reminders', waitUntil(p){ this.p = p; } }; listeners.periodicsync(ev); await ev.p; };
  await run();
  check('background run shows one summary notification', self.shown?.length === 1 && self.shown[0].t === 'Rent is due today', JSON.stringify(self.shown));
  check('…tagged so a newer one replaces it, opening Bills on tap', self.shown[0].o.tag === 'ledger-bills' && /view=bills/.test(self.shown[0].o.data.url));
  check('…and sets the app badge', badge.n === 1);
  await run();
  check('a second run the same day stays quiet', self.shown.length === 1);
  const other = { tag: 'something-else', waitUntil(p){ this.p = p; } };
  listeners.periodicsync(other);
  check('other sync tags are ignored', other.p === undefined);
  const click = { notification: { close(){ this.closed = true; }, data: { url: './index.html?view=bills' } }, waitUntil(p){ this.p = p; } };
  listeners.notificationclick(click); await click.p;
  check('tapping the notification opens Bills', click.notification.closed && /\/Ledger\/index\.html\?view=bills$/.test(self.opened));
}

done('service worker tests');
