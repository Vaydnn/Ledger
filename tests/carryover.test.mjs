/* Regression: year-boundary balance carryover (v2.9.1).
   The first transaction of a new year creates that year's startingBalances
   record — its January opening must inherit the prior year's computed
   December ENDING balance, not start at 0. Pre-existing (manually set)
   records must be left alone. */
import { bootEnv, makeChecker } from './_env.mjs';
await bootEnv();
const { check, done } = makeChecker();
const { state, dbPut, loadState } = await import('../js/db.js');
const { cascadeForChange } = await import('../js/balances.js');
const { balanceAt } = await import('../js/effects.js');

const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const blankSB = (id, account, year) => {
  const rec = { id, account, year };
  months.forEach(m => rec[m] = 0);
  return rec;
};

await dbPut('accounts', { id:'a1', name:'RH CC', type:'Credit Card', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'WF Checking', type:'Checking', active:true, order:1 });

// RH CC in 2025: December opens at $500 owed, one $100 charge → ends at $600.
const sb2025 = blankSB('sb1', 'RH CC', 2025);
sb2025.dec = 500;
await dbPut('startingBalances', sb2025);
await dbPut('transactions', { id:'t1', date:'2025-12-10', type:'Expense', account:'RH CC', category:'Misc', amount:100, description:'' });

// WF Checking already has a MANUAL 2026 record (jan = 1000) — must survive.
const sbWF = blankSB('sb2', 'WF Checking', 2026);
sbWF.jan = 1000;
await dbPut('startingBalances', sbWF);

await loadState();

// ── First transaction of the new year on RH CC (mimics add.js save flow) ──
const jan5 = { id:'t2', date:'2026-01-05', type:'Expense', account:'RH CC', category:'Misc', amount:50, description:'' };
await dbPut('transactions', jan5);
state.transactions.push(jan5);
state.transactions.sort((a,b) => (b.date||'').localeCompare(a.date||''));
await cascadeForChange(null, jan5);

const rec26 = state.startingBalances.find(b => b.account === 'RH CC' && b.year === 2026);
check('new-year record created', !!rec26);
check('January opening = prior Dec ending (500 + 100)', !!rec26 && Math.abs(rec26.jan - 600) < 0.005, 'jan=' + rec26?.jan);
check('whole year cascades from the carried opening (feb = 600 + 50)', !!rec26 && Math.abs(rec26.feb - 650) < 0.005, 'feb=' + rec26?.feb);
check('balanceAt reflects carryover (Jan 2026 = 650 owed)', Math.abs(balanceAt('RH CC', 2026, 1) - 650) < 0.005, 'got ' + balanceAt('RH CC', 2026, 1));

// ── Pre-existing manual record is not clobbered ──
const mar2 = { id:'t3', date:'2026-03-02', type:'Expense', account:'WF Checking', category:'Misc', amount:25, description:'' };
await dbPut('transactions', mar2);
state.transactions.push(mar2);
state.transactions.sort((a,b) => (b.date||'').localeCompare(a.date||''));
await cascadeForChange(null, mar2);

const wf = state.startingBalances.find(b => b.account === 'WF Checking' && b.year === 2026);
check('manual January opening preserved', Math.abs(wf.jan - 1000) < 0.005, 'jan=' + wf.jan);

// ── No prior year at all → opening stays 0 (mid-year-account rule) ──
await dbPut('accounts', { id:'a3', name:'New Card', type:'Credit Card', active:true, order:2 });
await loadState();
const first = { id:'t4', date:'2026-04-10', type:'Expense', account:'New Card', category:'Misc', amount:75, description:'' };
await dbPut('transactions', first);
state.transactions.push(first);
state.transactions.sort((a,b) => (b.date||'').localeCompare(a.date||''));
await cascadeForChange(null, first);
const nc = state.startingBalances.find(b => b.account === 'New Card' && b.year === 2026);
check('no prior year → January stays 0', !!nc && (nc.jan || 0) === 0, 'jan=' + nc?.jan);
check('brand-new record still cascades (may = 75 owed)', !!nc && Math.abs(nc.may - 75) < 0.005, 'may=' + nc?.may);

done('year-boundary carryover tests');
