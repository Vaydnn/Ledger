/* v3.0 backup & restore: v3 round trip, pre-v3 backups migrate their
   starting balances, a broken backup changes NOTHING (atomic), every
   restore leaves a snapshot that rolls back. Drives the real file flow. */
import { bootEnv, makeChecker, tick } from './_env.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const $ = s => dom.window.document.querySelector(s);
const $$ = s => Array.from(dom.window.document.querySelectorAll(s));
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));
globalThis.confirm = () => true;

const db = await import('../js/db.js');
const { state, dbPut, loadState, exportData, listSnapshots } = db;
await import('../js/app.js'); await tick(150);
const manage = await import('../js/manage.js');
const { setAnchor } = await import('../js/balances.js');
const { balanceAt } = await import('../js/effects.js');
const near = (a, b) => Math.abs(a - b) < 0.005;

let nextFile = null;
const origCreate = dom.window.document.createElement.bind(dom.window.document);
dom.window.document.createElement = function(tag){
  const el = origCreate(tag);
  if (String(tag).toLowerCase() === 'input') el.click = function(){
    const f = nextFile;
    Object.defineProperty(this, 'files', { value:[{ name: f.name, text: async () => f.text }] });
    setTimeout(() => this.onchange && this.onchange(), 0);
  };
  return el;
};
const restore = async (name, obj) => {
  nextFile = { name, text: typeof obj === 'string' ? obj : JSON.stringify(obj) };
  manage.restoreJSON(() => {});
  await tick(800);
};

// Device A data
await dbPut('accounts', { id:'a1', name:'Checking', type:'Checking', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'Loan', type:'Loan', active:true, order:1 });
await dbPut('transactions', { id:'t1', date:'2026-03-02', type:'Income', account:'Checking', category:'Salary', amount:2000, description:'' });
await dbPut('transactions', { id:'t2', date:'2026-05-12', type:'Loan Payment', account:'Loan', fromAccount:'Checking', category:'Loan Payment', amount:100, description:'' });
await loadState();
state.flags.anchorsV3 = true;
state.flags.categoryAccounts = { 'Expense|Restaurants': 'Checking' };
await setAnchor('Loan', '2026-04', 3000);
const backupA = JSON.parse(JSON.stringify(exportData()));
check('backup is format v3 with anchors and flags', backupA.version === 3 && backupA.balanceAnchors.length === 1 && !!backupA.flags.categoryAccounts);
check('backup has no legacy startingBalances', !('startingBalances' in backupA));

// Change things, then restore A.
await dbPut('transactions', { id:'t3', date:'2026-06-01', type:'Expense', account:'Checking', category:'Misc', amount:55, description:'later' });
await loadState();
await restore('ledger-backup-a.json', backupA);
check('v3 round trip: transactions back to the backup', state.transactions.length === 2 && !state.transactions.some(t => t.id === 't3'));
check('v3 round trip: pin restored', near(balanceAt('Loan', 2026, 5), 2900));
check('v3 round trip: flags restored', state.flags.categoryAccounts?.['Expense|Restaurants'] === 'Checking');
let snaps = await listSnapshots();
check('restore left a snapshot of the replaced data', snaps.length === 1 && snaps[0].reason.includes('ledger-backup-a.json') && snaps[0].txnCount === 3);

// A BROKEN backup must change nothing. (An object id is an invalid key —
// the put throws mid-transaction, after the clears were queued.)
const broken = JSON.parse(JSON.stringify(backupA));
broken.transactions.push({ id: { bad: true }, date:'2026-07-01', type:'Expense', account:'Checking', amount:1, category:'Misc', description:'' });
await restore('broken.json', broken);
check('failed restore left every transaction in place', state.transactions.length === 2);
await loadState();
check('…on disk too (nothing was cleared)', state.transactions.length === 2 && state.accounts.length === 2 && state.balanceAnchors.length === 1);
check('user told nothing changed', ($('#toast').textContent || '').includes('nothing was changed'));

// Not-a-backup files are rejected before anything happens.
await restore('notes.json', { hello: 'world' });
check('non-backup JSON rejected', ($('#toast').textContent || '').includes("Doesn't look like a Ledger backup") && state.transactions.length === 2);

// Pre-v3 (v2) backup: month-by-month startingBalances, no anchors.
const M = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const sb = { id:'sb1', account:'Loan', year:2026 }; M.forEach((m, i) => sb[m] = i < 3 ? 0 : i < 5 ? 5000 : 4900);
const v2 = { version:2, accounts: backupA.accounts, categories: backupA.categories, budgets:[], startingBalances:[sb],
             transactions: backupA.transactions, netWorth:[], debtPlans:[], bills:[], goals:[] };
await restore('ledger-backup-v2.json', v2);
check('v2 backup migrated to a pin', state.balanceAnchors.length === 1 && state.balanceAnchors[0].month === '2026-04' && near(state.balanceAnchors[0].amount, 5000));
check('v2 balances reproduced exactly', near(balanceAt('Loan', 2026, 5), 4900));

// Roll back to before the v2 restore via the Backup & Restore sheet.
await manage.openBackupSheet(() => {}); await tick(60);
snaps = await listSnapshots();
check('snapshots capped and newest first', snaps.length <= 3 && snaps[0].createdAt >= snaps[snaps.length - 1].createdAt);
const rollBtn = $$('.bk-roll')[0];
check('rollback button present', !!rollBtn);
rollBtn.click(); await tick(800);
check('rolled back to the 3000 pin (pre-v2 state)', state.balanceAnchors.length === 1 && near(state.balanceAnchors[0].amount, 3000));

check('zero captured errors', errors.length === 0, errors[0]);
done('backup & restore tests');
