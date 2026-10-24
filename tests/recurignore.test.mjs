/* v3.2.3: two one-off purchases that happen to look regular were being
   projected forever (two $1.07 game purchases 9 days apart → "weekly").
   - two charges only count as a series when the rhythm is monthly or longer
   - "Not recurring" dismisses a detected series (Subscriptions sheet and the
     Next month preview), stored by key, undoable.
   Synthetic data, "today" pinned to 2026-10-24. */
import { bootEnv, makeChecker, tick, domHelpers, freezeDate } from './_env.mjs';
freezeDate(2026, 10, 24);
const dom = await bootEnv();
const { check, done } = makeChecker();
const { $, $$, click } = domHelpers(dom);
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));

const { state, dbPut, loadState } = await import('../js/db.js');
const util = await import('../js/util.js');
const app = await import('../js/app.js'); await tick(150);
const sub = await import('../js/subscriptions.js');
const NM = await import('../js/nextmonth.js');
const fc = await import('../js/forecast.js');
const { closeSheet } = await import('../js/sheet.js');
const text = () => $('#sheetBody').textContent.replace(/\s+/g, ' ').trim();
const D = (n) => util.toLocalISO(util.addDays(new Date(), n));

await dbPut('accounts', { id:'a1', name:'Main Checking', type:'Checking', active:true, order:0 });
for (const [k, list] of Object.entries({ Expense:['Misc','Subscriptions'], Income:['Salary'], Refund:['Return'], Investment:['Brokerage'], CCPayment:['CC Payment'], LoanPayment:['Loan Payment'], Transfer:['Transfer'], BalanceTransfer:['Balance Transfer'] })){
  await dbPut('categories', { id:k, list });
}
await dbPut('balanceAnchors', { id:'an0', account:'Main Checking', month:'2026-10', amount: 5000 });
let seq = 0;
const add = (o) => dbPut('transactions', { id:'r' + (++seq), ...o });
// Two game purchases 9 days apart, same price — not a habit.
await add({ date: D(-26), type:'Expense', account:'Main Checking', category:'Misc', description:'Game Co', amount: 1.07 });
await add({ date: D(-17), type:'Expense', account:'Main Checking', category:'Misc', description:'Game Co', amount: 1.07 });
// A real weekly charge: four, a week apart.
for (const n of [-3, -10, -17, -24]) await add({ date: D(n), type:'Expense', account:'Main Checking', category:'Subscriptions', description:'Newsbox', amount: 5 });
// A brand-new MONTHLY subscription with just two identical charges still counts.
await add({ date: D(-62), type:'Expense', account:'Main Checking', category:'Subscriptions', description:'Cloudbox', amount: 9 });
await add({ date: D(-32), type:'Expense', account:'Main Checking', category:'Subscriptions', description:'Cloudbox', amount: 9 });
await loadState();
state.flags.anchorsV3 = true;
state.selected = { year: 2026, month: 10 };
await tick(600);
const labels = () => sub.detectRecurring('Expense').map(r => r.label.toLowerCase());

check('two same-price purchases 9 days apart are NOT a weekly subscription', !labels().some(l => l.includes('game co')), labels().join());
check('a real weekly series (4 charges) still is', labels().some(l => l.includes('newsbox')));
check('two identical charges a month apart (a new monthly subscription) still count', labels().some(l => l.includes('cloudbox')));
check('the forecast no longer projects the game', !fc.buildEvents(40).some(e => /game co/i.test(e.label)));

/* ── "Not recurring" ── */
{
  const key = sub.detectRecurring('Expense').find(r => /newsbox/i.test(r.label)).key;
  check('events carry their series key', fc.buildEvents(40).filter(e => /newsbox/i.test(e.label)).every(e => e.seriesKey === key));
  NM.openNextMonthSheet(); await tick(100);
  const x = $$('.nm-ignore').find(b => b.dataset.key === key);
  check('the preview offers ✕ on a projected recurring charge', !!x && /tap ✕ if this isn't really recurring/.test(text()));
  await click(x, 200);
  check('✕ stops treating it as recurring (stored by key)', (state.flags.recurIgnored || []).includes(key) && !labels().some(l => l.includes('newsbox')));
  check('…it is gone from the forecast and the preview', !fc.buildEvents(40).some(e => /newsbox/i.test(e.label)) && !/Newsbox/.test(text()));
  check('…with an Undo', $('#toast-act')?.textContent === 'Undo');
  await click($('#toast-act'), 200);
  check('Undo brings it back', !(state.flags.recurIgnored || []).includes(key) && labels().some(l => l.includes('newsbox')));
  closeSheet(); await tick(40);
}
{
  const key = sub.detectRecurring('Expense').find(r => /cloudbox/i.test(r.label)).key;
  sub.openSubscriptionsSheet(); await tick(80);
  const btns = $$('.sub-ignore');
  check('the Subscriptions sheet has "Not recurring" on each row', btns.length === sub.detectRecurring('Expense').length && btns.some(b => b.dataset.key === key));
  await click(btns.find(b => b.dataset.key === key), 150);
  check('…and it works from there too', !labels().some(l => l.includes('cloudbox')) && !/Cloudbox/.test(text()));
  closeSheet(); await tick(40);
  await sub.unignoreRecurring(key);
  check('unignore restores it', labels().some(l => l.includes('cloudbox')));
}

check('no unhandled errors', errors.length === 0, errors.join('\n'));
done('recurring ignore tests');
