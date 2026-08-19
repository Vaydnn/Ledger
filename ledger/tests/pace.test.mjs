/* Pace engine invariants + the two real-world cases that shaped it:
   salary regime change (amount-clustered detection) and a subscription
   price hike (stable-prior gate). All against the synthetic fixture. */
import { bootEnv, makeChecker, bulkInsert } from './_env.mjs';
import { ACCOUNTS, makeDataset } from './fixtures.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();

const { state, dbPut, loadState, openDB } = await import('../js/db.js');
for (const a of ACCOUNTS) await dbPut('accounts', a);
await bulkInsert(openDB, 'transactions', makeDataset());
await loadState();

const { computePace } = await import('../js/pace.js');
const subs = await import('../js/subscriptions.js');

const p = computePace();
console.log('pace:', JSON.stringify({ spent: p.spentSoFar, projSpend: p.projSpend, inc: p.incSoFar, projInc: p.projInc, hist: p.histMonths, recInc: p.incRecurringFound }));

check('projSpend >= spent so far', p.projSpend >= p.spentSoFar - 0.01);
check('projInc >= income so far', p.projInc >= p.incSoFar - 0.01);
check('net consistency', Math.abs(p.projNet - (p.projInc - p.projSpend)) < 0.01);
check('day bounds', p.D >= 1 && p.D <= p.N);
check('historical months used', p.histMonths >= 1, 'hist=' + p.histMonths);

// the fixture's salary changed 1450 → 2100 three months ago; the
// amount-clustered detector must still find the CURRENT stream and
// project remaining paychecks (unless none remain this month).
check('income stream detected despite regime change', p.incRecurringFound === true);
// FIX(v2.9.1): compute expected remaining paychecks the way the engine does
// (step from last pay by 14 days through month-end). The old formula
// (lastPay.getDate() + 14 <= N) broke across month boundaries — a June 28
// paycheck meant July 12 + July 26 both remain, but it predicted zero, so
// the suite failed on the first days of every month.
const today = new Date();
const lastPay = state.transactions.filter(t => t.category === 'Salary').map(t => t.date).sort().pop();
const [py, pm, pd] = lastPay.split('-').map(Number);
const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
let expectedPays = 0;
for (let next = new Date(py, pm - 1, pd + 14); next <= monthEnd; next = new Date(next.getFullYear(), next.getMonth(), next.getDate() + 14)){
  if (next > today) expectedPays++;
}
if (expectedPays > 0) check(`${expectedPays} remaining paycheck(s) projected`, p.projInc >= p.incSoFar + expectedPays * 2000, `projInc=${p.projInc} inc=${p.incSoFar}`);
else check('no phantom paycheck added', p.projInc - p.incSoFar < 2000, `projInc=${p.projInc} inc=${p.incSoFar}`);

// price-change: fixture hikes Streaming 15.99 → 21.99 in the last two charges
const changed = subs.detectRecurring('Expense', 400).filter(r => r.priceChange);
check('streaming hike detected', changed.some(r => r.category === 'Streaming' && r.priceChange.from === 15.99 && r.priceChange.to === 21.99), JSON.stringify(changed.map(c => [c.category, c.priceChange])));
check('stable phone bill not flagged', !changed.some(r => r.category === 'Phone Bill'));

done('pace tests');
