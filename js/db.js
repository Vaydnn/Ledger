/* ============================================================
   db.js — IndexedDB promise wrappers, global state, seed import.
   ============================================================ */

import { DEFAULT_CATEGORIES, monthAbbr, uid, alphaSort, alphaSortBy, toast, toLocalISO } from './util.js';

export const DB_NAME = 'ledger';
// NEW(v2.3): version 4 adds the `tombstones` store — a record of every hard
// delete (store + id + deletedAt) so a future sync layer can distinguish
// "deleted here" from "never seen there". v3 (v2.0) added goals + trash.
// All upgrades are additive: existing stores and records are untouched.
export const DB_VER = 4;
export const STORES = ['accounts','categories','budgets','startingBalances','transactions','networth','debtPlans','bills','meta','goals','trash','tombstones'];

// NEW(v2.3): this tab's identity — lets cross-tab write notifications ignore
// their own echoes. Regenerated per page load, which is exactly the scope
// a "tab" has.
export const TAB_ID = uid();

// NEW(v2.5): monotonic data version. Bumped on writes to the stores the
// derived-math index actually reads (transactions, accounts) so caches in
// effects.js rebuild at most once per relevant write and never during pure
// renders. Scoping matters: the balance cascade writes startingBalances
// right after reading the index — an unscoped bump made every save
// invalidate the cache it had just built.
export const dataVersion = { n: 0 };
// NEW(v2.9.1): bills + budgets added — the insights/pace caches (memoized on
// dataVersion since v2.9.1) read them. Both are low-write stores, so the
// extra index rebuilds are negligible, and crucially neither is written by
// the balance cascade (the reason startingBalances stays unversioned).
const VERSIONED_STORES = new Set(['transactions','accounts','bills','budgets']);
const bumpIf = (store) => { if (VERSIONED_STORES.has(store)) dataVersion.n++; };

// NEW(v2.3): cross-tab write channel. Two PC tabs share IndexedDB but each
// holds its own in-memory `state`; without this, the stale tab silently
// stomps the fresh one on its next save. db.js announces every successful
// write; app.js listens and reloads state (politely — not mid-edit).
let _bc = null;
function announceWrite(store){
  try {
    if (typeof BroadcastChannel === 'undefined') return;
    if (!_bc) _bc = new BroadcastChannel('ledger-writes');
    _bc.postMessage({ tabId: TAB_ID, type: 'write', store });
  } catch(e){ /* unsupported / closed — harmless */ }
}

/* ── NEW(v2.3): write-boundary normalization ─────────────────────────
   Malformed data has gotten in before (numeric descriptions from the
   Excel era crashed merchant memory in v2.1) and sat dormant for months.
   Once sync exists, bad records don't just lurk — they replicate. This
   guard coerces the fields every consumer assumes are well-typed. It
   never rejects a write; it repairs it. */
const round2c = (n) => Math.round(n * 100) / 100;
function normalizeRecord(store, rec){
  if (!rec || typeof rec !== 'object') return rec;
  if (store === 'transactions'){
    if (rec.amount != null && typeof rec.amount !== 'number'){
      const n = parseFloat(String(rec.amount).replace(/[$,\s]/g, ''));
      rec.amount = isNaN(n) ? 0 : n;
    }
    if (typeof rec.amount === 'number') rec.amount = round2c(rec.amount);
    if (rec.description != null && typeof rec.description !== 'string') rec.description = String(rec.description);
    for (const k of ['type','account','category','fromAccount','date']){
      if (rec[k] != null && typeof rec[k] !== 'string') rec[k] = String(rec[k]);
    }
  } else if (store === 'bills' || store === 'debtPlans' || store === 'goals'){
    for (const k of ['amount','target','saved','minPayment','apr','origBalance']){
      if (rec[k] != null && typeof rec[k] !== 'number'){
        const n = parseFloat(rec[k]);
        if (!isNaN(n)) rec[k] = n;
      }
    }
  }
  return rec;
}

// Stores whose deletions don't need tombstones: meta is device-local config,
// trash is itself a deletion mechanism, tombstones would recurse.
const NO_TOMBSTONE = new Set(['meta','trash','tombstones']);

// FIX(v1.2): every dbAll/dbPut/dbDel opened a brand-new IndexedDB connection
// and never closed it — a cascade after one transaction edit could open
// dozens of connections. The open-promise is now cached and reused.
let _dbPromise = null;
export function openDB(){
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = (e) => {
      const db = e.target.result;
      STORES.forEach(s => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, {keyPath:'id'}); });
    };
    r.onsuccess = () => {
      const db = r.result;
      // If another tab upgrades the DB, drop the cached handle so we reconnect.
      db.onversionchange = () => { db.close(); _dbPromise = null; };
      res(db);
    };
    r.onerror = () => { _dbPromise = null; rej(r.error); };
  });
  return _dbPromise;
}
export async function dbAll(store){
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
export async function dbPut(store, obj){
  const db = await openDB();
  // NEW(v2.3): every write is normalized and stamped. updatedAt is the
  // backbone of future sync (last-write-wins needs to know which write
  // was last); accumulating it now means months of clean metadata before
  // sync ships. Mutating the caller's object is intentional — the in-memory
  // state copy stays consistent with what's on disk.
  normalizeRecord(store, obj);
  obj.updatedAt = Date.now();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(obj);
    tx.oncomplete = () => { bumpIf(store); announceWrite(store); res(); };
    tx.onerror = () => rej(tx.error);
  });
}
export async function dbDel(store, id){
  const db = await openDB();
  // FIX(v2.9.1): delete + tombstone now share ONE transaction. They used to
  // be two — a crash between them produced a delete with no tombstone, which
  // a future sync peer would read as "never deleted" and resurrect.
  const needsTombstone = !NO_TOMBSTONE.has(store);
  await new Promise((res, rej) => {
    const tx = db.transaction(needsTombstone ? [store, 'tombstones'] : store, 'readwrite');
    tx.objectStore(store).delete(id);
    if (needsTombstone){
      tx.objectStore('tombstones').put({ id: `${store}:${id}`, store, recordId: id, deletedAt: Date.now() });
    }
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  bumpIf(store);
  announceWrite(store);
}
export async function dbClear(store){
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
export async function dbBulkPut(store, items){
  const db = await openDB();
  const now = Date.now();
  // Preserve an existing stamp: bulk puts are seeds/restores, and restoring
  // a backup is not an edit — rewriting history would make every record
  // look "newer" than reality to a future sync peer.
  items.forEach(i => { normalizeRecord(store, i); i.updatedAt = i.updatedAt || now; }); // NEW(v2.3)
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    items.forEach(i => s.put(i));
    tx.oncomplete = () => { bumpIf(store); announceWrite(store); res(); };
    tx.onerror = () => rej(tx.error);
  });
}

/* ── NEW(v2.3): maintenance — tombstone aging + one-time data scrub ── */
// Tombstones older than 180 days are useless to any realistic sync gap.
export async function purgeTombstones(){
  try {
    const all = await dbAll('tombstones');
    const cutoff = Date.now() - 180 * 86400000;
    const db = await openDB();
    for (const t of all){
      if ((t.deletedAt || 0) < cutoff){
        await new Promise((res) => {
          const tx = db.transaction('tombstones', 'readwrite');
          tx.objectStore('tombstones').delete(t.id);
          tx.oncomplete = res; tx.onerror = res;
        });
      }
    }
  } catch(e){ console.warn('Tombstone purge failed', e); }
}

// One-time scrub of pre-v2.3 records: re-saves any transaction whose fields
// fail the normalization guard (numeric descriptions, string/sub-cent
// amounts). Each rewrite picks up updatedAt for free. Gated by a flag so it
// runs exactly once per device.
export async function scrubLegacyData(){
  if (state.flags.scrubV23) return 0;
  let fixed = 0;
  for (const t of state.transactions){
    const before = JSON.stringify({ a:t.amount, d:t.description, ty:t.type, ac:t.account, c:t.category, f:t.fromAccount, dt:t.date });
    normalizeRecord('transactions', t);
    const after = JSON.stringify({ a:t.amount, d:t.description, ty:t.type, ac:t.account, c:t.category, f:t.fromAccount, dt:t.date });
    if (before !== after){ await dbPut('transactions', t); fixed++; }
  }
  state.flags.scrubV23 = true;
  await saveFlags();
  if (fixed) console.info(`[Ledger] v2.3 scrub: repaired ${fixed} legacy record(s)`);
  return fixed;
}

/* ─── App state (in-memory cache, shared across modules) ──────────────── */
export const state = {
  accounts: [],
  categories: { Expense:[], Income:[], Refund:[], Investment:[], CCPayment:[], Transfer:[], BalanceTransfer:[], LoanPayment:[] },
  budgets: [],
  startingBalances: [], // [{id, account, year, jan..dec}]
  transactions: [],
  netWorth: [],
  debtPlans: [],
  bills: [],
  goals: [],                         // NEW(v2.0): savings goals
  selected: { year:null, month:null }, // current viewing month
  flags: { id:'flags' },             // persisted app flags (meta store record 'flags')
  view: 'home'
};

export async function loadState(){
  dataVersion.n++; // NEW(v2.5): state arrays are about to be replaced wholesale
  const [accounts, cats, budgets, bals, txns, nw, dp, bills, meta, goals] = await Promise.all(
    ['accounts','categories','budgets','startingBalances','transactions','networth','debtPlans','bills','meta','goals'].map(dbAll)
  );
  state.accounts = accounts.sort(alphaSortBy('name'));
  state.budgets = budgets;
  state.startingBalances = bals;
  // FIX(v1.2): hand-edited backups can contain records without a date — the raw
  // localeCompare on undefined threw and bricked the whole load. Guarded sorts.
  state.transactions = txns.sort((a,b) => (b.date||'').localeCompare(a.date||''));
  state.netWorth = nw.sort((a,b) => (a.date||'').localeCompare(b.date||''));
  state.debtPlans = dp;
  state.bills = bills.sort((a,b) => (a.dueDay||0) - (b.dueDay||0));
  state.goals = goals.sort(alphaSortBy('name')); // NEW(v2.0)
  // categories stored as one record per type
  state.categories = { Expense:[], Income:[], Refund:[], Investment:[], CCPayment:[], Transfer:[], BalanceTransfer:[], LoanPayment:[] };
  cats.forEach(c => { state.categories[c.id] = c.list || []; });

  // Safety net: if any core category list is empty but we have transactions,
  // the data was lost somehow. Restore from defaults so Add dropdowns aren't empty.
  const hasExistingData = txns.length > 0 || accounts.length > 0;
  if (hasExistingData){
    let restored = [];
    for (const [k, defaults] of Object.entries(DEFAULT_CATEGORIES)){
      if (!state.categories[k] || state.categories[k].length === 0){
        state.categories[k] = [...defaults];
        await dbPut('categories', { id:k, list: state.categories[k] });
        restored.push(k);
      }
    }
    if (restored.length){
      console.warn('[Ledger] Restored empty category lists from defaults:', restored.join(', '));
      setTimeout(() => toast(`Restored ${restored.length} category list${restored.length===1?'':'s'}`), 600);
    }
  }
  // Ensure Refund category has sensible defaults for legacy DBs
  if (!state.categories.Refund || state.categories.Refund.length === 0){
    state.categories.Refund = [...DEFAULT_CATEGORIES.Refund];
    await dbPut('categories', { id:'Refund', list: state.categories.Refund });
  }
  // Sort every category list alphabetically
  for (const k of Object.keys(state.categories)){
    state.categories[k] = (state.categories[k] || []).slice().sort(alphaSort);
  }
  // selected month
  const sel = meta.find(m => m.id === 'selected');
  if (sel) state.selected = { year:sel.year, month:sel.month };
  else {
    const d = new Date();
    state.selected = { year:d.getFullYear(), month:d.getMonth()+1 };
  }

  // FIX(v1.2): app flags moved from localStorage to the meta store — the app's
  // own rule is "no localStorage for persistent data" (IndexedDB only), and the
  // migration-dismissed flag was the lone violation. Existing localStorage
  // value is ported once, then removed.
  const flagsRec = meta.find(m => m.id === 'flags');
  state.flags = flagsRec ? { ...flagsRec } : { id:'flags' };
  try {
    if (localStorage.getItem('ledger.migrationDismissed') === '1' && !state.flags.migrationDismissed){
      state.flags.migrationDismissed = true;
      await dbPut('meta', state.flags);
      localStorage.removeItem('ledger.migrationDismissed');
    }
  } catch(e){ /* localStorage unavailable in some embedded contexts — fine */ }
}

export async function saveFlags(){
  await dbPut('meta', state.flags);
}

export async function saveSelected(){
  await dbPut('meta', { id:'selected', year:state.selected.year, month:state.selected.month });
}

/* ─── Seed import ─── wipes DATA stores and reseeds from JSON ─────────── */
// FIX(v2.9.1): no longer clears meta / trash / tombstones. meta holds device
// settings (realAvailCards, auto-snapshot toggle, scrub flag) that a data
// import has no business resetting; trash is the user's undo safety net;
// tombstones are deletion history a future sync layer needs.
export const DATA_STORES = STORES.filter(s => !['meta','trash','tombstones'].includes(s));
export async function seedFromJSON(seed){
  for (const s of DATA_STORES) await dbClear(s);

  // Accounts
  const accountsToPut = seed.accounts.map((a, i) => ({
    id: uid(), name:a.name, type:a.type, creditLimit:a.creditLimit||null,
    active:a.active !== false, notes:a.notes||'', order:i
  }));
  await dbBulkPut('accounts', accountsToPut);

  // Categories
  const cats = seed.categories || {};
  for (const k of Object.keys(cats)){
    await dbPut('categories', { id:k, list:cats[k] });
  }
  // Ensure required categories exist
  if (!cats.CCPayment || !cats.CCPayment.length) await dbPut('categories', { id:'CCPayment', list:['CC Payment'] });
  if (!cats.Transfer || !cats.Transfer.length) await dbPut('categories', { id:'Transfer', list:['Transfer'] });
  if (!cats.BalanceTransfer) await dbPut('categories', { id:'BalanceTransfer', list:['Balance Transfer'] });
  if (!cats.LoanPayment) await dbPut('categories', { id:'LoanPayment', list:['Loan Payment'] });
  if (!cats.Refund || !cats.Refund.length) await dbPut('categories', { id:'Refund', list:['Purchase Refund','Return','Credit','Reimbursement','Cashback','Other Refund'] });

  // Budgets
  const budgetsToPut = seed.budgets.map(b => ({
    id: uid(), type:b.type, category:b.category, year:seed.meta?.trackingYear || new Date().getFullYear() /* FIX(v1.2): was hardcoded 2026 */,
    amounts:b.amounts
  }));
  await dbBulkPut('budgets', budgetsToPut);

  // Starting balances
  const balsToPut = [];
  Object.entries(seed.startingBalances || {}).forEach(([acct, months]) => {
    balsToPut.push({ id: uid(), account:acct, year:seed.meta?.trackingYear || new Date().getFullYear() /* FIX(v1.2): was hardcoded 2026 */, ...months });
  });
  await dbBulkPut('startingBalances', balsToPut);

  // Transactions
  const txnsToPut = seed.transactions.map(t => ({ id: uid(), ...t }));
  await dbBulkPut('transactions', txnsToPut);

  // Net worth
  const nwToPut = (seed.netWorth || []).map(n => ({ id:uid(), ...n }));
  await dbBulkPut('networth', nwToPut);

  // Debt plans
  const dpToPut = (seed.debtPlans || []).map(d => ({ id:uid(), ...d }));
  await dbBulkPut('debtPlans', dpToPut);

  // Bills
  const billsToPut = (seed.bills || []).map(b => ({ id:uid(), paidMonths:{}, ...b }));
  await dbBulkPut('bills', billsToPut);

  // NEW(v2.0): Savings goals
  const goalsToPut = (seed.goals || []).map(g => ({ id:uid(), ...g }));
  await dbBulkPut('goals', goalsToPut);
}
