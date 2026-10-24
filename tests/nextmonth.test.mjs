/* v3.2: the bulk-pay planner — Next month preview, the pay-run day setting,
   the pay-run checklist (with undo), and their entry points.
   Synthetic data, "today" pinned to 2026-10-24, pay-run day = the 1st. */
import { bootEnv, makeChecker, tick, domHelpers, freezeDate } from './_env.mjs';
freezeDate(2026, 10, 24);
const dom = await bootEnv();
const { check, done } = makeChecker();
const { $, $$, click, type, pick } = domHelpers(dom);
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));

const { state, dbPut, loadState } = await import('../js/db.js');
const util = await import('../js/util.js');
const app = await import('../js/app.js'); await tick(150);
const NM = await import('../js/nextmonth.js');
const B = await import('../js/bills.js');
const fc = await import('../js/forecast.js');
const { closeSheet } = await import('../js/sheet.js');
const { balanceLatest } = await import('../js/effects.js');
const near = (a, b) => Math.abs(a - b) < 0.005;
const iso = (d) => util.toLocalISO(d);
const text = () => $('#sheetBody').textContent.replace(/\s+/g, ' ').trim();

await dbPut('accounts', { id:'a1', name:'Main Checking', type:'Checking', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'Second Checking', type:'Checking', active:true, order:1 });
await dbPut('accounts', { id:'a3', name:'Rewards Card', type:'Credit Card', active:true, order:2 });
await dbPut('accounts', { id:'a4', name:'Store Card', type:'Credit Card', active:true, order:3 });
await dbPut('accounts', { id:'a5', name:'Auto Loan', type:'Loan', active:true, order:4 });
for (const [k, list] of Object.entries({ Expense:['Phone','Groceries','Rent','Fitness','Storage'], Income:['Salary'], Refund:['Return'], Investment:['Brokerage'], CCPayment:['CC Payment'], LoanPayment:['Loan Payment'], Transfer:['Transfer'], BalanceTransfer:['Balance Transfer'] })){
  await dbPut('categories', { id:k, list });
}
for (const [i, [acct, amt]] of [['Main Checking', 5000], ['Second Checking', 1000], ['Rewards Card', 1200], ['Store Card', 300], ['Auto Loan', 4000]].entries()){
  await dbPut('balanceAnchors', { id:'an' + i, account: acct, month:'2026-10', amount: amt });
}
let seq = 0;
const add = (o) => dbPut('transactions', { id:'n' + (++seq), description:'', ...o });
// Paychecks: 2000 on the 10th and 25th (this month's 25th already deposited, logged ahead).
for (const dt of ['2026-06-10','2026-06-25','2026-07-10','2026-07-24','2026-08-10','2026-08-25','2026-09-10','2026-09-25','2026-10-10','2026-10-25']){
  await add({ date: dt, type:'Income', account:'Main Checking', category:'Salary', amount: 2000 });
}
// The usual card payment comes from the SECOND checking account.
await add({ id:'usual', date:'2026-10-01', type:'CC Payment', account:'Rewards Card', fromAccount:'Second Checking', category:'CC Payment', amount: 900 });
await add({ date:'2026-10-03', type:'Expense', account:'Rewards Card', category:'Groceries', amount: 140 });
// Phone: variable, on the pay-in-full card. Three months of history.
for (const [id, dt, a] of [['p7','2026-07-02',300],['p8','2026-08-02',340],['p9','2026-09-02',380],['p10','2026-10-02',360]]) await add({ id, date: dt, type:'Expense', account:'Rewards Card', category:'Phone', amount: a });
await dbPut('bills', { id:'mob', name:'Mobile', recurrence:'monthly', variable:true, estMode:'avg3', type:'Expense', account:'Rewards Card', category:'Phone', amount: 300, dueDay: 1, active:true,
  paidMonths:{ '2026-07':'p7', '2026-08':'p8', '2026-09':'p9', '2026-10':'p10' } });
await dbPut('bills', { id:'store', name:'Store payment', recurrence:'monthly', type:'CC Payment', account:'Store Card', fromAccount:'Main Checking', amount: 80, dueDay: 15, active:true, paidMonths:{} });   // unpaid, past due
await dbPut('bills', { id:'loan', name:'Car loan', recurrence:'monthly', type:'Loan Payment', account:'Auto Loan', fromAccount:'Main Checking', amount: 250, dueDay: 12, active:true, paidMonths:{ '2026-10':'zz' } });
await dbPut('bills', { id:'gym', name:'Gym', recurrence:'monthly', type:'Expense', account:'Main Checking', category:'Fitness', amount: 25, dueDay: 20, active:true, paidMonths:{ '2026-10':'zz' } });
await dbPut('bills', { id:'stor', name:'Storage', recurrence:'monthly', type:'Expense', account:'Main Checking', category:'Storage', amount: 60, dueDay: 28, active:true, paidMonths:{} });
await loadState();
state.flags.anchorsV3 = true;
state.flags.realAvailCards = ['Rewards Card'];
state.selected = { year: 2026, month: 10 };
await tick(700);
const bill = (id) => state.bills.find(b => b.id === id);

/* ── the plan ── */
const cash = fc.currentCash();
const card = balanceLatest('Rewards Card');
const p = NM.nextMonthPlan();
check('cash today = checking incl. the paycheck logged ahead', near(p.cash, balanceLatest('Main Checking') + balanceLatest('Second Checking')) && p.cash === cash);
check('the next run is Nov 1, the one after Dec 1', iso(p.run) === '2026-11-01' && iso(p.run2) === '2026-12-01');
check('before the run: the overdue Store payment (80) and Storage (60)', p.before.map(g => g.label).sort().join() === 'Storage,Store payment' && near(p.beforeOut, 140), JSON.stringify(p.before.map(g => [g.label, g.amount])));
check('…no paycheck lands before Nov 1 (the 25th is already in)', near(p.beforeIn, 0));
check('going in = cash − what is due before', near(p.goingIn, cash - 140));
check('the pay run: the card in full…', p.cards.length === 1 && /Rewards Card/.test(p.cards[0].label) && near(-p.cards[0].amount, card), JSON.stringify(p.cards.map(c => [c.label, c.amount, card])));
check('…plus the bills due Nov 1–30 that are paid from cash (loan 250, store 80, gym 25, storage 60)', p.bills.map(b => b.label).sort().join() === 'Car loan,Gym,Storage,Store payment' && near(sumOf(p.bills), -415), p.bills.map(b => b.label + b.amount).join());
function sumOf(list){ return list.reduce((s, e) => s + e.amount, 0); }
check('the phone bill is NOT in the run — it\'s a charge to the card', !p.bills.some(b => b.label === 'Mobile'));
check('run total = card + bills', near(p.runTotal, card + 415));
check('after the run = going in − run total', near(p.afterRun, p.goingIn - p.runTotal));
check('rest of the cycle: both paychecks (Nov 10, Nov 25)', near(p.restIn, 4000) && p.rest.find(g => g.label === 'Salary')?.count === 2);
check('end of cycle = after the run + paychecks', near(p.endOfCycle, p.afterRun + 4000));
check('lowest point is the day of the run (paychecks come later)', near(p.low.amount, p.afterRun) && iso(p.low.date) === '2026-11-01');
const mob = p.building.find(g => g.label === 'Mobile');
check('what is building on the card for Dec 1: the phone bill at its estimate (avg of Aug–Oct = 360)', mob && mob.est === true && near(-mob.amount, 360) && near(B.billMonthAmount(bill('mob'), '2026-11'), 360), JSON.stringify(mob));
check('…total of known charges', near(p.buildingTotal, -sumOf(p.building)) && p.buildingTotal >= 360);

/* ── Home ── */
app.navigate('home'); await tick(120);
{
  const c = $('.home-card[data-card="nextmonth"]');
  check('Home shows the Next month card', !!c && /Next month/.test(c.textContent) && /Nov 1 pay run/.test(c.textContent));
  check('…with going-in, pay run and after-run rows', /Cash going into Nov 1/.test(c.textContent) && /Pay run/.test(c.textContent) && /After the pay run/.test(c.textContent));
  check('…it can be collapsed like any card', !!c.querySelector('.card-fold'));
  check('the Pay run card is absent until pay-run day', !$('.home-card[data-card="payrun"]'));
  await click($('#nm-open'), 120);
  const t = text();
  check('the preview sheet opens', /^Next month/.test(t) && /Cash today/.test(t));
  check('…walks through the sections', /Before the pay run · through Oct 31/.test(t) && /Nov 1 pay run/.test(t) && /Rest of the cycle · Nov 1 – Nov 30/.test(t) && /Building on your cards · for the Dec 1 run/.test(t));
  check('…names the card and the bills', /Rewards Card · pay in full/.test(t) && /Car loan/.test(t) && /Store payment/.test(t) && /overdue/.test(t));
  check('…marks the variable bill as an estimate', /~Mobile/.test(t));
  check('…and is honest about what isn\'t in it', /Everyday spending/.test(t));
}

/* ── the pay-run day setting ── */
await click($('#nm-day'), 80);
check('the day picker lists the 1st–28th', $$('.picker-option').length === 28 && $$('.picker-option')[0].textContent.includes('1st'));
await pick('The 5th'); await tick(150);
check('saved as the pay-run day', state.flags.bulkPay?.day === 5 && fc.bulkPayDay() === 5);
check('the sheet redraws for the 5th', /Nov 5 pay run/.test(text()) && /Pay-run day: the 5th/.test(text()));
{
  const p5 = NM.nextMonthPlan();
  check('bills due Nov 1–4 now come before the run', iso(p5.run) === '2026-11-05' && p5.before.some(g => g.label === 'Mobile') === false && p5.run2 && iso(p5.run2) === '2026-12-05');
}
state.flags.bulkPay = { day: 1 };
closeSheet(); await tick(60);

/* ── Bills tab entry points ── */
app.navigate('bills'); await tick(100);
await click($('#go-nextmonth'), 120);
check('Bills → "Next month" opens the preview', /^Next month/.test(text()));
closeSheet(); await tick(60);
await click($('#go-payrun'), 120);
check('Bills → "Pay run" opens the checklist', /^Pay run/.test(text()));
closeSheet(); await tick(60);

/* ── pay-run items ── */
{
  const items = NM.payRunItems(2026, 10);
  check('items: the card in full + the unpaid cash bills (Store payment, Storage)', items.map(i => i.name).join() === 'Rewards Card,Store payment,Storage', items.map(i => i.name).join());
  check('…the card amount is its balance, paid from the account you usually pay it from', items[0].kind === 'card' && near(items[0].amount, card) && items[0].from === 'Second Checking');
  check('…not the phone bill (a charge to the card) and not already-paid bills', !items.some(i => i.name === 'Mobile' || i.name === 'Car loan' || i.name === 'Gym'));
  check('…a variable bill would be flagged estimated', NM.payRunItems(2026, 10).every(i => i.kind !== 'bill' || i.est === false));
}

/* ── the Home card on pay-run day ── */
state.flags.bulkPay = { day: 22 };
app.navigate('home'); await tick(120);
check('two days after the pay-run day, a Pay run card shows what is left', /Pay run/.test($('.home-card[data-card="payrun"]')?.textContent || '') && /3 to pay/.test($('.home-card[data-card="payrun"]').textContent));
state.flags.bulkPay = { day: 24 };
app.navigate('more'); app.navigate('home'); await tick(120);
check('…and says "today" on the day itself', /Pay run today/.test($('.home-card[data-card="payrun"]')?.textContent || ''));
state.flags.bulkPay = { day: 20 };
app.navigate('more'); app.navigate('home'); await tick(120);
check('more than 3 days after → gone again', !$('.home-card[data-card="payrun"]'));
state.flags.bulkPay = { day: 24 };
app.navigate('more'); app.navigate('home'); await tick(120);

/* ── running it ── */
const txnsBefore = state.transactions.length;
await click($('#pr-open'), 120);
{
  const rows = $$('.pr-row');
  check('the checklist lists every item, all ticked', rows.length === 3 && $$('.pr-tick.checked').length === 3);
  check('…with the total', new RegExp(`3 items.*${util.fmt(card + 140).replace(/[$.]/g, '\\$&')}`).test(text()), text());
  // untick Storage, change Store payment to 90
  await click($$('.pr-tick')[2], 60);
  check('unticking drops it from the total', /2 items/.test(text()) && $$('.pr-row')[2].classList.contains('is-off'));
  const amt = $$('.pr-amt')[1]; amt.value = '90'; amt.dispatchEvent(new dom.window.Event('change')); await tick(60);
  check('editing an amount updates the total', new RegExp(util.fmt(card + 90).replace(/[$.]/g, '\\$&')).test(text()));
  check('the button says what it will do', /Pay 2 items/.test($('#pr-go').textContent));
  await click($('#pr-go'), 250);
}
{
  const created = state.transactions.length - txnsBefore;
  check('two payments logged', created === 2, String(created));
  const cp = state.transactions.find(t => t.type === 'CC Payment' && t.account === 'Rewards Card' && t.description === 'Pay run');
  check('the card is paid in full, from the usual account, dated today', cp && near(cp.amount, card) && cp.fromAccount === 'Second Checking' && cp.date === '2026-10-24', JSON.stringify(cp));
  const sp = state.transactions.find(t => t.type === 'CC Payment' && t.account === 'Store Card' && t.description === 'Store payment (auto)');
  check('the bill is paid at the amount you set, and marked paid', sp && near(sp.amount, 90) && bill('store').paidMonths['2026-10'] === sp.id);
  check('the unticked one is untouched', !bill('stor').paidMonths['2026-10']);
  check('the card now owes nothing', near(balanceLatest('Rewards Card'), 0), String(balanceLatest('Rewards Card')));
  check('a single toast offers Undo', /Paid 2 items/.test($('#toast').textContent) && $('#toast-act')?.textContent === 'Undo');
  check('the Pay run card is gone from Home now it is only the unticked item left? (1 left)', /1 to pay/.test($('.home-card[data-card="payrun"]')?.textContent || ''));
  await click($('#toast-act'), 250);
  check('Undo removes both payments', state.transactions.length === txnsBefore && !bill('store').paidMonths['2026-10']);
  check('…the card owes what it did', near(balanceLatest('Rewards Card'), card));
}

/* ── a variable bill in the run: pays the amount, remembers it, undoes cleanly ── */
await dbPut('bills', { id:'ph2', name:'Cell', recurrence:'monthly', variable:true, estMode:'avg3', type:'Expense', account:'Main Checking', category:'Phone', amount: 100, dueDay: 25, active:true, paidMonths:{}, amounts:{ '2026-08':90, '2026-09':110 } });
await loadState(); state.flags.anchorsV3 = true; state.flags.realAvailCards = ['Rewards Card']; state.flags.bulkPay = { day: 24 }; state.selected = { year: 2026, month: 10 }; await tick(300);
{
  const it = NM.payRunItems(2026, 10).find(i => i.name === 'Cell');
  check('an estimated bill is in the run, flagged', it && it.est === true && near(it.amount, 100), JSON.stringify(it && [it.est, it.amount]));
  app.navigate('home'); await tick(100);
  await click($('#pr-open'), 100);
  check('…shown with ~ and "estimate"', /~Cell/.test(text()) && /estimate/.test(text()));
  const row = $$('.pr-row').find(r => /Cell/.test(r.textContent));
  const amt = row.querySelector('.pr-amt'); amt.value = '123.45'; amt.dispatchEvent(new dom.window.Event('change')); await tick(60);
  // pay only Cell
  for (const t of $$('.pr-tick')) if (!/Cell/.test(t.closest('.pr-row').textContent)) await click(t, 30);
  await click($('#pr-go'), 250);
  const c = bill('ph2');
  check('Cell paid at 123.45; the month\'s amount and the estimate follow', near(c.amounts['2026-10'], 123.45) && c.paidMonths['2026-10'] && near(c.amount, (90 + 110 + 123.45) / 3), JSON.stringify([c.amounts, c.amount]));
  await click($('#toast-act'), 250);
  check('Undo restores the bill exactly (no leftover amount, estimate back)', !bill('ph2').paidMonths['2026-10'] && bill('ph2').amounts['2026-10'] === undefined && near(bill('ph2').amount, 100), JSON.stringify([bill('ph2').amounts, bill('ph2').amount]));
}

/* ── nothing to pay ── */
{
  state.flags.realAvailCards = [];
  for (const b of state.bills) b.paidMonths = { ...(b.paidMonths || {}), '2026-10': 'zz' };
  NM.openPayRunSheet(); await tick(80);
  check('an empty run says so and offers Close', /Nothing to pay/.test(text()) && !$('#pr-go') && $('#pr-close')?.textContent === 'Close');
  closeSheet(); await tick(40);
}

/* ── no pay-in-full cards: the preview still works and says how to set it up ── */
{
  state.flags.realAvailCards = [];
  const q = NM.nextMonthPlan();
  check('without pay-in-full cards: no card lines', q.cards.length === 0 && !q.hasCards);
  NM.openNextMonthSheet(); await tick(80);
  check('…and a tip points at Real available\'s ⚙', /check the cards you pay in full/i.test(text()));
  closeSheet(); await tick(40);
}

check('no unhandled errors', errors.length === 0, errors.join('\n'));
done('next-month / pay-run tests');
