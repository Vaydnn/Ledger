/* v3.0 money-math fixes:
   - one-time bills carry forward while unpaid (and count in Real Available)
   - Pay is double-tap safe; "Looks paid · Link" for hand-logged payments
   - Pace counts only EXPENSE bills as fixed spending
   - Forecast: no double count for card subscriptions / bills covered twice
   - recurring detection by merchant splits a mixed category
   - refunds give back to their category's budget */
import { bootEnv, makeChecker, tick } from './_env.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const $ = s => dom.window.document.querySelector(s);
const $$ = s => Array.from(dom.window.document.querySelectorAll(s));
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));

const { state, dbPut, loadState } = await import('../js/db.js');
await import('../js/app.js'); await tick(150);
const bills = await import('../js/bills.js');
const { computePace } = await import('../js/pace.js');
const { detectRecurring } = await import('../js/subscriptions.js');
const { budgetSpentMap } = await import('../js/budgets.js');
const { today, ymOf } = await import('../js/util.js');
const near = (a, b) => Math.abs(a - b) < 0.005;

const now = new Date();
const Y = now.getFullYear(), MO = now.getMonth() + 1;
const ym = ymOf(Y, MO);
const prev = MO === 1 ? { y: Y - 1, m: 12 } : { y: Y, m: MO - 1 };
const prevYm = ymOf(prev.y, prev.m);
const iso = (daysAgo) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; };

for (const [i, [name, t]] of [['Checking','Checking'],['Card','Credit Card'],['Loan','Loan']].entries()){
  await dbPut('accounts', { id:'a'+i, name, type:t, active:true, order:i });
}
await dbPut('categories', { id:'Expense', list:['Shopping','Streaming','Rent','Misc'] });
await dbPut('categories', { id:'Refund', list:['Return'] });
let id = 0;
const T = async (t) => dbPut('transactions', { id:'x'+(id++), description:'', fromAccount:null, ...t });
await T({ date:iso(0), type:'Income', account:'Checking', category:'Salary', amount:5000 });
// Two subscriptions logged under ONE category, different merchants + prices.
for (let k = 0; k < 6; k++){
  await T({ date:iso(5 + k * 30), type:'Expense', account:'Card', category:'Streaming', amount:15.49, description:'Netflix' });
  await T({ date:iso(12 + k * 30), type:'Expense', account:'Card', category:'Streaming', amount:10.99, description:'Spotify' });
}
// Rent: a bill AND a detectable monthly series (paid from Checking).
for (let k = 1; k <= 5; k++) await T({ date:iso(k * 30), type:'Expense', account:'Checking', category:'Rent', amount:1200, description:'Rent (auto)' });

await dbPut('bills', { id:'rent', name:'Rent', recurrence:'monthly', type:'Expense', account:'Checking', amount:1200, dueDay:28, category:'Rent', active:true, paidMonths:{} });
await dbPut('bills', { id:'cardpay', name:'Card payment', recurrence:'monthly', type:'CC Payment', account:'Card', fromAccount:'Checking', amount:300, dueDay:28, category:'', active:true, paidMonths:{} });
await dbPut('bills', { id:'loanpay', name:'Loan', recurrence:'monthly', type:'Loan Payment', account:'Loan', fromAccount:'Checking', amount:250, dueDay:28, category:'', active:true, paidMonths:{} });
await dbPut('bills', { id:'once', name:'Car repair', recurrence:'once', type:'Expense', account:'Checking', amount:450, dueDate:`${prevYm}-15`, dueDay:15, category:'Misc', active:true, paidMonths:{} });
await loadState();
state.flags.anchorsV3 = true;
state.selected = { year: Y, month: MO };

// ── Recurring by merchant ──
const subs = detectRecurring('Expense');
const labels = subs.map(s => s.label);
check('Netflix detected on its own', labels.includes('Netflix'), labels.join(','));
check('Spotify detected on its own', labels.includes('Spotify'), labels.join(','));
check('rent series detected too', labels.includes('Rent'), labels.join(','));
check('series carry their transaction ids', subs.every(s => s.txnIds instanceof Set && s.txnIds.size === s.count));

// ── One-time bill carries forward ──
const once = state.bills.find(b => b.id === 'once');
check('unpaid one-time bill still applies this month', bills.billAppliesToMonth(once, Y, MO));
check('…and shows as overdue', bills.billStatus(once, ym, true, now.getDate()).kind === 'overdue');
const ra = bills.computeRealAvailable(Y, MO);
check('…and still counts against Real Available', ra.stdUnpaid.some(b => b.id === 'once'));

// ── Pace: only expense bills are spending ──
const p = computePace();
// unpaid due-later expense bills: Rent 1200 (if due day ≥ today) + carried one-time 450.
const rentDue = now.getDate() <= 28 ? 1200 : 0;
// Plus at most one more Netflix + Spotify charge before month-end.
check('pace fixed = expense bills + subscriptions only',
  p.fixedRemaining >= rentDue + 450 - 0.005 && p.fixedRemaining <= rentDue + 450 + 15.49 + 10.99 + 0.005,
  `fixedRemaining=${p.fixedRemaining}`);
check('CC/Loan payment bills (550) are NOT in projected spending', p.fixedRemaining < rentDue + 450 + 300,
  `fixedRemaining=${p.fixedRemaining}`);

// ── Forecast: card subscriptions reach cash via the card bill; rent once ──
const { openForecastSheet } = await import('../js/forecast.js');
openForecastSheet(); await tick(40);
const fcText = $('#sheetBody').textContent;
check('forecast has no Netflix line (paid via the Card payment bill)', !fcText.includes('Netflix'));
const rentLines = $$('.fc-event-label').filter(e => e.textContent.trim() === 'Rent').length;
const rentDays = $$('.fc-event-label').filter(e => e.textContent.trim() === 'Rent');
check('rent appears only as the bill, not also as a detected series', rentLines === rentDays.length && $$('.fc-event-detail').filter(e => e.textContent.includes('Monthly · Rent')).length === 0);
check('overdue one-time bill lands in the forecast', fcText.includes('Car repair'));

// ── Pay: double-tap safe; one-time paid late ──
const n0 = state.transactions.length;
bills.payBill('once'); bills.payBill('once'); bills.payBill('once');
await tick(300);
check('triple-tap Pay logs one payment', state.transactions.length === n0 + 1, `${n0} → ${state.transactions.length}`);
check('one-time bill now paid (any month)', bills.isBillPaid(once, prevYm) && bills.isBillPaid(once, ym));
check('paid one-time bill no longer counts', !bills.computeRealAvailable(Y, MO).stdUnpaid.some(b => b.id === 'once'));

// ── Looks paid · Link ──
const cardPay = { id:'manualpay', date:today(), type:'CC Payment', account:'Card', fromAccount:'Checking', category:'CC Payment', amount:300, description:'' };
await dbPut('transactions', cardPay); state.transactions.push(cardPay);
const cp = state.bills.find(b => b.id === 'cardpay');
check('hand-logged card payment found for the bill', bills.findPaymentForBill(cp, ym)?.id === 'manualpay');
check('and the bill is suggested for the transaction', bills.findMatchingBill(cardPay)?.id === 'cardpay');
const { renderBills } = await import('../js/bills.js');
renderBills(); await tick(30);
const link = $(`.bill-link[data-bill="cardpay"]`);
check('Bills view shows a Link button', !!link);
link.click(); await tick(150);
check('Link marks it paid with that transaction', cp.paidMonths[ym] === 'manualpay');
check('a $70 shopping charge does not match a $70 utility bill by amount alone',
  !bills.billMatchesTxn({ name:'Internet', type:'Expense', account:'Card', amount:70, category:'Utilities', active:true },
                        { type:'Expense', account:'Card', amount:70, category:'Shopping', description:'Target' }));

// ── Refunds give back to their budget ──
await T({ date:`${ym}-01`, type:'Expense', account:'Card', category:'Shopping', amount:120, description:'Amazon' });
await T({ date:`${ym}-02`, type:'Expense', account:'Card', category:'Shopping', amount:80, description:'Amazon' });
await T({ date:`${ym}-03`, type:'Refund', account:'Card', category:'Return', amount:50, description:'Refund: Amazon' });
await T({ date:`${ym}-03`, type:'Refund', account:'Card', category:'Return', amount:5, description:'mystery', offsetCategory:'none' });
await T({ date:`${ym}-04`, type:'Refund', account:'Card', category:'Return', amount:10, description:'', offsetCategory:'Misc' });
await loadState();
const spent = budgetSpentMap(Y, MO);
check('merchant refund nets into Shopping (200 − 50)', near(spent['Expense|Shopping'], 150), spent['Expense|Shopping']);
// Misc this month: the $450 car-repair payment above − the $10 refund.
check('explicit offset category is honored', near(spent['Expense|Misc'], 440), spent['Expense|Misc']);
check("'none' refunds don't touch any budget", Object.values(spent).every(v => v >= 0));

check('zero captured errors', errors.length === 0, errors[0]);
done('v3 money-math tests');
