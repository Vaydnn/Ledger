import { bootEnv, makeChecker, tick } from './_env.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const $ = s => dom.window.document.querySelector(s);
const $$ = s => Array.from(dom.window.document.querySelectorAll(s));
const db = await import('../js/db.js');
const { state, dbPut, dbDel, dbAll, dbBulkPut, loadState, scrubLegacyData, purgeTombstones, TAB_ID } = db;

// ── 1. updatedAt stamping ──
const t0 = Date.now();
const rec = { id:'t1', date:'2026-06-01', type:'Expense', account:'RH CC', category:'Misc', amount:10, description:'x' };
await dbPut('transactions', rec);
check('dbPut stamps updatedAt', typeof rec.updatedAt === 'number' && rec.updatedAt >= t0);

// ── 2. normalization at write boundary ──
const bad = { id:'t2', date:'2026-06-02', type:'Expense', account:'RH CC', category:'Misc', amount:'1,234.567', description: 40.15 };
await dbPut('transactions', bad);
check('amount coerced + rounded', bad.amount === 1234.57);
check('description coerced to string', bad.description === '40.15');

// ── 3. tombstone on delete; none for trash/meta ──
await dbDel('transactions', 't2');
let tombs = await dbAll('tombstones');
check('tombstone written', tombs.some(t => t.id === 'transactions:t2' && t.store === 'transactions' && t.deletedAt > 0));
await dbPut('trash', { id:'tr1', deletedAt: Date.now() });
await dbDel('trash', 'tr1');
tombs = await dbAll('tombstones');
check('no tombstone for trash store', !tombs.some(t => t.store === 'trash'));

// restore beats tombstone (the LWW invariant)
const tomb = tombs.find(t => t.id === 'transactions:t2');
await tick(5);
await dbPut('transactions', { id:'t2', date:'2026-06-02', type:'Expense', account:'RH CC', category:'Misc', amount:5, description:'restored' });
const t2 = (await dbAll('transactions')).find(x => x.id === 't2');
check('restore stamps newer than tombstone', t2.updatedAt > tomb.deletedAt);

// ── 4. tombstone aging ──
await dbPut('tombstones', { id:'transactions:old', store:'transactions', recordId:'old', deletedAt: Date.now() - 200*86400000 });
await purgeTombstones();
tombs = await dbAll('tombstones');
check('old tombstone purged', !tombs.some(t => t.recordId === 'old'));
check('recent tombstone kept', tombs.some(t => t.recordId === 't2'));

// ── 5. bulk put preserves existing stamps (restore semantics) ──
await dbBulkPut('transactions', [{ id:'t3', date:'2026-01-01', type:'Expense', account:'RH CC', amount:1, updatedAt: 12345 }]);
const t3 = (await dbAll('transactions')).find(x => x.id === 't3');
check('bulk put preserves updatedAt', t3.updatedAt === 12345);

// ── 6. one-time scrub of legacy records ──
// plant a malformed record directly (bypassing the guard, like pre-v2.3 data)
const rawDb = await db.openDB();
await new Promise(res => {
  const tx = rawDb.transaction('transactions','readwrite');
  tx.objectStore('transactions').put({ id:'legacy1', date:'2025-09-16', type:'Income', account:'WF', amount:651.61, description: 40.15 });
  tx.oncomplete = res;
});
await loadState();
const fixed = await scrubLegacyData();
check('scrub repaired the legacy record', fixed >= 1);
const legacy = (await dbAll('transactions')).find(x => x.id === 'legacy1');
check('legacy description now string', legacy.description === '40.15');
const fixed2 = await scrubLegacyData();
check('scrub runs once (flag gate)', fixed2 === 0);

// ── 7. cross-tab announce + polite refresh ──
// app.js listens on 'ledger-writes' and ignores its own TAB_ID. Simulate a
// second tab by posting with a different tabId after planting a new record.
const appMod = await import('../js/app.js');
await tick(200); // let init() settle
await new Promise(res => {
  const tx = rawDb.transaction('transactions','readwrite');
  tx.objectStore('transactions').put({ id:'fromOtherTab', date:'2026-06-09', type:'Expense', account:'RH CC', category:'Misc', amount:7, description:'tab b', updatedAt: Date.now() });
  tx.oncomplete = res;
});
check('record not yet in this tab\'s state', !state.transactions.some(t => t.id === 'fromOtherTab'));
if (typeof BroadcastChannel !== 'undefined'){
  const otherTab = new BroadcastChannel('ledger-writes');
  otherTab.postMessage({ tabId:'not-' + TAB_ID, type:'write', store:'transactions' });
  await tick(600); // debounce 350ms + reload
  check('cross-tab write triggers state reload', state.transactions.some(t => t.id === 'fromOtherTab'));
  otherTab.close();
} else {
  console.log('(BroadcastChannel unavailable in this runtime — skipped)');
}
done('groundwork tests');
