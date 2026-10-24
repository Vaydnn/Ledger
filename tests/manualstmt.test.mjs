/* v3.2.2: the statement balance is ENTERED by default (not auto-detected).
   Pending charges the bank posts after the closing day — logged the day
   before — made the calculated figure drift, so until you type the bank's
   number Ledger shows an estimate and asks; what's on the NEXT statement is
   derived from your number. A card can go back to "Ledger calculates".
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
const ins = await import('../js/insights.js');
const { closeSheet } = await import('../js/sheet.js');
const { balanceLatest } = await import('../js/effects.js');
const near = (a, b) => Math.abs(a - b) < 0.005;
const iso = (d) => util.toLocalISO(d);
const text = () => $('#sheetBody').textContent.replace(/\s+/g, ' ').trim();
const strip = (s) => String(s).replace(/<[^>]+>/g, '');

await dbPut('accounts', { id:'a1', name:'Main Checking', type:'Checking', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'Second Checking', type:'Checking', active:true, order:1 });
await dbPut('accounts', { id:'a3', name:'Rewards Card', type:'Credit Card', active:true, order:2, closeDay: 22, graceDays: 25 });   // no stmtMode → "I enter it"
for (const [k, list] of Object.entries({ Expense:['Dining','Groceries','Streaming'], Income:['Salary'], Refund:['Return'], Investment:['Brokerage'], CCPayment:['CC Payment'], LoanPayment:['Loan Payment'], Transfer:['Transfer'], BalanceTransfer:['Balance Transfer'] })){
  await dbPut('categories', { id:k, list });
}
for (const [i, [acct, amt]] of [['Main Checking', 6000], ['Second Checking', 2000], ['Rewards Card', 3000]].entries()){
  await dbPut('balanceAnchors', { id:'an' + i, account: acct, month:'2026-10', amount: amt });
}
let seq = 0;
const add = (o) => dbPut('transactions', { id:'m' + (++seq), description:'', ...o });
await add({ date:'2026-10-05', type:'Expense', account:'Rewards Card', category:'Groceries', amount: 500 });
await add({ date:'2026-10-10', type:'CC Payment', account:'Rewards Card', fromAccount:'Second Checking', category:'CC Payment', amount: 1000 });
await add({ date:'2026-10-15', type:'Expense', account:'Rewards Card', category:'Groceries', amount: 400 });
// Logged on the 21st, but the bank posted it AFTER the close → it is on the NEXT statement.
await add({ date:'2026-10-21', type:'Expense', account:'Rewards Card', category:'Dining', amount: 200 });
await add({ date:'2026-10-23', type:'Expense', account:'Rewards Card', category:'Dining', amount: 150 });
await dbPut('bills', { id:'rc', name:'Rewards', recurrence:'auto-cc', linkedAccount:'Rewards Card', account:'Rewards Card', fromAccount:'Second Checking', type:'CC Payment', category:'CC Payment',
  closeDay: 22, graceDays: 25, ccAmount:'statement', amount: 0, dueDay: 17, active:true, paidMonths:{} });
await loadState();
state.flags.anchorsV3 = true;
state.flags.realAvailCards = ['Rewards Card'];
state.selected = { year: 2026, month: 10 };
await tick(700);
const acct = () => state.accounts.find(a => a.name === 'Rewards Card');
const reload = async () => { await loadState(); state.flags.anchorsV3 = true; state.flags.realAvailCards = ['Rewards Card']; state.selected = { year: 2026, month: 10 }; await tick(300); };
const kinds = () => ins.detectInsights(2026, 10, 30).map(i => i.kind);

/* ── nothing entered: an estimate, and it says so ── */
{
  const s = S.statementInfo('Rewards Card');
  check('the default is "I enter it"', S.statementMode('Rewards Card') === 'manual' && s.manual === true);
  check('nothing entered → needsEntry, the figures are the calculated estimate (3100)', s.needsEntry && !s.entered && near(s.statement, 3100) && near(s.remaining, 3100), JSON.stringify(s));
  check('(balance now 3250: the 150 after the close + the 200 pending)', near(balanceLatest('Rewards Card'), 3250));
}
app.navigate('home'); await tick(150);
{
  const r = $$('.cs-row').find(x => /Rewards Card/.test(x.textContent));
  check('Home card: asks for the statement balance and labels the figure an estimate', /Enter your statement balance/.test(r.textContent) && /~\$3,100\.00/.test(r.textContent) && /estimate/.test(r.textContent), r.textContent.replace(/\s+/g, ' '));
  const meta = $('.acct-row[data-acct="Rewards Card"] .stmt-due');
  check('the account row says it too', !!meta && /statement ~\$3,100\.00 · enter yours/.test(meta.textContent), meta?.textContent);
}
{
  const k = kinds();
  check('an insight asks you to enter it', k.includes('stmt-enter'));
  const e = ins.detectInsights(2026, 10, 30).find(i => i.kind === 'stmt-enter');
  check('…naming the card and the close date', /Enter Rewards Card's statement balance/.test(strip(e.title)) && /closed Oct 22/.test(strip(e.detail)) && /guessing ~\$3,100\.00/.test(strip(e.detail)));
  check('no due-date alarm or mismatch report built on a guess', !k.includes('stmt-due') && !k.includes('stmt-gap'));
}
app.navigate('bills'); await tick(120);
{
  const row = $('#view-bills .bill-row[data-bill-id="rc"]');
  check('Bills row: statement ~3100 (estimate — enter yours)', /Statement ~\$3,100\.00 still due \(estimate — enter yours\)/.test(row.textContent), row.textContent.replace(/\s+/g, ' '));
  const it = NM.payRunItems(2026, 10).find(i => i.kind === 'card');
  check('the pay run labels the card amount as an estimate', it && near(it.amount, 3100) && /\(estimate\)/.test(it.meta), JSON.stringify(it));
  const nov = fc.buildEvents(40).find(e => e.kind === 'card' && iso(e.date) === '2026-11-01');
  check('the forecast too', nov && /\(estimate\)/.test(nov.detail), JSON.stringify(nov && nov.detail));
}

/* ── enter it from the Bills tab ── */
{
  await click($('#view-bills .bill-row[data-bill-id="rc"] .bill-enter'), 120);
  check('the payment sheet has the statement balance to type, flagged as not entered', $('#cp-stmt-amt')?.value === '3100.00' && /not entered yet — this is an estimate/.test(text()));
  type('#cp-stmt-amt', '2900');
  check('typing it updates still due (2900) and what lands on the next statement (350)', $('#cp-due').textContent === '$2,900.00' && $('#cp-next').textContent === '$350.00', $('#cp-due').textContent + ' ' + $('#cp-next').textContent);
  type('#cp-amt', '2000');
  check('…and the difference for what you will pay', /\$2,000\.00 of \$2,900\.00 due → \$900\.00 left/.test($('#cp-diff').textContent), $('#cp-diff').textContent);
  await click($('#cp-save'), 150);
  const s = S.statementInfo('Rewards Card');
  check('saving stored the statement balance for that statement', s.entered && !s.needsEntry && near(s.statement, 2900) && acct().stmt.closeIso === '2026-10-22');
  check('…and the plan', near(B.plannedPayment(state.bills.find(b => b.id === 'rc'), '2026-10'), 2000));
  check('the next statement is derived from YOUR number: 3250 − 2900 = 350 (pending 200 + the 150)', near(s.charged, 350), String(s.charged));
}
{
  const k = kinds();
  check('the "enter it" insight is gone once entered', !k.includes('stmt-enter'));
  check('…and no mismatch report in manual mode (Ledger\'s own 3100 isn\'t trusted)', !k.includes('stmt-gap'));
  app.navigate('home'); await tick(120);
  const r = $$('.cs-row').find(x => /Rewards Card/.test(x.textContent));
  check('Home card: closed Oct 22 · entered, $350 on the next statement', /entered/.test(r.textContent) && /\$350\.00 charged since/.test(r.textContent) && !/Enter your statement/.test(r.textContent), r.textContent.replace(/\s+/g, ' '));
  const it = NM.payRunItems(2026, 10).find(i => i.kind === 'card');
  check('the pay run says (entered)', /\(entered\)/.test(it.meta));
}

/* ── the next statement needs entering again ── */
{
  const n = S.statementInfo('Rewards Card', '2026-11-23');
  check('once the next statement closes, manual mode asks again', n.closeIso === '2026-11-22' && n.needsEntry && !n.entered);
}

/* ── the card sheet: switch to "Ledger calculates" and back ── */
{
  const C = await import('../js/cards.js');
  C.openCardSheet('Rewards Card'); await tick(80);
  check('the sheet has the choice; "I enter it" is selected', !!$('#cs-smode') && $$('#cs-smode .seg-btn').find(b => b.dataset.v === 'manual').classList.contains('active'));
  check('…and explains why', /Pending charges often post to the next statement/.test(text()));
  await click($$('#cs-smode .seg-btn').find(b => b.dataset.v === 'auto'), 150);
  check('"Ledger calculates" is stored on the card', acct().stmtMode === 'auto' && S.statementMode('Rewards Card') === 'auto');
  let s = S.statementInfo('Rewards Card');
  check('an entered number still counts for its statement in that mode', s.entered && near(s.statement, 2900) && !s.needsEntry && s.manual === false);
  check('…and in this mode Ledger reports a mismatch (2900 vs its own 3100)', kinds().includes('stmt-gap'));
  await click($('#cs-clear'), 150);
  s = S.statementInfo('Rewards Card');
  check('cleared in calculate mode: the computed 3100, no estimate flag, no prompt', !s.entered && !s.needsEntry && near(s.statement, 3100));
  check('…no "enter it" insight', !kinds().includes('stmt-enter'));
  C.openCardSheet('Rewards Card'); await tick(60);
  await click($$('#cs-smode .seg-btn').find(b => b.dataset.v === 'manual'), 150);
  check('back to "I enter it" → an estimate again', S.statementInfo('Rewards Card').needsEntry);
  closeSheet(); await tick(40);
}

/* ── the card sheet's own entry ── */
{
  const C = await import('../js/cards.js');
  C.openCardSheet('Rewards Card'); await tick(80);
  check('not entered yet: the sheet says the figures are an estimate and why', /Not entered yet — the figures above are an estimate \(\$3,100\.00 added up from your transactions/.test(text()) && /\(estimate\)/.test(text()));
  type('#cs-amt', '2900'); await click($('#cs-save'), 150);
  const s = S.statementInfo('Rewards Card');
  check('entered from the card sheet', s.entered && near(s.statement, 2900) && near(s.charged, 350));
  check('…and the sheet now reads as entered', /You entered this\./.test(text()) && !/\(estimate\)/.test(text()));
  closeSheet(); await tick(40);
}

check('no unhandled errors', errors.length === 0, errors.join('\n'));
done('manual statement balance tests');
