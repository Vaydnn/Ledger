/* v3.2: card statements — enter the statement balance your bank shows, keep
   what you charge after the closing day apart, pay the statement on pay-run
   day, track the card as an Auto (CC) bill.
   Synthetic data, "today" pinned to 2026-10-24; the card closes on the 22nd. */
import { bootEnv, makeChecker, tick, domHelpers, freezeDate } from './_env.mjs';
freezeDate(2026, 10, 24);
const dom = await bootEnv();
const { check, done } = makeChecker();
const { $, $$, click, type } = domHelpers(dom);
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));

const { state, dbPut, loadState, exportData } = await import('../js/db.js');
const util = await import('../js/util.js');
const app = await import('../js/app.js'); await tick(150);
const S = await import('../js/statement.js');
const C = await import('../js/cards.js');
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
await dbPut('accounts', { id:'a3', name:'Rewards Card', type:'Credit Card', active:true, order:2 });
await dbPut('accounts', { id:'a4', name:'Dining Card', type:'Credit Card', active:true, order:3 });
for (const [k, list] of Object.entries({ Expense:['Dining','Groceries','Streaming'], Income:['Salary'], Refund:['Return'], Investment:['Brokerage'], CCPayment:['CC Payment'], LoanPayment:['Loan Payment'], Transfer:['Transfer'], BalanceTransfer:['Balance Transfer'] })){
  await dbPut('categories', { id:k, list });
}
for (const [i, [acct, amt]] of [['Main Checking', 6000], ['Second Checking', 2000], ['Rewards Card', 3000], ['Dining Card', 0]].entries()){
  await dbPut('balanceAnchors', { id:'an' + i, account: acct, month:'2026-10', amount: amt });
}
let seq = 0;
const add = (o) => dbPut('transactions', { id:'s' + (++seq), description:'', ...o });
await add({ date:'2026-10-05', type:'Expense', account:'Rewards Card', category:'Groceries', amount: 500 });
await add({ date:'2026-10-10', type:'CC Payment', account:'Rewards Card', fromAccount:'Second Checking', category:'CC Payment', amount: 1000 });
await add({ date:'2026-10-15', type:'Expense', account:'Rewards Card', category:'Groceries', amount: 400 });
await add({ date:'2026-10-20', type:'Expense', account:'Rewards Card', category:'Streaming', amount: 100 });
// after the close (the 22nd): these ride on the NEXT statement
await add({ date:'2026-10-23', type:'Expense', account:'Rewards Card', category:'Dining', amount: 150 });
await add({ date:'2026-10-24', type:'Expense', account:'Rewards Card', category:'Groceries', amount: 60 });
await add({ date:'2026-10-12', type:'Expense', account:'Dining Card', category:'Dining', amount: 80 });
await loadState();
state.flags.anchorsV3 = true;
state.selected = { year: 2026, month: 10 };
await tick(700);
const card = () => state.accounts.find(a => a.name === 'Rewards Card');

/* ── before a cycle is set ── */
check('no cycle → no statement, pay mode "full"', S.cardCycle('Rewards Card') === null && S.statementInfo('Rewards Card') === null && S.cardPayMode('Rewards Card') === 'full');
check('balance sanity: 3000 − 1000 + 500 + 400 + 100 + 150 + 60', near(balanceLatest('Rewards Card'), 3210), String(balanceLatest('Rewards Card')));
app.navigate('home'); await tick(120);
{
  const c = $('.home-card[data-card="cards"]');
  check('Home has a Card statements card listing both cards', !!c && /Rewards Card/.test(c.textContent) && /Dining Card/.test(c.textContent));
  check('…cards without a cycle invite you to set one', /Set when its statement closes/.test(c.textContent));
}

/* ── setting the cycle ── */
await click($$('.cs-row').find(r => /Rewards Card/.test(r.textContent)), 100);
check('the card sheet opens (no cycle yet: just the cycle form)', /^Rewards Card/.test(text()) && !!$('#cs-close') && !$('#cs-amt'));
await click($('#cs-cycle'), 80);
check('a closing day is required', !card().closeDay && /closes/i.test($('#toast').textContent));
type('#cs-close', '22'); type('#cs-grace', '25'); await click($('#cs-cycle'), 150);
check('cycle saved on the card', card().closeDay === 22 && card().graceDays === 25);
{
  const s = S.statementInfo('Rewards Card');
  check('statement = the balance when it closed on Oct 22 (3000)', s && s.closeIso === '2026-10-22' && near(s.statement, 3000), JSON.stringify(s));
  check('…charged since it closed = 210 (next statement), not part of it', near(s.charged, 210) && near(s.current, 3210));
  check('…due Nov 16 (25 days after)', s.dueIso === '2026-11-16' && !s.entered);
  check('pay mode now defaults to the statement', S.cardPayMode('Rewards Card') === 'statement');
}
check('the sheet now shows the breakdown', /Statement · closed Oct 22/.test(text()) && /Still due by Nov 16/.test(text()) && /Charged since it closed/.test(text()));
check('…and where this cycle\'s spending went', /Spending since Oct 22 · \$210\.00/.test(text()) && /Dining/.test(text()) && /Groceries/.test(text()));

/* ── entering the statement balance your bank shows ── */
type('#cs-amt', '3100'); await click($('#cs-save'), 150);
{
  const s = S.statementInfo('Rewards Card');
  check('the entered balance wins: 3100, flagged as entered', s.entered && near(s.statement, 3100) && near(s.remaining, 3100) && s.closeIso === '2026-10-22', JSON.stringify(s));
  check('…Ledger\'s own number is kept for comparison (3000)', near(s.computed, 3000));
  check('…what you charged after the close is unchanged (210)', near(s.charged, 210));
  check('…it is stored with the statement it belongs to', card().stmt.closeIso === '2026-10-22' && near(card().stmt.amount, 3100));
  check('the sheet says so', /You entered this\. Ledger calculates \$3,000\.00/.test(text()) && !!$('#cs-clear'));
}
check('it survives a backup (account record carries it)', JSON.stringify(exportData().accounts.find(a => a.name === 'Rewards Card').stmt) === JSON.stringify({ closeIso:'2026-10-22', amount:3100 }));

// A payment after the close lowers what is still due, never the statement.
await add({ id:'pay1', date:'2026-10-24', type:'CC Payment', account:'Rewards Card', fromAccount:'Second Checking', category:'CC Payment', amount: 500 });
await loadState(); state.flags.anchorsV3 = true; state.selected = { year: 2026, month: 10 }; await tick(300);
{
  const s = S.statementInfo('Rewards Card');
  check('a payment since the close: statement stays 3100, still due 2600', near(s.statement, 3100) && near(s.paidSince, 500) && near(s.remaining, 2600), JSON.stringify(s));
  check('(the payment is not counted as "charged")', near(s.charged, 210));
}
// The next close goes back to computing.
{
  const next = S.statementInfo('Rewards Card', '2026-11-23');
  check('once the next statement closes the entered number no longer applies', next.closeIso === '2026-11-22' && !next.entered, JSON.stringify(next));
  const same = S.statementInfo('Rewards Card', '2026-11-21');
  check('(until then it does)', same.closeIso === '2026-10-22' && same.entered);
}
// Clear.
C.openCardSheet('Rewards Card'); await tick(80);
await click($('#cs-clear'), 150);
check('"Use Ledger\'s number" clears the override', !card().stmt && !S.statementInfo('Rewards Card').entered && near(S.statementInfo('Rewards Card').statement, 3000));
C.openCardSheet('Rewards Card'); await tick(60);
type('#cs-amt', '3100'); await click($('#cs-save'), 150);
type('#cs-amt', '-5'); await click($('#cs-save'), 100);
check('a negative amount is rejected (3100 kept)', near(S.statementInfo('Rewards Card').statement, 3100));
closeSheet(); await tick(40);

/* ── cycle spending ── */
{
  const sp = S.cycleSpending('Rewards Card');
  check('spending since the close, biggest category first', sp.closeIso === '2026-10-22' && near(sp.total, 210) && sp.top[0].category === 'Dining' && near(sp.top[0].amount, 150) && sp.count === 2, JSON.stringify(sp));
  check('no cycle → null', S.cycleSpending('Dining Card') === null);
}

/* ── Home card and the account row ── */
app.navigate('more'); app.navigate('home'); await tick(150);
{
  const c = $('.home-card[data-card="cards"]');
  const r = $$('.cs-row').find(x => /Rewards Card/.test(x.textContent));
  check('Home: closed Oct 22 · entered · due Nov 16', /Closed Oct 22 · entered · due Nov 16/.test(r.textContent), r.textContent.replace(/\s+/g, ' '));
  check('…the still-due amount and what is on the next statement', /\$2,600\.00/.test(r.textContent) && /\$210\.00 charged since/.test(r.textContent));
  const meta = $('.acct-row[data-acct="Rewards Card"] .stmt-due');
  check('the account row shows the statement line', !!meta && /statement \$2,600\.00 due Nov 16/.test(meta.textContent), meta?.textContent);
  await click(meta, 100);
  check('tapping it opens the card sheet (not Activity)', /^Rewards Card/.test(text()) && !!$('#cs-amt'));
  closeSheet(); await tick(60);
}

/* ── tracking it as an Auto (CC) bill ── */
{
  C.openCardSheet('Rewards Card'); await tick(60);
  check('offers to track the card as a bill', !!$('#cs-bill'));
  await click($('#cs-bill'), 200);
  const b = state.bills.find(x => x.recurrence === 'auto-cc' && x.linkedAccount === 'Rewards Card');
  check('an Auto (CC) bill was created, on the statement, from the account you usually pay it from', b && b.ccAmount === 'statement' && b.closeDay === 22 && b.graceDays === 25 && b.fromAccount === 'Second Checking' && b.name === 'Rewards', JSON.stringify(b));
  check('…its amount is the statement STILL DUE (entered 3100 − 500 paid)', near(B.getBillAmount(b), 2600), String(B.getBillAmount(b)));
  check('…due day = close + grace (Nov 16 → day 17 of the cycle math)', B.getBillDueDay(b) === ((22 + 25 - 1) % 30) + 1);
  check('the sheet now says it is tracked, no duplicate button', /Tracked by the Auto \(CC\) bill “Rewards”/.test(text()) && !$('#cs-bill'));
  // Changing the cycle keeps the bill in step.
  type('#cs-close', '20'); await click($('#cs-cycle'), 150);
  check('editing the cycle updates the bill too', b.closeDay === 20 && card().closeDay === 20);
  type('#cs-close', '22'); await click($('#cs-cycle'), 150);
  closeSheet(); await tick(40);
}

/* ── pay mode, forecast, pay run, preview ── */
state.flags.realAvailCards = ['Rewards Card'];
{
  let ev = fc.buildEvents(60).filter(e => e.kind === 'card');
  const nov = ev.find(e => iso(e.date) === '2026-11-01');
  check('statement mode: Nov 1 pays the statement still due (2600), not the whole balance', nov && nov.mode === 'statement' && near(-nov.amount, 2600) && /Statement closed Oct 22 \(entered\)/.test(nov.detail), JSON.stringify(nov && [nov.amount, nov.mode, nov.detail]));
  check('…and says what stays behind for the next statement', /left for the next one/.test(nov.detail));
  const dec = ev.find(e => iso(e.date) === '2026-12-01');
  const carry = balanceLatest('Rewards Card') - 2600;
  check('Dec 1 pays the statement closing Nov 22: what was left (610) + charges to then', dec && /Statement closes Nov 22/.test(dec.detail) && near(dec.balance, carry) && -dec.amount >= carry - 0.005, JSON.stringify(dec && [dec.amount, dec.balance, dec.detail]));
  check('the label says statement balance', nov.label === 'Rewards Card · statement balance');

  // Pay run + preview
  const items = NM.payRunItems(2026, 10);
  const it = items.find(i => i.kind === 'card' && i.name === 'Rewards Card');
  check('pay run: the card item is the statement still due, with its source', it && near(it.amount, 2600) && /statement closed Oct 22 \(entered\)/.test(it.meta) && /Second Checking/.test(it.meta), JSON.stringify(it));
  check('…not the auto bill as a separate item (the card line covers it)', !items.some(i => i.name === 'Rewards'));
  const p = NM.nextMonthPlan();
  check('preview: the run line is the statement; the next run is listed under "building"', p.cards.some(c => c.label === 'Rewards Card · statement balance' && near(-c.amount, 2600)) && p.nextCards.length === 1 && near(p.buildingTotal, -p.nextCards[0].amount));
  NM.openNextMonthSheet(); await tick(80);
  check('…the sheet shows both', /Rewards Card · statement balance/.test(text()) && /Statement closes Nov 22/.test(text()));
  closeSheet(); await tick(40);

  // Switch the card to "everything owed".
  C.openCardSheet('Rewards Card'); await tick(60);
  await click($$('#cs-mode .seg-btn').find(b => b.dataset.v === 'full'), 150);
  check('pay mode saved per card', state.flags.cardPay['Rewards Card'] === 'full' && S.cardPayMode('Rewards Card') === 'full');
  closeSheet(); await tick(40);
  ev = fc.buildEvents(60).filter(e => e.kind === 'card');
  const novFull = ev.find(e => iso(e.date) === '2026-11-01');
  check('full mode: Nov 1 pays everything owed (3210 − 500 paid = 2710 + charges ahead)', novFull.mode === 'full' && -novFull.amount >= balanceLatest('Rewards Card') - 0.005 && /pay in full/.test(novFull.label));
  check('…the pay run item is the balance', near(NM.payRunItems(2026, 10).find(i => i.kind === 'card').amount, balanceLatest('Rewards Card')));
  state.flags.cardPay = { 'Rewards Card': 'statement' };
}

/* ── pay it ── */
{
  app.navigate('home'); await tick(100);
  state.flags.bulkPay = { day: 24 };
  app.navigate('more'); app.navigate('home'); await tick(150);
  await click($('#pr-open'), 120);
  const rows = $$('.pr-row');
  check('pay run lists the card at the statement still due', rows.length >= 1 && /Rewards Card/.test(rows[0].textContent) && rows[0].querySelector('.pr-amt').value === '2600.00', rows.map(r => r.textContent.replace(/\s+/g, ' ')).join('|'));
  await click($('#pr-go'), 250);
  const cp = state.transactions.find(t => t.description === 'Pay run' && t.account === 'Rewards Card');
  check('logs a CC Payment of 2600 from the usual account', cp && near(cp.amount, 2600) && cp.fromAccount === 'Second Checking');
  const s = S.statementInfo('Rewards Card');
  check('the statement is now paid (still due 0); the 210 after the close stays on the card', near(s.remaining, 0) && near(s.paidSince, 3100) && near(balanceLatest('Rewards Card'), 3210 - 3100 + 0) , JSON.stringify(s));
  const r = $$('.cs-row').find(x => /Rewards Card/.test(x.textContent));
  check('Home: "paid ✓"', /paid ✓/.test(r.textContent), r.textContent.replace(/\s+/g, ' '));
}

check('no unhandled errors', errors.length === 0, errors.join('\n'));
done('card statements tests');
