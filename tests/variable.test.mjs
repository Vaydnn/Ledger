/* v3.2: variable-amount bills (a phone bill) + linking a payment by hand.
   Synthetic data: generic names, round amounts, "today" pinned to 2026-10-24. */
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
const B = await import('../js/bills.js');
const { closeSheet } = await import('../js/sheet.js');
const near = (a, b) => Math.abs(a - b) < 0.005;

await dbPut('accounts', { id:'a1', name:'Main Checking', type:'Checking', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'Second Checking', type:'Checking', active:true, order:1 });
await dbPut('accounts', { id:'a3', name:'Rewards Card', type:'Credit Card', active:true, order:2 });
await dbPut('accounts', { id:'a4', name:'Store Card', type:'Credit Card', active:true, order:3 });
await dbPut('accounts', { id:'a5', name:'Auto Loan', type:'Loan', active:true, order:4 });
for (const [k, list] of Object.entries({ Expense:['Phone','Water','Streaming','Utilities'], Income:['Salary'], Refund:['Return'], Investment:['Brokerage'], CCPayment:['CC Payment'], LoanPayment:['Loan Payment'], Transfer:['Transfer'], BalanceTransfer:['Balance Transfer'] })){
  await dbPut('categories', { id:k, list });
}
for (const [i, [acct, amt]] of [['Main Checking', 5000], ['Second Checking', 1000], ['Rewards Card', 0], ['Store Card', 300], ['Auto Loan', 4000]].entries()){
  await dbPut('balanceAnchors', { id:'an' + i, account: acct, month:'2026-10', amount: amt });
}
// Three months of a phone bill on the card: 300, 340, 380.
const tx = (id, date, o) => ({ id, date, description:'', ...o });
await dbPut('transactions', tx('t-jul', '2026-07-02', { type:'Expense', account:'Rewards Card', category:'Phone', amount: 300 }));
await dbPut('transactions', tx('t-aug', '2026-08-02', { type:'Expense', account:'Rewards Card', category:'Phone', amount: 340 }));
await dbPut('transactions', tx('t-sep', '2026-09-02', { type:'Expense', account:'Rewards Card', category:'Phone', amount: 380 }));
await dbPut('bills', { id:'v1', name:'Mobile', recurrence:'monthly', variable:true, estMode:'avg3', type:'Expense', account:'Rewards Card', category:'Phone',
  amount: 300, dueDay: 1, active:true, paidMonths:{ '2026-07':'t-jul', '2026-08':'t-aug', '2026-09':'t-sep' } });
// A variable bill with no history, and a plain fixed one.
await dbPut('bills', { id:'v2', name:'Streaming', recurrence:'monthly', variable:true, estMode:'avg3', type:'Expense', account:'Rewards Card', category:'Streaming', amount: 20, dueDay: 28, active:true, paidMonths:{} });
await dbPut('bills', { id:'f1', name:'Gym', recurrence:'monthly', type:'Expense', account:'Rewards Card', category:'Fitness', amount: 25, dueDay: 28, active:true, paidMonths:{} });
// Store Card payment: $83 from Main Checking — but the real one will be $233.39 from Second Checking.
await dbPut('bills', { id:'s1', name:'Store payment', recurrence:'monthly', type:'CC Payment', account:'Store Card', fromAccount:'Main Checking', amount: 83, dueDay: 15, active:true, paidMonths:{} });
await dbPut('bills', { id:'l1', name:'Car loan', recurrence:'monthly', type:'Loan Payment', account:'Auto Loan', fromAccount:'Main Checking', amount: 250, dueDay: 12, active:true, paidMonths:{} });
await dbPut('transactions', tx('t-store', '2026-10-02', { type:'CC Payment', account:'Store Card', fromAccount:'Second Checking', category:'CC Payment', amount: 233.39 }));
await loadState();
state.flags.anchorsV3 = true;
state.selected = { year: 2026, month: 10 };
await tick(700);
const bill = (id) => state.bills.find(b => b.id === id);

/* ── the amount model ── */
{
  const v1 = bill('v1');
  check('isVariableBill: monthly + flag', B.isVariableBill(v1) && !B.isVariableBill(bill('f1')));
  check('history reads the linked payments', JSON.stringify(B.billHistory(v1)) === JSON.stringify([['2026-07',300],['2026-08',340],['2026-09',380]]), JSON.stringify(B.billHistory(v1)));
  check('3-month average estimate', near(B.billEstimate(v1, '2026-10'), 340), String(B.billEstimate(v1, '2026-10')));
  check('last-month estimate', near(B.billEstimate({ ...v1, estMode:'last' }, '2026-10'), 380));
  check('fixed estimate = the typed number', near(B.billEstimate({ ...v1, estMode:'fixed' }, '2026-10'), 300));
  check('estimate only looks at months BEFORE the one asked about', near(B.billEstimate(v1, '2026-09'), 320));
  check('this month is an estimate until an amount is in', B.isBillEstimated(v1, '2026-10') && near(B.getBillAmount(v1, 2026, 10), 340));
  check('no history → the typed amount', near(B.billEstimate(bill('v2'), '2026-10'), 20));
  check('a fixed bill is never "estimated"', !B.isBillEstimated(bill('f1'), '2026-10') && near(B.getBillAmount(bill('f1'), 2026, 10), 25));
  check('a past month shows what it actually was', near(B.getBillAmount(v1, 2026, 8), 340) && !B.isBillEstimated(v1, '2026-08'));
}

/* ── Real available + the Bills row use the estimate ── */
app.navigate('bills'); await tick(80);
const upcoming = () => B.computeRealAvailable(2026, 10).upcomingTotal;
const base = upcoming();
check('Real available counts the estimate (340 + 20 + 25 + 83 + 250)', near(base, 718), String(base));
{
  const row = $('.bill-row[data-bill-id="v1"]');
  check('the row shows ~$340 with "est."', !!row && /~\$340/.test(row.textContent) && /est\./.test(row.textContent), row?.textContent.replace(/\s+/g, ' '));
  check('…a "Varies" tag and an Enter amount link', /Varies/.test(row.textContent) && !!row.querySelector('.bill-enter'));
  check('a fixed bill has neither', !$('.bill-row[data-bill-id="f1"] .bill-enter') && !/~/.test($('.bill-row[data-bill-id="f1"] .bill-amt').textContent));
}

/* ── entering the month's amount ── */
await click($('.bill-row[data-bill-id="v1"] .bill-enter'), 80);
check('(Enter amount is not a Link button: nothing was marked paid)', !/marked paid/.test($('#toast').textContent) && Object.keys(bill('v1').paidMonths).sort().join() === '2026-07,2026-08,2026-09', Object.keys(bill('v1').paidMonths).join());
check('Enter amount opens the amount sheet, prefilled with the estimate', $('#ba-amt')?.value === '340.00', $('#ba-amt')?.value);
check('…with recent months listed', /Sep \$380\.00/.test($('#sheetBody').textContent));
type('#ba-amt', '0'); await click($('#ba-save'), 80);
check('zero is rejected', bill('v1').amounts?.['2026-10'] == null);
type('#ba-amt', '412.50'); await click($('#ba-save'), 120);
check('saving records the actual', near(bill('v1').amounts['2026-10'], 412.5));
check('…Real available moves by exactly the difference', near(upcoming() - base, 72.5), String(upcoming() - base));
check('…the stored estimate rolls to the new 3-month average (340, 380, 412.5)', near(bill('v1').amount, (340 + 380 + 412.5) / 3), String(bill('v1').amount));
{
  const row = $('.bill-row[data-bill-id="v1"]');
  check('the row now shows the entered amount, no "est."', /\$412\.50|\$413/.test(row.textContent) && !/est\./.test(row.textContent) && !row.querySelector('.bill-enter'), row.textContent.replace(/\s+/g, ' '));
}

/* ── paying ── */
const txnCount = state.transactions.length;
await click($('.bill-row[data-bill-id="v1"] .bill-check'), 150);
{
  const t = state.transactions.find(x => x.id === bill('v1').paidMonths['2026-10']);
  check('with the amount known, the check pays it straight away', !!t && near(t.amount, 412.5) && t.account === 'Rewards Card' && t.type === 'Expense' && state.transactions.length === txnCount + 1);
  check('…paid bills leave Real available', near(base - upcoming(), 340), String(base - upcoming()));
}
await click($('.bill-row[data-bill-id="v1"] .bill-check'), 150);
check('unpaying removes the payment but keeps the amount you entered', !bill('v1').paidMonths['2026-10'] && near(bill('v1').amounts['2026-10'], 412.5));

// An estimated bill asks first.
await click($('.bill-row[data-bill-id="v2"] .bill-check'), 100);
check('paying an estimated bill asks for the amount first', !!$('#ba-pay') && $('#ba-amt')?.value === '20.00');
check('…(nothing was logged yet)', !bill('v2').paidMonths['2026-10']);
type('#ba-amt', '17.25'); await click($('#ba-pay'), 200);
{
  const t = state.transactions.find(x => x.id === bill('v2').paidMonths['2026-10']);
  check('Pay it logs the amount you typed', !!t && near(t.amount, 17.25) && near(bill('v2').amounts['2026-10'], 17.25));
}
check('a 1st payment on a variable bill makes the estimate follow it', near(bill('v2').amount, 17.25));

/* ── a payment you log yourself is picked up ── */
{
  const v1 = bill('v1');
  const logged = { id:'t-hand', date:'2026-10-02', type:'Expense', account:'Rewards Card', category:'Phone', description:'carrier', amount: 361 };
  // pay-state reset so the matcher sees an unpaid bill
  delete v1.paidMonths['2026-10']; delete v1.amounts['2026-10'];
  check('a variable bill matches any plausible amount (361 vs ~340)', B.billMatchesTxn(v1, logged));
  check('…but not a wildly different one', !B.billMatchesTxn(v1, { ...logged, amount: 40 }) && !B.billMatchesTxn(v1, { ...logged, amount: 2000 }));
  check('a fixed bill still wants the amount within 10%', !B.billMatchesTxn(bill('f1'), { id:'x', date:'2026-10-03', type:'Expense', account:'Rewards Card', category:'Fitness', amount: 40 })
    && B.billMatchesTxn(bill('f1'), { id:'x', date:'2026-10-03', type:'Expense', account:'Rewards Card', category:'Fitness', amount: 26 }));
  await dbPut('transactions', logged); state.transactions.unshift(logged);
  state.transactions.sort((a, b) => b.date.localeCompare(a.date));
  await B.markBillPaidWith(v1, '2026-10', 't-hand'); await tick(60);
  check('Link records the payment as the month\'s amount', near(B.billMonthAmount(v1, '2026-10'), 361) && B.isBillPaid(v1, '2026-10') && !B.isBillEstimated(v1, '2026-10'));
}

/* ── From account no longer blocks a match ── */
{
  const l1 = bill('l1');
  const pay = { id:'lp1', date:'2026-10-12', type:'Loan Payment', account:'Auto Loan', fromAccount:'Second Checking', category:'Loan Payment', amount: 250 };
  check('a loan payment from the OTHER checking account still matches', B.billMatchesTxn(l1, pay));
}

/* ── linking a payment by hand (amount 233.39 vs the bill's 83) ── */
{
  const s1 = bill('s1');
  check('233.39 is too far from 83 to auto-match', !B.billMatchesTxn(s1, state.transactions.find(t => t.id === 't-store')));
  const raBefore = upcoming();
  B.openBillSheet('s1'); await tick(80);
  check('the bill editor offers "Link a payment" for an unpaid month', !!$('#bf-link') && /Oct/.test($('#bf-link').textContent));
  await click($('#bf-link'), 80);
  const rows = $$('.lp-row');
  check('the picker lists the unlinked CC payment to that card', rows.length === 1 && /233\.39/.test(rows[0].textContent) && /Second Checking/.test(rows[0].textContent), rows.map(r => r.textContent.replace(/\s+/g, ' ')).join('|'));
  await click(rows[0], 150);
  check('linking marks the bill paid with that transaction', s1.paidMonths['2026-10'] === 't-store');
  check('…and takes it out of Real available', near(raBefore - upcoming(), 83), String(raBefore - upcoming()));
  B.openBillSheet('s1'); await tick(60);
  check('a paid month has no Link button', !$('#bf-link'));
  closeSheet(); await tick(40);
  // a linked transaction isn't offered to another bill
  B.openLinkPaymentSheet('l1', '2026-10'); await tick(60);
  check('the picker lists only transactions of the bill\'s own type and account', $$('.lp-row').length === 0 && /No unlinked/.test($('#sheetBody').textContent));
  closeSheet(); await tick(40);
}

/* ── the editor ── */
await dbPut('transactions', tx('w1', '2026-08-05', { type:'Expense', account:'Rewards Card', category:'Water', amount: 40 }));
await dbPut('transactions', tx('w2', '2026-09-05', { type:'Expense', account:'Rewards Card', category:'Water', amount: 50 }));
await dbPut('transactions', tx('w3', '2026-09-20', { type:'Expense', account:'Rewards Card', category:'Water', amount: 60 }));
await loadState(); state.flags.anchorsV3 = true; state.selected = { year: 2026, month: 10 }; await tick(300);
{
  B.openBillSheet(null); await tick(80);
  check('new monthly bill: "Does the amount change?" is offered', !!$('#bf-var') && !$('#bf-est'));
  check('…the field reads Amount', /Amount/.test($('#bf-amt').closest('.field').textContent) && !/Estimate/.test($('#bf-amt').closest('.field').textContent));
  await click($$('#bf-var .seg-btn').find(b => b.dataset.v === 'varies'), 60);
  check('Varies shows the estimate choices and relabels the amount', !!$('#bf-est') && /Estimate/.test($('#bf-amt').closest('.field').textContent));
  type('#bf-name', 'Water'); type('#bf-amt', '45'); type('#bf-cat', 'Water');
  const acctBtn = $('#bf-acct'); check('(account defaults to a checking account)', /Main Checking/.test(acctBtn.textContent));
  await click(acctBtn, 40); await click($$('.picker-option').find(o => o.dataset.v === 'Rewards Card'), 60);
  await click($('#bf-import'), 80);
  check('Import picks one charge per month (newest) from matching transactions', /Aug \$40\.00/.test($('#sheetBody').textContent) && /Sep \$60\.00/.test($('#sheetBody').textContent), $('#sheetBody').textContent.replace(/\s+/g, ' ').slice(0, 400));
  await click($$('#bf-est .seg-btn').find(b => b.dataset.v === 'last'), 60);
  await click($('#bf-save'), 200);
  const w = state.bills.find(b => b.name === 'Water');
  check('saved as variable, with its mode', w && w.variable === true && w.estMode === 'last', JSON.stringify(w));
  check('imported charges are linked as each month payment, so none counts as unpaid again', w.paidMonths['2026-09'] === 'w3' && w.paidMonths['2026-08'] === 'w1' && !w.paidMonths['2026-10'], JSON.stringify(w.paidMonths));
  check('…and become the history', JSON.stringify(B.billHistory(w)) === JSON.stringify([['2026-08', 40], ['2026-09', 60]]), JSON.stringify(B.billHistory(w)));
  check('…October (this month) is still open, estimated from them', B.isBillEstimated(w, '2026-10') && !B.isBillPaid(w, '2026-10'));
  check('…the stored estimate follows the history (last month = 60)', near(w.amount, 60), String(w?.amount));
  check('…its next estimate is last month', near(B.billMonthAmount(w, '2026-10'), 60));
  // Switch back to fixed keeps the history but stops varying.
  B.openBillSheet(w.id); await tick(60);
  await click($$('#bf-var .seg-btn').find(b => b.dataset.v === 'fixed'), 60);
  await click($('#bf-save'), 200);
  const w2 = state.bills.find(b => b.id === w.id);
  check('switching to "Same each month" drops the flag, keeps the history', !w2.variable && w2.paidMonths['2026-09'] === 'w3' && near(B.getBillAmount(w2, 2026, 10), w2.amount));
  // A one-time bill can't vary.
  B.openBillSheet(null); await tick(60);
  await click($$('#bf-recur .seg-btn').find(b => b.dataset.rec === 'once'), 60);
  check('one-time bills have no "varies" option', !$('#bf-var'));
  closeSheet(); await tick(40);
}

/* ── reminders + forecast read it too ── */
{
  await import('../js/remind-core.js');
  const R = globalThis.LedgerRemind;
  const v2 = bill('v2'); delete v2.paidMonths['2026-10']; v2.amounts = {}; v2.amount = 20;
  const list = R.dueBills([v2, { ...bill('f1') }], '2026-10-27', { daysAhead: 3 });
  const item = list.find(d => d.name === 'Streaming');
  check('a variable bill\'s reminder is flagged as an estimate', item && item.est === true && /~\$20\.00/.test(R.summary([item]).body));
  check('…a known amount is not', R.dueBills([{ ...v2, amounts: { '2026-10': 22 } }], '2026-10-27', { daysAhead: 3 })[0].est === false);
  check('…and a fixed bill has no estimate flag', list.find(d => d.name === 'Gym').est === false);

  const { buildEvents } = await import('../js/forecast.js');
  const ev = buildEvents(10).find(e => e.label === 'Mobile');
  check('the forecast uses the bill\'s estimate for that month', ev && near(-ev.amount, B.billMonthAmount(bill('v1'), '2026-11')) && /estimate/.test(ev.detail), JSON.stringify(ev && [ev.amount, ev.detail]));
}

/* ── an old bill (no new fields) behaves exactly as before ── */
{
  const old = { id:'o1', name:'Old rent', recurrence:'monthly', type:'Expense', account:'Main Checking', amount: 900, dueDay: 1, active:true, paidMonths:{} };
  check('old-format bill: fixed amount, never estimated', near(B.getBillAmount(old, 2026, 10), 900) && !B.isBillEstimated(old, '2026-10') && B.billHistory(old).length === 0);
}

check('no unhandled errors', errors.length === 0, errors.join('\n'));
done('variable bills tests');
