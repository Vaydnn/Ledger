/* v3.0 derived balances: no cascade, balances = latest pinned opening at
   or before the month + net of transactions since. Replaces the v2.9.1
   carryover suite — the carryover it tested is now automatic. Also covers
   the one-time migration from stored month-by-month startingBalances. */
import { bootEnv, makeChecker } from './_env.mjs';
await bootEnv();
const { check, done } = makeChecker();
const { state, dbPut, loadState } = await import('../js/db.js');
const { balanceAt, balanceLatest, getStartingBalance, anchorsFromLegacy } = await import('../js/effects.js');
const { setAnchor, clearAnchor, migrateLegacyBalances, ensureAnchorsMigrated } = await import('../js/balances.js');

const near = (a, b) => Math.abs(a - b) < 0.005;
const put = async (t) => { await dbPut('transactions', t); state.transactions.push(t); };

await dbPut('accounts', { id:'a1', name:'Card', type:'Credit Card', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'Checking', type:'Checking', active:true, order:1 });
await dbPut('accounts', { id:'a3', name:'Savings', type:'Savings', active:true, order:2 });
await dbPut('accounts', { id:'a4', name:'Loan', type:'Loan', active:true, order:3 });
await loadState();
state.flags.anchorsV3 = true;

await put({ id:'t1', date:'2025-11-10', type:'Expense', account:'Card', category:'Misc', amount:100, description:'' });
await put({ id:'t2', date:'2025-12-10', type:'Expense', account:'Card', category:'Misc', amount:50, description:'' });
await put({ id:'t3', date:'2025-12-01', type:'Income', account:'Savings', category:'Gifts', amount:500, description:'' });
await put({ id:'t4', date:'2026-01-05', type:'Expense', account:'Card', category:'Misc', amount:25, description:'' });

// ── Flow with no pins ──
check('no pin: Nov end = 100 owed', near(balanceAt('Card', 2025, 11), 100));
check('no pin: Dec end = 150', near(balanceAt('Card', 2025, 12), 150));
check('Dec→Jan carryover is automatic', near(getStartingBalance('Card', 2026, 1), 150));
check('Jan end = 175', near(balanceAt('Card', 2026, 1), 175));
check('dormant Savings carries into the new year', near(balanceAt('Savings', 2026, 3), 500));
check('months before any activity are $0', near(balanceAt('Card', 2025, 6), 0));

// ── Edits flow everywhere instantly (nothing to re-cascade) ──
await put({ id:'t5', date:'2025-10-02', type:'Expense', account:'Card', category:'Misc', amount:10, description:'' });
check('backdated txn moves every later month', near(balanceAt('Card', 2026, 1), 185));

// ── Pinned opening ──
await setAnchor('Loan', '2026-04', 3500);
await put({ id:'t6', date:'2026-05-12', type:'Loan Payment', account:'Loan', fromAccount:'Checking', category:'Loan Payment', amount:100, description:'' });
check('before the pin: $0', near(balanceAt('Loan', 2026, 3), 0));
check('pinned month starts at the pin', near(getStartingBalance('Loan', 2026, 4), 3500));
check('after the pin: pin + flow', near(balanceAt('Loan', 2026, 5), 3400));
check('payment also hit Checking', near(balanceAt('Checking', 2026, 5), -100));
check('balanceLatest follows the pin', near(balanceLatest('Loan'), 3400));
const removed = await clearAnchor('Loan', '2026-04');
check('unpin returns to pure flow', !!removed && near(balanceAt('Loan', 2026, 5), -100));

// ── Migration from legacy stored rows ──
// Rows exactly as the v2 cascade would have stored them, plus a hand-typed
// loan opening in April. Expect exactly one pin: that opening.
const M = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const row = (account, year, fn) => { const r = { id:`sb-${account}-${year}`, account, year }; M.forEach((m, i) => r[m] = fn(i + 1)); return r; };
const legacy = [
  row('Card', 2025, (m) => m <= 10 ? 0 : m === 11 ? 10 : 110),      // Oct +10, Nov +100
  row('Card', 2026, (m) => m === 1 ? 160 : 185),                    // Dec +50, Jan +25
  row('Loan', 2026, (m) => m < 4 ? 0 : m <= 5 ? 3500 : 3400)         // opening 3500, May −100
];
const anchors = anchorsFromLegacy(legacy);
check('consistent legacy data → only the true opening becomes a pin',
  anchors.length === 1 && anchors[0].account === 'Loan' && anchors[0].month === '2026-04' && near(anchors[0].amount, 3500),
  JSON.stringify(anchors));

state.startingBalances = legacy;
state.flags.anchorsV3 = false;
state.balanceAnchors = [];
const n = await migrateLegacyBalances();
check('migration wrote the pin', n === 1 && state.balanceAnchors.length === 1);
check('migration sets the done flag', state.flags.anchorsV3 === true);
check('migrated Loan reproduces the legacy May start', near(getStartingBalance('Loan', 2026, 5), 3500));
check('migrated Loan reproduces the legacy June start', near(getStartingBalance('Loan', 2026, 6), 3400));
check('every legacy month is reproduced exactly', legacy.every(r => M.every((m, i) =>
  near(getStartingBalance(r.account, r.year, i + 1), r[m]))));
check('second run is a no-op', (await ensureAnchorsMigrated()) === 0);

// An INCONSISTENT legacy value (stale, or hand-typed mid-year) is kept as
// its own pin, so nothing the user sees changes on upgrade.
const odd = anchorsFromLegacy([row('Savings', 2026, (m) => m <= 6 ? 500 : 650)]);
check('inconsistent legacy month becomes its own pin',
  odd.length === 1 && odd[0].month === '2026-07' && near(odd[0].amount, 650), JSON.stringify(odd));

// Accounts that no longer exist have no effects → no spurious pins.
check('deleted account rows produce no pins', anchorsFromLegacy([row('Gone Bank', 2026, () => 0)]).length === 0);

done('derived balance tests');
