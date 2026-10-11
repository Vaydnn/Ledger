/* ============================================================
   db.js — IndexedDB promise wrappers, global state, seed import.
   ============================================================ */

import { DEFAULT_CATEGORIES, uid, alphaSort, alphaSortBy, toast } from './util.js';

export const DB_NAME = 'ledger';
// NEW(v3.0): version 5 adds `balanceAnchors` (pinned opening balances — the
// only stored balance data now; everything else is derived from transactions)
// and `snapshots` (automatic pre-restore copies for one-tap rollback).
// v4 (v2.3) added tombstones; v3 (v2.0) added goals + trash. All upgrades are
// additive: existing stores and records are untouched. `startingBalances`
// stays as a read-only legacy store — it's the input to the one-time v3.0
// migration and is never written to by the app any more.
export const DB_VER = 5;
export const STORES = ['accounts','categories','budgets','startingBalances','transactions','networth','debtPlans','bills','meta','goals','trash','tombstones','balanceAnchors','snapshots'];

// NEW(v2.3): this tab's identity — lets cross-tab write notifications ignore
// their own echoes. Regenerated per page load, which is exactly the scope
// a "tab" has.
export const TAB_ID = uid();

// NEW(v2.5): monotonic data version. Bumped on writes to the stores the
// derived-math index reads, so caches in effects.js / insights / pace rebuild
// at most once per relevant write and never during pure renders.
export const dataVersion = { n: 0 };
// NEW(v3.0): balanceAnchors joins — balances are computed from anchors +
// transactions, so an anchor edit must invalidate the index.
const VERSIONED_STORES = new Set(['transactions','accounts','bills','budgets','balanceAnchors']);
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
   This guard coerces the fields every consumer assumes are well-typed. It
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
    for (const k of ['type','account','category','fromAccount','date','offsetCategory']){
      if (rec[k] != null && typeof rec[k] !== 'string') rec[k] = String(rec[k]);
    }
  } else if (store === 'bills' || store === 'debtPlans' || store === 'goals'){
    // FIX(v2.10.2): 'originalBalance' is the field debt plans actually use
    // (the old 'origBalance' key matched nothing).
    for (const k of ['amount','target','saved','minPayment','apr','originalBalance']){
      if (rec[k] != null && typeof rec[k] !== 'number'){
        const n = parseFloat(rec[k]);
        if (!isNaN(n)) rec[k] = n;
      }
    }
  } else if (store === 'balanceAnchors'){
    const n = parseFloat(String(rec.amount ?? '').replace(/[$,\s]/g, ''));
    rec.amount = isNaN(n) ? 0 : round2c(n);
    rec.month = String(rec.month || '').slice(0, 7);
  }
  return rec;
}

// Stores whose deletions don't need tombstones: device-local config and
// buffers (meta, trash, snapshots), and tombstones themselves.
const NO_TOMBSTONE = new Set(['meta','trash','tombstones','snapshots']);

// FIX(v1.2): one cached connection instead of one per call.
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

// FIX(v3.0): a transaction that ABORTS (quota exceeded, a constraint error)
// fires onabort, not necessarily onerror — those writes used to leave the
// caller's promise hanging forever and the button silently dead.
function settle(tx, res, rej, onOk){
  tx.oncomplete = () => { if (onOk) onOk(); res(); };
  tx.onerror = () => rej(tx.error || new Error('IndexedDB write failed'));
  tx.onabort = () => rej(tx.error || new Error('IndexedDB write aborted'));
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
  // NEW(v2.3): every write is normalized and stamped (updatedAt is the
  // backbone of future last-write-wins sync). Mutating the caller's object is
  // intentional — the in-memory state copy stays consistent with disk.
  normalizeRecord(store, obj);
  obj.updatedAt = Date.now();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(obj);
    settle(tx, res, rej, () => { bumpIf(store); announceWrite(store); });
  });
}
export async function dbDel(store, id){
  const db = await openDB();
  // FIX(v2.9.1): delete + tombstone share ONE transaction — a crash between
  // them used to produce a delete a future sync peer would resurrect.
  const needsTombstone = !NO_TOMBSTONE.has(store);
  await new Promise((res, rej) => {
    const tx = db.transaction(needsTombstone ? [store, 'tombstones'] : store, 'readwrite');
    tx.objectStore(store).delete(id);
    if (needsTombstone){
      tx.objectStore('tombstones').put({ id: `${store}:${id}`, store, recordId: id, deletedAt: Date.now() });
    }
    settle(tx, res, rej);
  });
  bumpIf(store);
  announceWrite(store);
}
export async function dbClear(store){
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    settle(tx, res, rej, () => bumpIf(store));
  });
}
export async function dbBulkPut(store, items){
  const db = await openDB();
  const now = Date.now();
  // Preserve an existing stamp: bulk puts are seeds/restores, and restoring
  // a backup is not an edit.
  items.forEach(i => { normalizeRecord(store, i); i.updatedAt = i.updatedAt || now; });
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    items.forEach(i => s.put(i));
    settle(tx, res, rej, () => { bumpIf(store); announceWrite(store); });
  });
}

/* ── NEW(v3.0): atomic whole-ledger replace ─────────────────────────
   Restore and sample-data seeding used to clear every store and then write
   them back one store at a time — a failure halfway (a malformed record,
   quota) left a half-empty ledger with nothing but a "Restore failed" toast.
   Now every DATA store is cleared and refilled inside ONE IndexedDB
   transaction: it either all lands or none of it does. `records` maps
   store name → array; stores not mentioned are cleared (it's a replace). */
export async function replaceAllData(records){
  const db = await openDB();
  const now = Date.now();
  const prepared = {};
  for (const s of DATA_STORES){
    prepared[s] = (records[s] || []).map(r => {
      const rec = { ...r };
      if (!rec.id) rec.id = uid();
      normalizeRecord(s, rec);
      rec.updatedAt = rec.updatedAt || now;
      return rec;
    });
  }
  await new Promise((res, rej) => {
    const tx = db.transaction(DATA_STORES, 'readwrite');
    settle(tx, res, rej);
    try {
      for (const s of DATA_STORES){
        const os = tx.objectStore(s);
        os.clear();
        for (const rec of prepared[s]) os.put(rec);
      }
    } catch (e){
      // A put that throws synchronously (invalid key, uncloneable value)
      // must not let the clears above commit — abort rolls everything back.
      try { tx.abort(); } catch(_){}
      rej(e);
    }
  });
  dataVersion.n++;
  announceWrite('*');
}

/* ── NEW(v2.3): maintenance — tombstone aging + one-time data scrub ── */
// Tombstones older than 180 days are useless to any realistic sync gap.
export async function purgeTombstones(){
  try {
    const all = await dbAll('tombstones');
    const cutoff = Date.now() - 180 * 86400000;
    const stale = all.filter(t => (t.deletedAt || 0) < cutoff);
    if (!stale.length) return;
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('tombstones', 'readwrite');
      stale.forEach(t => tx.objectStore('tombstones').delete(t.id));
      settle(tx, res, rej);
    });
  } catch(e){ console.warn('Tombstone purge failed', e); }
}

// One-time scrub of pre-v2.3 records: re-saves any transaction whose fields
// fail the normalization guard. Gated by a flag so it runs once per device.
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
  balanceAnchors: [],    // NEW(v3.0): [{id, account, month:'YYYY-MM', amount}] — pinned starting balances
  startingBalances: [],  // LEGACY (≤ v2.10): read only, input to the v3.0 migration
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
  const [accounts, cats, budgets, bals, anchors, txns, nw, dp, bills, meta, goals] = await Promise.all(
    ['accounts','categories','budgets','startingBalances','balanceAnchors','transactions','networth','debtPlans','bills','meta','goals'].map(dbAll)
  );
  state.accounts = accounts.sort(alphaSortBy('name'));
  state.budgets = budgets;
  state.startingBalances = bals;
  state.balanceAnchors = anchors;
  // FIX(v1.2): guarded sorts — hand-edited backups can contain dateless records.
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

  // FIX(v1.2): app flags live in the meta store (IndexedDB-only rule).
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

/* ─── Whole-ledger export (backups + snapshots) ───────────────────────── */
// NEW(v3.0): backup format v3 — balanceAnchors replace startingBalances.
// v1/v2 backups (startingBalances, no anchors) still restore: manage.js runs
// the same migration a live device runs on upgrade.
export const BACKUP_VERSION = 3;
// NEW(v3.1): flags tied to THIS phone — the app lock (its fingerprint
// credential lives in this phone's authenticator), notification state.
// They never go into a backup and a restore never overwrites them.
export const DEVICE_FLAGS = ['lock', 'reminders', 'lastReminderDay', 'lastDailySnapshot'];
export function portableFlags(flags){
  const out = { ...(flags || {}) };
  for (const k of DEVICE_FLAGS) delete out[k];
  return out;
}
export function exportData(){
  return {
    version: BACKUP_VERSION,
    app: 'ledger',
    exportedAt: new Date().toISOString(),
    flags: portableFlags(state.flags),
    accounts: state.accounts,
    categories: state.categories,
    budgets: state.budgets,
    balanceAnchors: state.balanceAnchors,
    transactions: state.transactions,
    netWorth: state.netWorth,
    debtPlans: state.debtPlans,
    bills: state.bills,
    goals: state.goals
  };
}

/* ── NEW(v3.0): automatic snapshots ────────────────────────────────────
   Before anything replaces the whole ledger (restore, sample data), the
   current data is copied into the device-local `snapshots` store. The
   newest SNAPSHOT_KEEP survive; Backup & Restore lists them for rollback. */
const SNAPSHOT_KEEP = 3;
export async function saveSnapshot(reason){
  if (!state.transactions.length && !state.accounts.length) return null; // nothing worth keeping
  const snap = { id: uid(), createdAt: Date.now(), reason, txnCount: state.transactions.length,
                 data: JSON.parse(JSON.stringify(exportData())) };
  await dbPut('snapshots', snap);
  const all = (await dbAll('snapshots')).sort((a,b) => b.createdAt - a.createdAt);
  for (const old of all.slice(SNAPSHOT_KEEP)) await dbDel('snapshots', old.id);
  return snap;
}
export async function listSnapshots(){
  return (await dbAll('snapshots')).sort((a,b) => b.createdAt - a.createdAt);
}

/* ─── Seed import ─── replaces DATA stores with the sample/seed JSON ────── */
// meta / trash / tombstones / snapshots are device-local and never touched.
export const DATA_STORES = STORES.filter(s => !['meta','trash','tombstones','snapshots'].includes(s));

// Seed files use a compact format (budgets without ids, …). Converted here,
// then written atomically. v3 seeds carry `balanceAnchors` (openings); an
// older seed's `startingBalances` (keyed by account) land in the legacy
// store and the caller migrates them (balances.js migrateLegacyBalances) —
// one code path for every pre-v3 source.
export function seedToRecords(seed){
  const year = seed.meta?.trackingYear || new Date().getFullYear();
  const cats = { ...(seed.categories || {}) };
  if (!cats.CCPayment || !cats.CCPayment.length) cats.CCPayment = ['CC Payment'];
  if (!cats.Transfer || !cats.Transfer.length) cats.Transfer = ['Transfer'];
  if (!cats.BalanceTransfer) cats.BalanceTransfer = ['Balance Transfer'];
  if (!cats.LoanPayment) cats.LoanPayment = ['Loan Payment'];
  if (!cats.Refund || !cats.Refund.length) cats.Refund = [...DEFAULT_CATEGORIES.Refund];
  return {
    accounts: (seed.accounts || []).map((a, i) => ({
      id: uid(), name:a.name, type:a.type, creditLimit:a.creditLimit||null,
      active:a.active !== false, notes:a.notes||'', order:i
    })),
    categories: Object.entries(cats).map(([k, list]) => ({ id:k, list })),
    budgets: (seed.budgets || []).map(b => ({ id: uid(), type:b.type, category:b.category, year, amounts:b.amounts })),
    startingBalances: Object.entries(seed.startingBalances || {}).map(([acct, months]) => ({ id: uid(), account:acct, year, ...months })),
    balanceAnchors: (seed.balanceAnchors || []).map(a => ({ id: uid(), ...a })),
    transactions: (seed.transactions || []).map(t => ({ id: uid(), ...t })),
    networth: (seed.netWorth || []).map(n => ({ id:uid(), ...n })),
    debtPlans: (seed.debtPlans || []).map(d => ({ id:uid(), ...d })),
    bills: (seed.bills || []).map(b => ({ id:uid(), paidMonths:{}, ...b })),
    goals: (seed.goals || []).map(g => ({ id:uid(), ...g }))
  };
}
export async function seedFromJSON(seed){
  await replaceAllData(seedToRecords(seed));
}
