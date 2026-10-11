/* v3.1 Section D (items 26–36): everyday features. All sample data —
   generic names and round amounts, dates relative to today. */
import { bootEnv, makeChecker, tick, domHelpers } from './_env.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const { $, $$, click, type } = domHelpers(dom);
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));

const { state, dbPut, dbDel, loadState, saveFlags, dataVersion } = await import('../js/db.js');
const util = await import('../js/util.js');
const app = await import('../js/app.js'); await tick(150);
const { closeSheet } = await import('../js/sheet.js');

const D = (n) => util.toLocalISO(util.addDays(new Date(), n));     // today ± n days, local
const T = util.today();
let seq = 0;
const txn = (o) => ({ id: 'e' + (++seq) + Math.random().toString(36).slice(2, 6), description: '', ...o });

await dbPut('accounts', { id:'a1', name:'Checking', type:'Checking', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'Savings', type:'Savings', active:true, order:1 });
await dbPut('accounts', { id:'a3', name:'Card', type:'Credit Card', active:true, order:2 });
await dbPut('accounts', { id:'a4', name:'Card B', type:'Credit Card', active:true, order:3 });
for (const [k, list] of Object.entries({ Expense:['Groceries','Restaurants','Rent','Utilities','Streaming','Gas'], Income:['Salary','Gig','Gifts'], Refund:['Return'], Investment:['Brokerage'], CCPayment:['CC Payment'], LoanPayment:['Loan Payment'], Transfer:['Transfer'], BalanceTransfer:['Balance Transfer'] })){
  await dbPut('categories', { id:k, list });
}
await dbPut('balanceAnchors', { id:'an1', account:'Checking', month: util.currentYm(), amount: 2000 });
await dbPut('balanceAnchors', { id:'an2', account:'Card', month: util.currentYm(), amount: 300 });

/* ── 26. Safe to spend per day until payday ── */
// Paychecks every 14 days, last one 4 days ago, split into two same-day
// deposits plus a small one the next day (one payday, not three).
for (let k = 0; k < 7; k++){
  const d = -4 - 14 * k;
  await dbPut('transactions', txn({ date: D(d), type:'Income', account:'Checking', category:'Salary', amount: 900 }));
  await dbPut('transactions', txn({ date: D(d), type:'Income', account:'Savings', category:'Salary', amount: 100 }));
  await dbPut('transactions', txn({ date: D(d + 1), type:'Income', account:'Checking', category:'Salary', amount: 20 }));
}
// Bigger but irregular side income — mustn't be taken for the paycheck.
for (const d of [-2, -9, -11, -30, -31, -58, -90]) await dbPut('transactions', txn({ date: D(d), type:'Income', account:'Checking', category:'Gig', amount: 700 }));
const dueIn = (n) => util.addDays(new Date(), n).getDate();
await dbPut('bills', { id:'b-soon', name:'Power', recurrence:'monthly', type:'Expense', account:'Checking', category:'Utilities', amount: 120, dueDay: dueIn(3), active:true, paidMonths:{} });
await dbPut('bills', { id:'b-late', name:'Rent', recurrence:'monthly', type:'Expense', account:'Checking', category:'Rent', amount: 1000, dueDay: dueIn(16), active:true, paidMonths:{} });
await dbPut('bills', { id:'b-cc', name:'Card bill', recurrence:'auto-cc', linkedAccount:'Card', closeDay: dueIn(5), graceDays: 0, active:true, paidMonths:{} });
await loadState();
state.flags.anchorsV3 = true;
await tick(700);

const pd = await import('../js/payday.js');
{
  const sched = pd.detectPaySchedule(T);
  check('paycheck found among incomes (Salary, not the bigger irregular Gig)', sched?.category === 'Salary', JSON.stringify(sched));
  check('split / next-day deposits count as one payday → every 14 days', sched?.step === 14 && sched.last === D(-4));
  const nxt = pd.nextPayday(T);
  check('next payday = last + 14 days', nxt && util.toLocalISO(nxt.date) === D(10) && !nxt.expectedToday);
  check('a payday due today but not logged yet is flagged', pd.nextPayday(D(10)).expectedToday === true && util.toLocalISO(pd.nextPayday(D(10)).date) === D(24));

  const s = pd.safeToSpend(T);
  const { balanceLatest } = await import('../js/effects.js');
  check('safe to spend starts from checking only (not savings)', s.cash === balanceLatest('Checking'));
  const labels = s.due.map(e => e.label);
  check('bills due before payday are subtracted', labels.includes('Power'));
  check('bills due after payday are not', !labels.includes('Rent'));
  check('arithmetic: checking − due − cards = total; ÷ days', s.total === util.round2(s.cash - s.dueBefore - s.cardDeduct) && s.days === 10 && s.perDay === util.round2(s.total / 10));

  // A card selected in Real available is subtracted once — its auto-pay bill isn't added on top.
  const withBill = s.due.some(e => e.acct === 'Card');
  state.flags.realAvailCards = ['Card'];
  const s2 = pd.safeToSpend(T);
  check('a card subtracted in Real available isn\'t double-counted through its bill',
    withBill && !s2.due.some(e => e.acct === 'Card') && s2.cardDeduct === 300);
  state.flags.realAvailCards = [];

  // Paying the soon bill takes it out.
  const ym = D(3).slice(0, 7);
  state.bills.find(b => b.id === 'b-soon').paidMonths = { [ym]: 'x' };
  check('a paid bill no longer counts', !pd.safeToSpend(T).due.some(e => e.label === 'Power'));
  state.bills.find(b => b.id === 'b-soon').paidMonths = {};

  // Home card.
  app.navigate('home'); await tick(40);
  const card = $('#view-home .home-card[data-card="safe"]');
  check('Home shows the Safe to spend card', !!card && /\/day/.test(card.textContent) && /10 days until payday/.test(card.textContent) && /estimated/.test(card.textContent));
  check('…with the breakdown', /Due before payday/.test(card.textContent) && /Until payday/.test(card.textContent));

  // Manual payday.
  await click($('#safe-config'), 40);
  check('⚙ opens Payday, showing what was detected', /From your Salary deposits/.test($('#sheetBody').textContent) && /every ~14 days/.test($('#sheetBody').textContent));
  await click($('#pd-mode .seg-btn[data-v="manual"]'), 20);
  type('#pd-date', D(5));
  await click($('#pd-every .seg-btn[data-v="month"]'), 20);
  check('changing the cadence keeps the date you typed', $('#pd-date').value === D(5));
  await click($('#pd-save'), 60);
  check('saved as a manual payday', state.flags.payday?.mode === 'manual' && state.flags.payday.every === 'month' && state.flags.payday.anchor === D(5));
  check('card follows it', new RegExp(`5 days until payday`).test($('#view-home .home-card[data-card="safe"]').textContent) && !/estimated/.test($('#view-home .home-card[data-card="safe"]').textContent));

  // Monthly keeps the day: the 31st → Feb 28 → Mar 31.
  state.flags.payday = { mode:'manual', anchor:'2027-01-31', every:'month' };
  check('monthly paydays keep their day (no drift)', util.toLocalISO(pd.nextPayday('2027-02-01').date) === '2027-02-28' && util.toLocalISO(pd.nextPayday('2027-03-01').date) === '2027-03-31');
  state.flags.payday = { mode:'manual', anchor: D(-1), every:'week' };
  check('weekly from a past payday rolls forward', util.toLocalISO(pd.nextPayday(T).date) === D(6));
  state.flags.payday = { mode:'auto' };
  await saveFlags();

  // No regular income → asks to set payday.
  const saved = state.transactions;
  state.transactions = saved.filter(t => t.category !== 'Salary');
  check('only irregular income → nothing detected', pd.detectPaySchedule(T) === null);
  dataVersion.n++;                       // derived balances re-index
  app.navigate('home'); app.renderAll(); await tick(40);
  check('…the card offers "Set payday"', /Set payday/.test($('#view-home .home-card[data-card="safe"]')?.textContent || ''));
  state.transactions = saved;
  dataVersion.n++;

  // Only for the current month.
  await app.stepMonth(-1); await tick(40);
  check('not shown while browsing another month', !$('#view-home .home-card[data-card="safe"]'));
  await app.stepMonth(1); await tick(40);
  const { openHomeCustomizeSheet } = await import('../js/home.js');
  openHomeCustomizeSheet(); await tick(20);
  check('listed in Customize Home', $$('.hc-row').some(r => /Safe to spend/.test(r.textContent)));
  closeSheet(); await tick(20);
}

check('zero captured errors', errors.length === 0, errors[0]);
done('everyday tests');
