/* v3.1 Android features (items 19–25): app-icon shortcuts, share target,
   bill reminders, icon badge, app lock, privacy mode, black theme.
   Platform APIs (Notification, WebAuthn, badging, periodic sync, share
   target) don't exist in jsdom — each is stubbed to exercise the app's side
   of the contract; the service-worker side runs in a node vm sandbox. */
import { bootEnv, makeChecker, tick, domHelpers } from './_env.mjs';
import fs from 'fs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const { $, $$, click } = domHelpers(dom);
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));

const { state, dbPut, loadState } = await import('../js/db.js');
const app = await import('../js/app.js'); await tick(150);
const { addForm } = await import('../js/add.js');

await dbPut('accounts', { id:'a1', name:'Checking', type:'Checking', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'Card', type:'Credit Card', active:true, order:1 });
for (const [k, list] of Object.entries({ Expense:['Groceries','Restaurants'], Income:['Salary'], Refund:['Return'], Investment:['Brokerage'], CCPayment:['CC Payment'], LoanPayment:['Loan Payment'], Transfer:['Transfer'], BalanceTransfer:['Balance Transfer'] })){
  await dbPut('categories', { id:k, list });
}
const today = new Date().toISOString().slice(0, 10);
await dbPut('transactions', { id:'t1', date:today, type:'Expense', account:'Card', category:'Groceries', amount:12, description:'' });
await loadState();
state.flags.anchorsV3 = true;
await tick(700);

/* ── 19. app-icon shortcuts ── */
{
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  const sc = manifest.shortcuts || [];
  check('manifest declares shortcuts', sc.length >= 4 && sc.every(s => s.name && s.url && s.url.startsWith('./index.html?')));
  check('shortcut URLs stay in scope', sc.every(s => new URL(s.url, 'https://x.test/app/').pathname.startsWith('/app/')));
  await app.handleLaunchParams('?action=add&type=Income'); await tick(30);
  check('"Add income" opens the Add form on Income', state.view === 'add' && addForm.type === 'Income');
  await app.handleLaunchParams('?action=add&type=Bogus'); await tick(30);
  check('unknown type falls back to Expense', addForm.type === 'Expense');
  await app.handleLaunchParams('?view=bills'); await tick(30);
  check('"Bills" opens Bills', state.view === 'bills');
  await app.handleLaunchParams('?action=reconcile'); await tick(30);
  check('"Reconcile" opens the Reconcile sheet', !!$('#rc-file'));
  (await import('../js/sheet.js')).closeSheet(); await tick(30);
  const viewBefore = state.view;
  await app.handleLaunchParams('?view=nonsense'); await tick(30);
  check('unknown views are ignored', state.view === viewBefore);
  const sw = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  check('service worker serves the app for shortcut URLs (query ignored on navigations)', /ignoreSearch:\s*req\.mode === 'navigate'/.test(sw));
}

/* ── 20. Share to Ledger ── */
// The service-worker half (POST → parked file → redirect) is tested in
// sw.test.mjs with clean Node globals — jsdom's File breaks Node's own
// multipart parser. Here: the page picks up what the SW parked.
const store = new Map();
const cachesMock = {
  open: async (n) => {
    if (!store.has(n)) store.set(n, new Map());
    const m = store.get(n);
    return { put: async (k, r) => { m.set(String(k), r); }, match: async (k) => m.get(String(k)),
             delete: async (k) => m.delete(String(k)), addAll: async () => {} };
  },
  keys: async () => [...store.keys()], delete: async (n) => store.delete(n), match: async () => undefined
};
{
  const csv = 'Date,Description,Amount\n' + `${today},SHARED STATEMENT ROW,13.00\n`;
  (await cachesMock.open('ledger-share-inbox')).put('shared-file',
    new Response(csv, { headers: { 'X-File-Name': encodeURIComponent('Date range.CSV') } }));

  // Page side: the shared statement opens Reconcile, loaded.
  globalThis.caches = dom.window.caches = cachesMock;
  await app.handleLaunchParams('?share=1'); await tick(60);
  check('a shared CSV opens Reconcile with the file loaded', ($('#sheetBody').textContent || '').includes('Shared: Date range.CSV') && !!$('#rc-rerun'), 'toast=' + $('#toast').textContent + ' | sheet=' + ($('#sheetBody').textContent || '').slice(0, 200));
  check('the inbox is emptied', !store.get('ledger-share-inbox').has('shared-file'));
  await click($('#rc-rerun'), 300);
  check('one tap reconciles it', ($('#sheetBody').textContent || '').includes('SHARED STATEMENT ROW'));
  (await import('../js/sheet.js')).closeSheet(); await tick(30);

  // A shared backup offers to restore it.
  const { exportData } = await import('../js/db.js');
  const backup = exportData();
  backup.transactions = [...backup.transactions, { id:'from-share', date:today, type:'Expense', account:'Card', category:'Restaurants', amount:5, description:'shared backup' }];
  (await cachesMock.open('ledger-share-inbox')).put('shared-file', new Response(JSON.stringify(backup), { headers: { 'X-File-Name': 'ledger-backup-2026-10-11.json' } }));
  await app.handleLaunchParams('?share=1'); await tick(500);
  check('a shared backup restores (after confirm)', state.transactions.some(t => t.id === 'from-share'));
  await app.handleLaunchParams('?share=1'); await tick(60);
  check('an empty inbox just says so', ($('#toast').textContent || '').includes('Nothing to import'));
}

/* ── 21–22. reminders + badge (app side) ── */
{
  const d = new Date();
  await dbPut('bills', { id:'r1', name:'Rent', recurrence:'monthly', type:'Expense', account:'Checking', amount:1200, dueDay: d.getDate(), category:'Rent', active:true, paidMonths:{} });
  await loadState();
  // Platform stubs: notification permission prompt, badging.
  const shown = [];
  let asked = 0;
  class FakeNotification { constructor(t, o){ shown.push({ t, o }); } static async requestPermission(){ asked++; FakeNotification.permission = 'granted'; return 'granted'; } }
  FakeNotification.permission = 'default';
  globalThis.Notification = dom.window.Notification = FakeNotification;
  let badge = null;
  navigator.setAppBadge = async (n) => { badge = n; };
  navigator.clearAppBadge = async () => { badge = 0; };

  const { openSettingsSheet } = await import('../js/settings.js');
  const rem = await import('../js/reminders.js');
  openSettingsSheet(); await tick(30);
  check('Settings sheet opens with reminder + badge controls', !!$('#st-remind') && !!$('#st-badge'));
  check('…and shows what is due now', ($('#sheetBody').textContent || '').includes('1 due within 2 days'));
  await click($('#st-remind .seg-btn[data-v="on"]'), 120);
  check('turning reminders on asks for permission once', asked === 1 && state.flags.reminders.enabled === true);
  check('no background sync here → foreground mode', state.flags.reminders.background === false);
  const s1 = await rem.remindOnOpen();
  check('foreground fallback notifies about due bills', !!s1 && shown.length === 1 && shown[0].t === 'Rent is due today');
  await rem.remindOnOpen();
  check('…once a day only', shown.length === 1);
  await rem.updateBadge();
  check('badge shows bills due today/overdue', badge === 1);
  openSettingsSheet(); await tick(30);
  await click($('#st-badge .seg-btn[data-v="off"]'), 80);
  check('turning the badge off clears it', badge === 0 && state.flags.reminders.badge === false);
  await click($('#st-ahead .seg-btn[data-v="3"]'), 60);
  check('days-ahead setting saved', state.flags.reminders.daysAhead === 3);
  await click($('#st-remind .seg-btn[data-v="off"]'), 80);
  check('reminders off', state.flags.reminders.enabled === false);
  FakeNotification.permission = 'denied';
  state.flags.reminders.enabled = false;
  const res = await rem.enableReminders();
  check('a denied permission is reported, not silently enabled', res.ok === false && state.flags.reminders.enabled === false);
  (await import('../js/sheet.js')).closeSheet(); await tick(30);
}

/* ── 24. privacy mode ── */
{
  const ap = await import('../js/appearance.js');
  const { navigate, renderAll } = app;
  const body = dom.window.document.body;
  const matches = (s) => [...s.matchAll(ap.MONEY_RE)].map(m => m[0]);
  check('amount pattern: $, −$, +$, $1.2k, several per line; plain numbers ignored',
    JSON.stringify(matches('Spent $40 of $1,200.50 · −$12.00 · +$5 · $1.2k · 4 days · 12 txns')) === JSON.stringify(['$40', '$1,200.50', '−$12.00', '+$5', '$1.2k']));

  navigate('home'); await tick(30);
  check('off by default: nothing wrapped', !body.classList.contains('privacy') && $$('#view-home .pv').length === 0);
  const { openSettingsSheet } = await import('../js/settings.js');
  openSettingsSheet(); await tick(30);
  await click($('#st-privacy .seg-btn[data-v="on"]'), 60);
  (await import('../js/sheet.js')).closeSheet(); await tick(30);
  check('Settings → Blur amounts turns it on (saved)', state.flags.privacy === true && body.classList.contains('privacy'));
  const heroAmt = $('#view-home .hero .net .pv');
  check('Home hero amount is wrapped for blurring', !!heroAmt && /^\$[\d,]+\.\d\d$/.test(heroAmt.textContent));
  const leftovers = [];
  const walker = dom.window.document.createTreeWalker($('main'), 4);
  for (let n = walker.nextNode(); n; n = walker.nextNode()){
    if (/\$\d/.test(n.data) && !n.parentElement.closest('.pv') && !n.parentElement.closest('[data-nopv],.amt-calc')) leftovers.push(n.data.trim());
  }
  check('every amount on screen is covered', leftovers.length === 0, leftovers.slice(0, 3).join(' | '));
  check('the eye button is in the top bar', !!$('#privacyEye'));

  // Re-renders are caught by the observer.
  navigate('txns'); await tick(60);
  const row = $('#view-txns .txn');
  const rowAmt = row?.querySelector('.pv');
  check('Activity rows are covered after navigating', !!rowAmt);
  await click(rowAmt, 60);
  check('first tap on a blurred amount reveals it…', rowAmt.classList.contains('pv-show'));
  check('…without opening the transaction', !($('#sheet')?.classList.contains('open')) && !$('#txn-detail .td-card'));
  await click(rowAmt, 60);
  check('a second tap goes through to the row (detail sheet opens)', $('#sheet').classList.contains('open') && !!$('#sheetBody .td-card'));
  check('sheets are covered too (the detail sheet\'s amount)', $$('#sheetBody .pv').some(el => el.textContent === '$5.00'));
  (await import('../js/sheet.js')).closeSheet(); await tick(30);

  // Inputs and the live calculator are never wrapped.
  navigate('add'); await tick(60);
  check('Add form inputs untouched', !$('#view-add input .pv') && !$('.amt-calc .pv'));

  // Eye = reveal all until Ledger goes to the background.
  navigate('home'); await tick(30);
  await click($('#privacyEye'), 30);
  check('eye reveals everything', body.classList.contains('pv-all') && $('#privacyEye').getAttribute('aria-pressed') === 'true');
  let vis = 'visible';
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => vis });
  vis = 'hidden'; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  vis = 'visible'; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  check('…and re-blurs when you leave the app', !body.classList.contains('pv-all') && $$('.pv-show').length === 0);

  // SVG chart labels: the <text> itself gets the class.
  const host = dom.window.document.createElement('div');
  host.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="10">$2,400</text></svg>';
  $('#view-home').appendChild(host); await tick(20);
  check('chart labels (SVG text) are covered', host.querySelector('text').classList.contains('pv'));
  host.remove();

  // Notifications leave amounts out.
  const R = globalThis.LedgerRemind;
  const d = [{ id:'x', name:'Rent', amount:1200, daysUntil:0, overdue:false }, { id:'y', name:'Gym', amount:30, daysUntil:1, overdue:false }];
  check('notification text has no amounts in privacy mode', !/\$/.test(R.summary(d, { hideAmounts: true }).body) && /\$1,200\.00/.test(R.summary(d).body));
  check('the worker passes the privacy flag along', /hideAmounts:\s*!!flags\.privacy/.test(fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8')));

  openSettingsSheet(); await tick(30);
  await click($('#st-privacy .seg-btn[data-v="off"]'), 60);
  (await import('../js/sheet.js')).closeSheet(); await tick(30);
  check('turning it off removes the blur and the eye', state.flags.privacy === false && !body.classList.contains('privacy'));
  renderAll(); await tick(30);
  check('…and new renders are left alone', $$('#view-home .pv').length === 0);
}

/* ── 25. pure-black theme ── */
{
  const root = dom.window.document.documentElement;
  const meta = () => $('meta[name="theme-color"]').getAttribute('content');
  check('dark by default', !root.dataset.theme && meta() === '#0f0e0c');
  const { openSettingsSheet } = await import('../js/settings.js');
  openSettingsSheet(); await tick(30);
  await click($('#st-theme .seg-btn[data-v="black"]'), 60);
  check('Pure black: tokens switch + status bar goes black', root.dataset.theme === 'black' && meta() === '#000000' && state.flags.theme === 'black');
  check('the Settings control shows it', $('#st-theme .seg-btn.active')?.dataset.v === 'black');
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const block = html.match(/:root\[data-theme="black"\]\{([^}]*)\}/)?.[1] || '';
  check('black theme defines true-black surfaces', /--bg:#000;/.test(block) && /--bg-2:/.test(block) && /--line:/.test(block));
  check('…and overrides the hard-coded warm gradients', ['.appbar', 'nav.tabs', '.hero', '.real-card'].every(s => html.includes(`:root[data-theme="black"] ${s}`)));
  await click($('#st-theme .seg-btn[data-v="dark"]'), 60);
  check('back to Dark', !root.dataset.theme && meta() === '#0f0e0c' && state.flags.theme === 'dark');
  (await import('../js/sheet.js')).closeSheet(); await tick(30);
}

check('zero captured errors', errors.length === 0, errors[0]);
done('android feature tests');
