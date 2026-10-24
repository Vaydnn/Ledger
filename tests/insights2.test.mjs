/* v3.2: the Insights card ("Worth a look") — always-true filler is gone, new
   actionable insights, dismissal that sticks until the subject changes,
   tap-through, and a card that disappears when there is nothing to say.
   Synthetic data, "today" pinned to 2026-10-24. */
import { bootEnv, makeChecker, tick, domHelpers, freezeDate } from './_env.mjs';
freezeDate(2026, 10, 24);
const dom = await bootEnv();
const { check, done } = makeChecker();
const { $, $$, click } = domHelpers(dom);
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));

const { state, dbPut, dbDel, loadState } = await import('../js/db.js');
const util = await import('../js/util.js');
const app = await import('../js/app.js'); await tick(150);
const ins = await import('../js/insights.js');
const { closeSheet } = await import('../js/sheet.js');
const near = (a, b) => Math.abs(a - b) < 0.005;
const text = () => $('#sheetBody').textContent.replace(/\s+/g, ' ').trim();
const strip = (s) => String(s).replace(/<[^>]+>/g, '');
const kinds = () => ins.detectInsights(2026, 10, 30).map(i => i.kind);
const find = (k) => ins.detectInsights(2026, 10, 30).find(i => i.kind === k);

await dbPut('accounts', { id:'a1', name:'Main Checking', type:'Checking', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'Gap Card', type:'Credit Card', active:true, order:1, closeDay: 22, graceDays: 25, stmtMode:'auto' });
await dbPut('accounts', { id:'a3', name:'Due Card', type:'Credit Card', active:true, order:2, closeDay: 17, graceDays: 10, stmtMode:'auto' });
for (const [k, list] of Object.entries({ Expense:['Dining','Groceries','Phone','Rent'], Income:['Salary'], Refund:['Return'], Investment:['Brokerage'], CCPayment:['CC Payment'], LoanPayment:['Loan Payment'], Transfer:['Transfer'], BalanceTransfer:['Balance Transfer'] })){
  await dbPut('categories', { id:k, list });
}
for (const [i, [acct, amt]] of [['Main Checking', 5000], ['Gap Card', 1000], ['Due Card', 400]].entries()){
  await dbPut('balanceAnchors', { id:'an' + i, account: acct, month:'2026-10', amount: amt });
}
let seq = 0;
const add = (o) => dbPut('transactions', { id:'i' + (++seq), description:'', ...o });
await add({ date:'2026-10-05', type:'Expense', account:'Due Card', category:'Groceries', amount: 100 });
await loadState();
state.flags.anchorsV3 = true;
state.selected = { year: 2026, month: 10 };
await tick(600);
const acct = (n) => state.accounts.find(a => a.name === n);

/* ── a quiet ledger says nothing ── */
{
  const k = kinds();
  check('none of the always-true insights are produced (streak, biggest category, burn, income-up)', !k.some(x => ['streak', 'biggest', 'burn', 'burn-under', 'income-up'].includes(x)), k.join());
  app.navigate('more'); app.navigate('home'); await tick(120);
}

/* ── statement due ── */
{
  const d = find('stmt-due');
  check('a card with an unpaid statement due in 3 days is flagged (warn)', d && /Due Card statement due in 3d/.test(strip(d.title)) && d.tone === 'warn' && /\$500\.00 still due of the \$500\.00 statement that closed Oct 17/.test(strip(d.detail)), JSON.stringify(d));
    // an Auto (CC) bill tracking the card takes over the reminder
  await dbPut('bills', { id:'ab', name:'Due', recurrence:'auto-cc', linkedAccount:'Due Card', fromAccount:'Main Checking', closeDay:17, graceDays:10, ccAmount:'statement', active:true, paidMonths:{} });
  await loadState(); state.flags.anchorsV3 = true; state.selected = { year: 2026, month: 10 }; await tick(300);
  check('a card tracked by an Auto (CC) bill gets its reminder from the bill, not here', !find('stmt-due'));
  await dbDel('bills', 'ab'); await loadState(); state.flags.anchorsV3 = true; state.selected = { year: 2026, month: 10 }; await tick(300);
  // past due
  acct('Due Card').graceDays = 3; await dbPut('accounts', acct('Due Card')); await tick(100);
  const p = find('stmt-due');
  check('past due reads as such', p && /4d past due/.test(strip(p.title)) && p.tone === 'warn', JSON.stringify(p));
  acct('Due Card').graceDays = 10; await dbPut('accounts', acct('Due Card'));
}

/* ── a statement balance you entered that Ledger can't reproduce ── */
{
  await add({ date:'2026-10-12', type:'Expense', account:'Gap Card', category:'Groceries', amount: 0.01 });
  await loadState(); state.flags.anchorsV3 = true; state.selected = { year: 2026, month: 10 }; await tick(300);
  acct('Gap Card').stmt = { closeIso:'2026-10-22', amount: 1100.01 }; await dbPut('accounts', acct('Gap Card')); await tick(100);
  let g = find('stmt-gap');
  check('bank says 1100.01, Ledger computes 1000.01 → 100 missing', g && /Gap Card: your bank says \$1,100\.01, Ledger has \$1,000\.01/.test(strip(g.title)) && /\$100\.00 missing/.test(strip(g.detail)) && g.tone === 'warn', JSON.stringify(g));
  acct('Gap Card').stmt = { closeIso:'2026-10-22', amount: 900.01 }; await dbPut('accounts', acct('Gap Card')); await tick(100);
  g = find('stmt-gap');
  check('the other direction: Ledger has 100 extra', g && /\$100\.00 extra in Ledger/.test(strip(g.detail)));
  acct('Gap Card').stmt = { closeIso:'2026-10-22', amount: 1002 }; await dbPut('accounts', acct('Gap Card')); await tick(100);
  check('a gap under $5 is rounding, not news', !find('stmt-gap'));
  acct('Gap Card').stmt = { closeIso:'2026-10-22', amount: 1100.01 }; await dbPut('accounts', acct('Gap Card')); await tick(100);
  check('…and a gap is only ever about an ENTERED balance (none entered → no insight)', (() => { const a = acct('Gap Card'); const keep = a.stmt; delete a.stmt; const r = !find('stmt-gap'); a.stmt = keep; return r; })());
}

/* ── a variable bill off its average ── */
{
  await dbPut('bills', { id:'vb', name:'Mobile', recurrence:'monthly', variable:true, type:'Expense', account:'Main Checking', category:'Phone', amount: 100, dueDay: 1, active:true,
    paidMonths:{}, amounts:{ '2026-07':100, '2026-08':100, '2026-09':100, '2026-10':160 } });
  await loadState(); state.flags.anchorsV3 = true; state.selected = { year: 2026, month: 10 }; await tick(300);
  const v = find('variable-bill');
  check('Mobile came in $160 — $60 above its $100 average', v && /Mobile came in \$160\.00 — \$60\.00 above its average/.test(strip(v.title)) && /averaged \$100\.00/.test(strip(v.detail)) && v.tone === 'warn', JSON.stringify(v));
  const vb = state.bills.find(b => b.id === 'vb'); vb.amounts['2026-10'] = 104; await dbPut('bills', vb); await tick(100);
  check('a small difference is not news', !find('variable-bill'));
  vb.amounts['2026-10'] = 70; await dbPut('bills', vb); await tick(100);
  check('…below average is good news', find('variable-bill')?.tone === 'good' && /below its average/.test(strip(find('variable-bill').title)));
  vb.amounts['2026-10'] = 160; await dbPut('bills', vb);
}

/* ── the last 7 days vs a typical week ── */
{
  for (let i = 0; i <= 8; i++) await add({ date: util.toLocalISO(util.addDays(new Date(), -3 - 7 * i)), type:'Expense', account:'Main Checking', category:'Groceries', amount: 100 });
  await loadState(); state.flags.anchorsV3 = true; state.selected = { year: 2026, month: 10 }; await tick(300);
  check('a normal week says nothing', !find('week'));
  await add({ date:'2026-10-23', type:'Expense', account:'Main Checking', category:'Dining', amount: 350 });
  await loadState(); state.flags.anchorsV3 = true; state.selected = { year: 2026, month: 10 }; await tick(300);
  const w = find('week');
  check('450 in 7 days vs a typical 100 → flagged', w && /\$450 spent in the last 7 days — 4\.5× a typical week/.test(strip(w.title)) && w.tone === 'warn', JSON.stringify(w));
}

/* ── an outlier names its merchant ── */
{
  const d = (m, day) => `2026-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  for (let m = 4; m <= 9; m++) await add({ date: d(m, 10), type:'Expense', account:'Main Checking', category:'Dining', amount: 100, description:'Diner' });
  await add({ date:'2026-10-02', type:'Expense', account:'Main Checking', category:'Dining', amount: 150, description:'Cafe Uno' });
  await add({ date:'2026-10-09', type:'Expense', account:'Main Checking', category:'Dining', amount: 100, description:'Cafe Uno' });
  await loadState(); state.flags.anchorsV3 = true; state.selected = { year: 2026, month: 10 }; await tick(300);
  const o = find('outlier-high');
  check('Dining is far over its median, and the detail names who', o && /Dining is \d+% of your 6-mo median/.test(strip(o.title)) && /Mostly Cafe Uno: \$250\.00 over 2 charges/.test(strip(o.detail)), JSON.stringify(o && [o.title, o.detail]));
}

/* ── the cash side ── */
{
  await dbPut('bills', { id:'rent', name:'Rent', recurrence:'monthly', type:'Expense', account:'Main Checking', category:'Rent', amount: 4800, dueDay: 5, active:true, paidMonths:{} });
  await loadState(); state.flags.anchorsV3 = true; state.selected = { year: 2026, month: 10 }; await tick(300);
  const c = find('cash-tight');
  check('a pay run that leaves cash negative says how short, and when', c && /Cash runs \$[\d,]+ short around Nov \d+/.test(strip(c.title)) && c.tone === 'warn' && /Open Next month/.test(strip(c.detail)), JSON.stringify(c && [c.title, c.detail]));
  check('…and is among the top three', ins.detectInsights(2026, 10, 3).some(i => i.kind === 'cash-tight'));
  const r = state.bills.find(b => b.id === 'rent'); r.amount = 100; await dbPut('bills', r); await tick(100);
  check('plenty of cash → no insight', !find('cash-tight'));
  await dbDel('bills', 'rent'); await loadState(); state.flags.anchorsV3 = true; state.selected = { year: 2026, month: 10 }; await tick(300);
}

/* ── the card: dismiss + tap-through ── */
{
  app.navigate('more'); app.navigate('home'); await tick(150);
  const card = $('.home-card[data-card="insights"]');
  check('the card is titled "Worth a look"', !!card && /Worth a look/.test(card.querySelector('.card-title').textContent));
  check('three at most, each with its own dismiss ×', $$('.insight-row', card).length === 3 && $$('.ins-dismiss', card).length === 3);
  const before = $$('.insight-row .insight-title', card).map(e => e.textContent);
  const firstKey = $('.ins-dismiss', card).dataset.ikey || $('.ins-dismiss', card).dataset.key;
  await click($('.ins-dismiss', card), 150);
  const after = $$('.home-card[data-card="insights"] .insight-title').map(e => e.textContent);
  check('× removes that insight and the next one steps up', !after.includes(before[0]) && after.length === 3 && after.slice(0, 2).join() === before.slice(1).join(), JSON.stringify([before, after]));
  check('…the dismissal is stored by key', !!firstKey && (state.flags.insightDismissed?.[firstKey] || (state.flags.dismissedDups || []).includes(firstKey)));
  // Stays gone after re-render and recompute.
  app.navigate('more'); app.navigate('home'); await tick(150);
  check('…and stays gone', !$$('.home-card[data-card="insights"] .insight-title').map(e => e.textContent).includes(before[0]));
  // Dismiss them all → the card disappears.
  for (let n = 0; n < 12 && $('.home-card[data-card="insights"]'); n++){
    const b = $('.home-card[data-card="insights"] .ins-dismiss');
    if (!b) break;
    await click(b, 120);
  }
  check('dismiss everything → the card is gone, not an empty box', !$('.home-card[data-card="insights"]'));
  // Reset and test the tap-through.
  state.flags.insightDismissed = {}; state.flags.dismissedDups = [];
  app.navigate('more'); app.navigate('home'); await tick(150);
  const rows = $$('.home-card[data-card="insights"] .insight-row');
  check('rows that lead somewhere are marked', rows.some(r => r.dataset.iact));
}
{
  // Tap each kind we can produce and make sure it opens the right thing.
  const all = ins.detectInsights(2026, 10, 30).filter(i => i._act);
  const act = (kind) => all.find(i => i.kind === kind)?._act;
  check('stmt-gap → the card sheet', JSON.stringify(act('stmt-gap')) === '["card","Gap Card"]');
  check('variable-bill → Bills', act('variable-bill')?.[0] === 'bills');
  check('week → Activity', act('week')?.[0] === 'activity');
  check('outlier → Activity searching that category', JSON.stringify(act('outlier-high')) === '["category","Dining"]');
  state.flags.insightDismissed = {}; state.selected = { year: 2026, month: 10 };
  app.navigate('more'); app.navigate('home'); await tick(150);
  // Open the stmt-gap row via the DOM by making it the top insight (dismiss the rest).
  const dismissed = {};
  for (const i of ins.detectInsights(2026, 10, 30)) if (i.kind !== 'stmt-gap' && i._key) dismissed[i._key] = '2026-10-24';
  state.flags.insightDismissed = dismissed;
  app.navigate('more'); app.navigate('home'); await tick(150);
  const row = $$('.home-card[data-card="insights"] .insight-row').find(r => r.dataset.iact === 'card');
  check('(the stmt-gap row is there)', !!row);
  await click(row, 150);
  check('tapping it opens that card\'s sheet', /^Gap Card/.test(text()) && !!$('#cs-amt'));
  closeSheet(); await tick(60);
}

/* ── dismissal is tied to the subject: a new month / new numbers bring it back ── */
{
  const g1 = find('stmt-gap');
  state.flags.insightDismissed = { [g1._key]: '2026-10-24' };
  check('a dismissed insight stays hidden for the same subject', !find('stmt-gap'));
  acct('Gap Card').stmt = { closeIso:'2026-10-22', amount: 1200.01 }; await dbPut('accounts', acct('Gap Card')); await tick(100);
  check('…but a different gap (new numbers) is news again', !!find('stmt-gap'));
}

check('no unhandled errors', errors.length === 0, errors.join('\n'));
done('insights v3.2 tests');
