/* v3.2: forecast + payday fixes.
   - paychecks are found after a job change and follow a twice-a-month pay
   - a paycheck logged ahead of payday isn't "the next payday" or projected twice
   - a recurring charge a bill already covers (same card, price, time of month) is skipped
   - cards you pay in full are one payment on pay-run day; their charges aren't cash movements
   - an unpaid monthly bill past its day is due now
   Synthetic data, "today" pinned to 2026-10-24. */
import { bootEnv, makeChecker, tick, freezeDate } from './_env.mjs';
freezeDate(2026, 10, 24);
const dom = await bootEnv();
const { check, done } = makeChecker();
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));

const { state, dbPut, dbDel, loadState } = await import('../js/db.js');
const util = await import('../js/util.js');
await import('../js/app.js'); await tick(150);
const fc = await import('../js/forecast.js');
const sub = await import('../js/subscriptions.js');
const pd = await import('../js/payday.js');
const B = await import('../js/bills.js');
const { balanceLatest } = await import('../js/effects.js');
const near = (a, b) => Math.abs(a - b) < 0.005;
const iso = (d) => util.toLocalISO(d);

await dbPut('accounts', { id:'a1', name:'Main Checking', type:'Checking', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'Rewards Card', type:'Credit Card', active:true, order:1 });
await dbPut('accounts', { id:'a3', name:'Cafe Card', type:'Credit Card', active:true, order:2 });
for (const [k, list] of Object.entries({ Expense:['Internet','Streaming','Gym','Groceries','Rent'], Income:['Salary','Gig'], Refund:['Return'], Investment:['Brokerage'], CCPayment:['CC Payment'], LoanPayment:['Loan Payment'], Transfer:['Transfer'], BalanceTransfer:['Balance Transfer'] })){
  await dbPut('categories', { id:k, list });
}
for (const [i, [acct, amt]] of [['Main Checking', 6000], ['Rewards Card', 1200], ['Cafe Card', 300]].entries()){
  await dbPut('balanceAnchors', { id:'an' + i, account: acct, month:'2026-10', amount: amt });
}
let seq = 0;
const add = (o) => dbPut('transactions', { id:'x' + (++seq), description:'', ...o });

/* An old part-time job: weekly, small, uneven. A new job: 2000 on the 10th and 25th. */
{
  let d = new Date(2025, 10, 5);
  for (let i = 0; d < new Date(2026, 4, 7); i++, d = util.addDays(d, 7)){
    await add({ date: iso(d), type:'Income', account:'Main Checking', category:'Salary', amount: 150 + (i * 37) % 150 });
  }
  for (const dt of ['2026-06-10','2026-06-25','2026-07-10','2026-07-24','2026-08-10','2026-08-25','2026-09-10','2026-09-25','2026-10-10']){
    await add({ date: dt, type:'Income', account:'Main Checking', category:'Salary', amount: 2000 });
  }
  // Payroll was approved early, so the 25th is already in the account.
  await add({ id:'early', date:'2026-10-25', type:'Income', account:'Main Checking', category:'Salary', amount: 2000 });
  // Irregular side income mustn't look like a paycheck.
  for (const dt of ['2026-06-03','2026-07-19','2026-08-02','2026-09-28','2026-10-15']) await add({ date: dt, type:'Income', account:'Main Checking', category:'Gig', amount: 40 + (dt.charCodeAt(9) % 7) * 11 });
}
await loadState();
state.flags.anchorsV3 = true;
await tick(600);

/* ── semi-monthly slots, directly ── */
{
  const D = (y, m, d) => new Date(y, m - 1, d);
  check('the 10th and 25th (one weekend shift) → [10, 25]', JSON.stringify(sub.semiMonthlySlots([D(2026,6,10),D(2026,6,25),D(2026,7,10),D(2026,7,24),D(2026,8,10),D(2026,8,25)])) === '[10,25]');
  const step14 = []; for (let d = D(2026, 3, 6); d < D(2026, 10, 1); d = util.addDays(d, 14)) step14.push(d);
  check('a plain 14-day step drifts across months → not semi-monthly', sub.semiMonthlySlots(step14) === null);
  const weekly = []; for (let d = D(2026, 3, 6); d < D(2026, 10, 1); d = util.addDays(d, 7)) weekly.push(d);
  check('weekly → not semi-monthly', sub.semiMonthlySlots(weekly) === null);
  check('too little history → null', sub.semiMonthlySlots([D(2026,9,10), D(2026,9,25)]) === null);
}

/* ── income detection survives a job change ── */
{
  const inc = sub.detectRecurring('Income');
  const s = inc.find(r => r.category === 'Salary');
  check('the new paycheck is detected despite a year of the old one', !!s, JSON.stringify(inc.map(r => r.label)));
  check('…at the new amount', s && near(s.medAmt, 2000));
  check('…as a twice-a-month pay on the 10th and 25th', s && JSON.stringify(s.slots) === '[10,25]', JSON.stringify(s?.slots));
  check('irregular side income is not mistaken for one', !inc.some(r => r.category === 'Gig'));
}

/* ── the forecast projects paychecks, once ── */
{
  const ev = fc.buildEvents(50).filter(e => e.kind === 'income');
  const ds = ev.map(e => iso(e.date));
  check('paychecks project on the 10th and 25th (Nov 10, Nov 25, Dec 10)', JSON.stringify(ds) === JSON.stringify(['2026-11-10', '2026-11-25', '2026-12-10']), JSON.stringify(ds));
  check('the early-logged Oct 25 paycheck is NOT projected again', !ds.includes('2026-10-25'));
  // Control: take it out of the books and it's projected.
  await dbDel('transactions', 'early'); await loadState(); state.flags.anchorsV3 = true; await tick(300);
  const ds2 = fc.buildEvents(45).filter(e => e.kind === 'income').map(e => iso(e.date));
  check('(control) un-logged, the Oct 25 paycheck is projected', ds2[0] === '2026-10-25', JSON.stringify(ds2));
}

/* ── safe to spend with an early-logged paycheck ── */
{
  const s0 = pd.safeToSpend();
  check('payday not logged yet → the 25th is tomorrow (1 day)', iso(s0.pay.date) === '2026-10-25' && s0.days === 1, `${iso(s0.pay.date)} ${s0.days}`);
  check('…detected as twice a month', pd.detectPaySchedule('2026-10-24')?.step === 'semi');
  check('payday TODAY, not logged → flagged, window runs to the next', (() => { const n = pd.nextPayday('2026-10-25'); return n.expectedToday === true && iso(n.date) === '2026-11-10'; })());
  await add({ id:'early', date:'2026-10-25', type:'Income', account:'Main Checking', category:'Salary', amount: 2000 });
  await loadState(); state.flags.anchorsV3 = true; await tick(300);
  const s1 = pd.safeToSpend();
  check('paycheck logged ahead → the next payday is Nov 10 (17 days)', iso(s1.pay.date) === '2026-11-10' && s1.days === 17, `${iso(s1.pay.date)} ${s1.days}`);
  check('…and its cash includes that paycheck', near(s1.cash, balanceLatest('Main Checking')));
  check('…per-day = total / days', near(s1.perDay, util.round2(s1.total / 17)));
  const n = pd.nextPayday('2026-10-25');
  check('payday today but already logged → not "expected today"', n.expectedToday === false && iso(n.date) === '2026-11-10');
  state.flags.payday = { mode:'manual', anchor:'2026-10-10', every:'2weeks' };
  const m = pd.nextPayday('2026-10-24');
  check('a manual 2-week payday also skips the paycheck already logged (Oct 24 ≈ logged Oct 25)', iso(m.date) === '2026-11-07', iso(m.date));
  state.flags.payday = { mode:'auto' };
}

/* ── recurring charges a bill already covers ── */
{
  // "Fiberco" internet: monthly on the card, charged around the 30th/31st, $70.
  for (const dt of ['2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30']) await add({ date: dt, type:'Expense', account:'Rewards Card', category:'Internet Bill', description:'Fiberco', amount: 70 });
  // "Streamo": $15 on the 11th, on the card.
  for (const dt of ['2026-07-11', '2026-08-11', '2026-09-11', '2026-10-11']) await add({ date: dt, type:'Expense', account:'Rewards Card', category:'Streaming', description:'Streamo', amount: 15 });
  // "Gymco": $30 on the 28th, on the card.
  for (const dt of ['2026-07-28', '2026-08-28', '2026-09-28']) await add({ date: dt, type:'Expense', account:'Rewards Card', category:'Gym', description:'Gymco', amount: 30 });
  // A cash charge (checking): $9 on the 3rd.
  for (const dt of ['2026-07-03', '2026-08-03', '2026-09-03', '2026-10-03']) await add({ date: dt, type:'Expense', account:'Main Checking', category:'Misc', description:'Cloudbox', amount: 9 });
  // The user's own Internet bill: due the 2nd, $70, on the same card, different name + category.
  await dbPut('bills', { id:'bi', name:'Home internet', recurrence:'monthly', type:'Expense', account:'Rewards Card', category:'', amount: 70, dueDay: 2, active:true, paidMonths:{ '2026-10':'x1' } });
  await loadState(); state.flags.anchorsV3 = true; await tick(300);
  const fiber = sub.detectRecurring('Expense').find(r => r.label.toLowerCase().includes('fiberco'));
  check('(the Fiberco series is detected)', !!fiber && fiber.primaryAccount === 'Rewards Card');
  check('same card + same price + same time of month → covered by the bill', B.seriesCoveredByBill(fiber));
  const labels = fc.buildEvents(60).map(e => e.label);
  check('the forecast no longer counts Fiberco next to the Home internet bill', !labels.some(l => /fiberco/i.test(l)));
  // A price that doesn't match is a different thing.
  const bi = state.bills.find(b => b.id === 'bi'); bi.amount = 40; await dbPut('bills', bi);
  check('(control) a different price is NOT covered', !B.seriesCoveredByBill(fiber));
  bi.amount = 70; bi.account = 'Cafe Card'; await dbPut('bills', bi);
  check('(control) another card is NOT covered', !B.seriesCoveredByBill(fiber));
  bi.account = 'Rewards Card'; bi.dueDay = 17; await dbPut('bills', bi);
  check('(control) a different day of the month is NOT covered', !B.seriesCoveredByBill(fiber));
  bi.dueDay = 2; await dbPut('bills', bi);
  check('…same name/category still covers, as before', (() => { const b2 = { ...bi, dueDay: 17, amount: 5, category:'Internet Bill' }; state.bills.splice(state.bills.indexOf(bi), 1, b2); const r = B.seriesCoveredByBill(fiber); state.bills.splice(state.bills.indexOf(b2), 1, bi); return r; })());
}

/* ── cards you pay in full ── */
{
  state.flags.realAvailCards = ['Rewards Card'];
  const bal = balanceLatest('Rewards Card');
  const ev = fc.buildEvents(45);
  const cards = ev.filter(e => e.kind === 'card');
  check('one payment per pay-run day (Nov 1, Dec 1)', cards.map(e => iso(e.date)).join() === '2026-11-01,2026-12-01', cards.map(e => iso(e.date)).join());
  const nov = cards[0];
  const before = ev.filter(e => e.cardCharge === 'Rewards Card' && iso(e.date) < '2026-11-01');
  check('Nov 1 = the balance carried + the card charges that land before it', near(-nov.amount, bal + util.round2(before.reduce((s, e) => s - e.amount, 0))) && before.length >= 1, `${nov.amount} bal ${bal} before ${before.map(e => e.label)}`);
  check('…it names the pieces', /Balance/.test(nov.detail) && near(nov.balance, bal));
  check('Gymco (10/28) is in that payment, Streamo (11/11) is not', before.some(e => /gymco/i.test(e.label)) && !before.some(e => /streamo/i.test(e.label)));
  const dec = cards[1];
  check('Dec 1 = just the charges since', near(dec.balance, 0) && -dec.amount > 0 && ev.filter(e => e.cardCharge && iso(e.date) >= '2026-11-01' && iso(e.date) < '2026-12-01').length > 0
    && near(-dec.amount, ev.filter(e => e.cardCharge === 'Rewards Card' && iso(e.date) >= '2026-11-01' && iso(e.date) < '2026-12-01').reduce((s, e) => s - e.amount, 0)));
  check('card charges are tagged, cash charges are not', ev.filter(e => /cloudbox/i.test(e.label)).every(e => !e.cardCharge) && ev.filter(e => /streamo/i.test(e.label)).every(e => e.cardCharge === 'Rewards Card'));
  // The chart: charges aren't cash movements, the payment is.
  const start = fc.currentCash();
  const series = fc.buildSeries(ev, start, 45);
  const at = (d) => series.find(s => s.iso === d).balance;
  check('cash does not move on a card charge day (Oct 28: Gymco)', near(at('2026-10-28'), at('2026-10-27')) || ev.some(e => iso(e.date) === '2026-10-28' && !e.cardCharge));
  const oct31 = at('2026-10-31'), nov1 = at('2026-11-01');
  const cashOnNov1 = ev.filter(e => iso(e.date) === '2026-11-01' && !e.cardCharge).reduce((s, e) => s + e.amount, 0);
  check('cash drops by the whole payment on Nov 1', near(nov1 - oct31, cashOnNov1) && cashOnNov1 <= nov.amount, `${nov1 - oct31} vs ${cashOnNov1}`);
  // Safe to spend subtracts the card balance on its own — the payment event isn't counted twice.
  const s = pd.safeToSpend();
  check('safe to spend: no pay-in-full event or card charge in "due before payday"', !s.due.some(e => e.kind === 'card' || e.cardCharge));
  // A card that is NOT checked pays like before (charges as cash on their day).
  state.flags.realAvailCards = [];
  const plain = fc.buildEvents(45);
  check('(control) with no pay-in-full cards: no card events, charges are plain cash', !plain.some(e => e.kind === 'card' || e.cardCharge) && plain.some(e => /streamo/i.test(e.label)));
  state.flags.realAvailCards = ['Rewards Card'];

  // Bills tied to the card
  await dbPut('bills', { id:'ac', name:'Rewards payment', recurrence:'auto-cc', linkedAccount:'Rewards Card', fromAccount:'Main Checking', closeDay: 10, graceDays: 21, active:true, paidMonths:{} });
  await dbPut('bills', { id:'cp', name:'Rewards minimum', recurrence:'monthly', type:'CC Payment', account:'Rewards Card', fromAccount:'Main Checking', amount: 50, dueDay: 20, active:true, paidMonths:{} });
  await loadState(); state.flags.anchorsV3 = true; state.flags.realAvailCards = ['Rewards Card']; await tick(300);
  const ev2 = fc.buildEvents(45);
  check('an auto-CC bill for a pay-in-full card adds nothing (the pay-run payment covers it)', !ev2.some(e => e.label === 'Rewards payment'));
  check('…nor does a fixed CC Payment bill for that card', !ev2.some(e => e.label === 'Rewards minimum'));
  state.flags.realAvailCards = [];
  const ev3 = fc.buildEvents(45);
  check('(control) un-checked, the same card\'s bills are modeled again', ev3.some(e => e.label === 'Rewards payment') && ev3.some(e => e.label === 'Rewards minimum'));
  state.flags.realAvailCards = ['Rewards Card'];
  // Expense bill charged to the card: tagged, not a cash bill.
  await dbPut('bills', { id:'bs', name:'Streaming plan', recurrence:'monthly', type:'Expense', account:'Rewards Card', category:'Cinema', amount: 12, dueDay: 8, active:true, paidMonths:{} });
  await loadState(); state.flags.anchorsV3 = true; state.flags.realAvailCards = ['Rewards Card']; await tick(300);
  const bsEv = fc.buildEvents(45).filter(e => e.label === 'Streaming plan');
  check('an expense bill on a pay-in-full card is a card charge', bsEv.length >= 1 && bsEv.every(e => e.cardCharge === 'Rewards Card' && /on Rewards Card/.test(e.detail)));
}

/* ── the pay-run day ── */
{
  check('default pay-run day is the 1st', fc.bulkPayDay() === 1);
  state.flags.bulkPay = { day: 5 };
  check('a set day is used', fc.bulkPayDay() === 5 && iso(fc.runDatesBetween(new Date(2026, 9, 24), new Date(2026, 11, 31))[0]) === '2026-11-05');
  for (const bad of [0, 29, -3, 'x', null]){ state.flags.bulkPay = { day: bad }; if (fc.bulkPayDay() !== 1) check('a bad day falls back to the 1st: ' + bad, false); }
  state.flags.bulkPay = undefined;
  check('a run date is strictly after today', iso(fc.runDatesBetween(new Date(2026, 10, 1), new Date(2027, 0, 5))[0]) === '2026-12-01');
}

/* ── an unpaid monthly bill past its day is due now ── */
{
  await dbPut('bills', { id:'lease', name:'Lease', recurrence:'monthly', type:'Expense', account:'Main Checking', category:'Rent', amount: 800, dueDay: 15, active:true, paidMonths:{} });
  await dbPut('bills', { id:'later', name:'Storage', recurrence:'monthly', type:'Expense', account:'Main Checking', category:'Rent', amount: 60, dueDay: 28, active:true, paidMonths:{} });
  await loadState(); state.flags.anchorsV3 = true; state.flags.realAvailCards = ['Rewards Card']; await tick(300);
  let ev = fc.buildEvents(20).filter(e => e.label === 'Lease');
  check('unpaid Lease (due the 15th) lands today, marked overdue', ev.length === 1 && iso(ev[0].date) === '2026-10-24' && /overdue/.test(ev[0].detail), JSON.stringify(ev.map(e => [iso(e.date), e.detail])));
  check('…and again on its next due date (Nov 15 beyond a 20-day window → not here)', fc.buildEvents(30).filter(e => e.label === 'Lease').length === 2);
  check('a bill not yet due this month is just on its day', fc.buildEvents(20).filter(e => e.label === 'Storage').map(e => iso(e.date)).join() === '2026-10-28');
  const lease = state.bills.find(b => b.id === 'lease'); lease.paidMonths['2026-10'] = 'x1'; await dbPut('bills', lease);
  check('mark it paid → gone', fc.buildEvents(20).filter(e => e.label === 'Lease').length === 0);
  // safe to spend counts overdue bills, consistent with Real available.
  lease.paidMonths = {}; await dbPut('bills', lease);
  const s = pd.safeToSpend();
  check('safe to spend subtracts the overdue bill (as Real available does)', s.due.some(e => e.label === 'Lease'));
}

/* ── the forecast sheet renders the new events ── */
{
  fc.openForecastSheet(); await tick(80);
  const t = dom.window.document.querySelector('#sheetBody').textContent;
  check('the sheet lists the card payment (this card has an Auto bill with a cycle → statement mode)', /Rewards Card · statement balance/.test(t) && /Statement closed/.test(t));
  check('…and paychecks', /Salary/.test(t));
  check('…and says when cards are paid', /pay-run day/.test(t));
}

check('no unhandled errors', errors.length === 0, errors.join('\n'));
done('forecast + payday v3.2 tests');
