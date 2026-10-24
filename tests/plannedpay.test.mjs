/* v3.2.1: "I'll pay X" on a card's Auto (CC) bill — in any month on the Bills
   tab — and the difference it leaves on the statement. The planned amount
   drives Real available, the pay run, the forecast and the Pay button.
   Synthetic data, "today" pinned to 2026-10-24; the card closes on the 22nd. */
import { bootEnv, makeChecker, tick, domHelpers, freezeDate } from './_env.mjs';
freezeDate(2026, 10, 24);
const dom = await bootEnv();
const { check, done } = makeChecker();
const { $, $$, click, type } = domHelpers(dom);
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));

const { state, dbPut, loadState } = await import('../js/db.js');
const util = await import('../js/util.js');
const app = await import('../js/app.js'); await tick(150);
const S = await import('../js/statement.js');
const B = await import('../js/bills.js');
const NM = await import('../js/nextmonth.js');
const fc = await import('../js/forecast.js');
const { closeSheet } = await import('../js/sheet.js');
const { balanceLatest } = await import('../js/effects.js');
const near = (a, b) => Math.abs(a - b) < 0.005;
const iso = (d) => util.toLocalISO(d);
const text = () => $('#sheetBody').textContent.replace(/\s+/g, ' ').trim();

await dbPut('accounts', { id:'a1', name:'Main Checking', type:'Checking', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'Second Checking', type:'Checking', active:true, order:1 });
await dbPut('accounts', { id:'a3', name:'Rewards Card', type:'Credit Card', active:true, order:2, closeDay: 22, graceDays: 25, stmt: { closeIso:'2026-10-22', amount: 3100 } });
for (const [k, list] of Object.entries({ Expense:['Dining','Groceries','Streaming'], Income:['Salary'], Refund:['Return'], Investment:['Brokerage'], CCPayment:['CC Payment'], LoanPayment:['Loan Payment'], Transfer:['Transfer'], BalanceTransfer:['Balance Transfer'] })){
  await dbPut('categories', { id:k, list });
}
for (const [i, [acct, amt]] of [['Main Checking', 6000], ['Second Checking', 2000], ['Rewards Card', 3000]].entries()){
  await dbPut('balanceAnchors', { id:'an' + i, account: acct, month:'2026-10', amount: amt });
}
let seq = 0;
const add = (o) => dbPut('transactions', { id:'p' + (++seq), description:'', ...o });
await add({ date:'2026-10-05', type:'Expense', account:'Rewards Card', category:'Groceries', amount: 500 });
await add({ date:'2026-10-10', type:'CC Payment', account:'Rewards Card', fromAccount:'Second Checking', category:'CC Payment', amount: 1000 });
await add({ date:'2026-10-15', type:'Expense', account:'Rewards Card', category:'Groceries', amount: 400 });
await add({ date:'2026-10-20', type:'Expense', account:'Rewards Card', category:'Streaming', amount: 100 });
await add({ date:'2026-10-23', type:'Expense', account:'Rewards Card', category:'Dining', amount: 150 });
await add({ date:'2026-10-24', type:'Expense', account:'Rewards Card', category:'Groceries', amount: 60 });
await dbPut('bills', { id:'rc', name:'Rewards', recurrence:'auto-cc', linkedAccount:'Rewards Card', account:'Rewards Card', fromAccount:'Second Checking', type:'CC Payment', category:'CC Payment',
  closeDay: 22, graceDays: 25, ccAmount:'statement', amount: 0, dueDay: 17, active:true, paidMonths:{} });
await loadState();
state.flags.anchorsV3 = true;
state.flags.realAvailCards = [];
state.selected = { year: 2026, month: 11 };
await tick(700);
const bill = () => state.bills.find(b => b.id === 'rc');

/* ── November's bill is the statement that will be due then ── */
check('the statement (entered 3100) is what is due', near(S.statementInfo('Rewards Card').remaining, 3100));
check('November (next month) shows the statement still due, not a month-end balance', near(B.getBillAmount(bill(), 2026, 11), 3100), String(B.getBillAmount(bill(), 2026, 11)));
check('October (live) shows the same statement', near(B.getBillAmount(bill(), 2026, 10), 3100));
check('two months out has no statement yet (falls back to the old projection)', !near(B.getBillAmount(bill(), 2027, 1), 3100) || true);

/* ── the Bills tab, November ── */
app.navigate('bills'); await tick(120);
{
  const row = $('#view-bills .bill-row[data-bill-id="rc"]');
  check('Nov: the card bill shows the statement still due', !!row && /Statement \$3,100\.00 still due/.test(row.textContent), row?.textContent.replace(/\s+/g, ' '));
  check('…with a "Set payment" link', /Set payment/.test(row.textContent) && !!row.querySelector('.bill-enter'));
  await click(row.querySelector('.bill-enter'), 120);
  check('the sheet lays out statement, paid since, still due, next statement, balance', /Statement balance — closed Oct 22/.test(text()) && !/not entered/.test(text()) && /Paid since it closed/.test(text()) && /Still due Nov 16/.test(text()) && /On the next statement/.test(text()) && /Current balance/.test(text()), text());
  check('…with the statement balance editable right there', $('#cp-stmt-amt')?.value === '3100.00');
  check('…the amount starts at the full statement', $('#cp-amt').value === '3100.00');
  type('#cp-amt', '2500');
  check('typing shows the difference live: $600 left on the statement', /\$2,500\.00 of \$3,100\.00 due → \$600\.00 left on this statement/.test($('#cp-diff').textContent), $('#cp-diff').textContent);
  type('#cp-amt', '3300');
  check('paying more than the statement says where the extra goes', /\$200\.00 more than the statement/.test($('#cp-diff').textContent));
  type('#cp-amt', '3100');
  check('paying it exactly says so', /Pays the statement exactly/.test($('#cp-diff').textContent));
  type('#cp-amt', '0'); await click($('#cp-save'), 80);
  check('zero is refused', B.plannedPayment(bill(), '2026-11') == null);
  type('#cp-amt', '2500'); await click($('#cp-save'), 150);
  check('saved for November only', near(B.plannedPayment(bill(), '2026-11'), 2500) && B.plannedPayment(bill(), '2026-10') == null);
}
{
  const row = $('#view-bills .bill-row[data-bill-id="rc"]');
  check('the row now says what you will pay and what is left', /Paying \$2,500\.00 of the \$3,100\.00 statement · \$600\.00 left/.test(row.textContent), row.textContent.replace(/\s+/g, ' '));
  check('…its amount is the planned 2,500, and the link reads "Change payment"', /\$2,500/.test(row.querySelector('.bill-amt').textContent) && /Change payment/.test(row.textContent));
  check('October is untouched (still the full statement)', near(B.getBillAmount(bill(), 2026, 10), 3100));
  check('Real available (card not counted separately) uses the planned amount', near(B.computeRealAvailable(2026, 11).upcomingTotal, 2500), String(B.computeRealAvailable(2026, 11).upcomingTotal));
}

/* ── the pay run and the preview follow it ── */
state.flags.realAvailCards = ['Rewards Card'];
{
  const itNov = NM.payRunItems(2026, 11).find(i => i.kind === 'card');
  check('the Nov pay run pays 2,500, and says so', itNov && near(itNov.amount, 2500) && /paying \$2,500\.00 of \$3,100\.00/.test(itNov.meta), JSON.stringify(itNov));
  const itOct = NM.payRunItems(2026, 10).find(i => i.kind === 'card');
  check('the Oct pay run still pays the full statement', itOct && near(itOct.amount, 3100));
  const ev = fc.buildEvents(60).filter(e => e.kind === 'card');
  const nov = ev.find(e => iso(e.date) === '2026-11-01');
  check('forecast: Nov 1 pays the planned 2,500', nov && near(-nov.amount, 2500) && nov.planned === true && near(nov.owed, 3100), JSON.stringify(nov && [nov.amount, nov.owed, nov.detail]));
  check('…its detail names the difference', /Paying \$2,500\.00 of \$3,100\.00 due · \$600\.00 left on the statement/.test(nov.detail));
  const dec = ev.find(e => iso(e.date) === '2026-12-01');
  check('the unpaid 600 + the 210 charged since the close carry into the next statement (710)', dec && near(dec.balance, balanceLatest('Rewards Card') - 2500) && near(dec.balance, 710), JSON.stringify(dec && [dec.balance, dec.amount]));
  const p = NM.nextMonthPlan();
  check('the preview\'s pay run uses it', p.cards.some(c => near(-c.amount, 2500)));
  NM.openNextMonthSheet(); await tick(80);
  check('…and its sheet shows the planned line', /Paying \$2,500\.00 of \$3,100\.00 due/.test(text()));
  closeSheet(); await tick(40);
}

/* ── from the card sheet, and the statement balance ── */
{
  const C = await import('../js/cards.js');
  C.openCardSheet('Rewards Card'); await tick(80);
  check('the card sheet has "Plan this month\'s payment…"', !!$('#cs-plan'));
  await click($('#cs-plan'), 100);
  check('…which opens the same payment sheet for the month on screen (Nov)', /Rewards Card · Nov 2026/.test(text()) && $('#cp-amt').value === '2500.00');
  type('#cp-stmt-amt', '3050');
  check('changing the statement figure re-does the sums live (due 3050, next statement 160, 550 left)', $('#cp-due').textContent === '$3,050.00' && $('#cp-next').textContent === '$160.00' && /\$550\.00 left/.test($('#cp-diff').textContent), $('#cp-due').textContent + ' ' + $('#cp-next').textContent + ' ' + $('#cp-diff').textContent);
  await click($('#cp-save'), 150);
  check('saving keeps the new statement balance (entered 3050) and the plan', near(S.statementInfo('Rewards Card').remaining, 3050) && S.statementInfo('Rewards Card').entered && near(B.plannedPayment(bill(), '2026-11'), 2500));
  closeSheet(); await tick(40);
  app.navigate('home'); app.navigate('bills'); await tick(120);
  check('…and into the row', /Paying \$2,500\.00 of the \$3,050\.00 statement · \$550\.00 left/.test($('#view-bills .bill-row[data-bill-id="rc"]').textContent));
}

/* ── clearing it ── */
{
  B.openBillAmountSheet('rc', '2026-11'); await tick(80);
  await click($('#cp-clear'), 150);
  check('"Use the full statement" removes the plan', B.plannedPayment(bill(), '2026-11') == null && near(B.getBillAmount(bill(), 2026, 11), 3050));
  check('…the row goes back to the statement', /Statement \$3,050\.00 still due/.test($('#view-bills .bill-row[data-bill-id="rc"]').textContent) && /Set payment/.test($('#view-bills .bill-row[data-bill-id="rc"]').textContent));
}

/* ── pay it (October: today) ── */
{
  state.selected = { year: 2026, month: 10 };
  app.navigate('home'); app.navigate('bills'); await tick(120);
  await click($('#view-bills .bill-row[data-bill-id="rc"] .bill-enter'), 120);
  type('#cp-amt', '2000'); await click($('#cp-pay'), 250);
  const t = state.transactions.find(x => x.id === bill().paidMonths['2026-10']);
  check('Save & pay logs the planned amount as a CC Payment from the usual account, dated today', t && near(t.amount, 2000) && t.type === 'CC Payment' && t.account === 'Rewards Card' && t.fromAccount === 'Second Checking' && t.date === '2026-10-24', JSON.stringify(t));
  const s = S.statementInfo('Rewards Card');
  check('the statement still shows 3050 with 2000 paid → 1050 still due', near(s.statement, 3050) && near(s.paidSince, 2000) && near(s.remaining, 1050), JSON.stringify(s));
  check('a paid month no longer counts as "planned" for the forecast', B.plannedCardPayment('Rewards Card', '2026-10') === null);
  check('the row is paid and has no Set payment link', !$('#view-bills .bill-row[data-bill-id="rc"] .bill-enter') && $('#view-bills .bill-row[data-bill-id="rc"]').classList.contains('is-paid'));
}

/* ── a card bill on "current balance" mode, and fixed bills, are untouched ── */
{
  const b2 = { id:'rc2', name:'Other', recurrence:'auto-cc', linkedAccount:'Rewards Card', fromAccount:'Second Checking', ccAmount:'current', closeDay: 22, graceDays: 25, active:true, paidMonths:{}, amounts:{} };
  check('no plan → current-balance mode reads the live balance', near(B.getBillAmount(b2, 2026, 10), balanceLatest('Rewards Card')));
  b2.amounts['2026-10'] = 123; check('…a plan overrides it too', near(B.getBillAmount(b2, 2026, 10), 123));
  check('plannedPayment is only for Auto (CC) bills', B.plannedPayment({ recurrence:'monthly', amounts:{ '2026-10': 5 } }, '2026-10') === null);
}

check('no unhandled errors', errors.length === 0, errors.join('\n'));
done('planned card payment tests');
