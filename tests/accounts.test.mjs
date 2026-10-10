/* v3.0 accounts: missing-account recovery, close (with zero-out opening),
   delete guarded by references, merge, and rename cascading into the new
   name-keyed places (pins, category default accounts). Drives the real
   sheets through the DOM. */
import { bootEnv, makeChecker, tick } from './_env.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const $ = s => dom.window.document.querySelector(s);
const $$ = s => Array.from(dom.window.document.querySelectorAll(s));
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));

const { state, dbPut, loadState } = await import('../js/db.js');
await import('../js/app.js'); await tick(150);
const { balanceLatest, balanceAt } = await import('../js/effects.js');
const manage = await import('../js/manage.js');
const near = (a, b) => Math.abs(a - b) < 0.005;
const click = async (el, ms = 60) => { el.click(); await tick(ms); };
const pick = async (label) => { const o = $$('.picker-option').find(x => x.querySelector('span').textContent.trim() === label); await click(o); return !!o; };

await dbPut('accounts', { id:'a1', name:'Main Checking', type:'Checking', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'Main Card', type:'Credit Card', active:true, order:1 });
await dbPut('accounts', { id:'a3', name:'Spare Card', type:'Credit Card', active:true, order:2 });
// "Old Bank" was deleted in v2 — its history still references it.
const txns = [
  { id:'t1', date:'2026-01-05', type:'Income', account:'Old Bank', category:'Salary', amount:1000, description:'' },
  { id:'t2', date:'2026-02-03', type:'Transfer', account:'Main Checking', fromAccount:'Old Bank', category:'Transfer', amount:1300, description:'' },
  { id:'t3', date:'2026-02-10', type:'Expense', account:'Main Card', category:'Restaurants', amount:40, description:'' },
  { id:'t4', date:'2026-02-11', type:'Expense', account:'Spare Card', category:'Misc', amount:15, description:'' }
];
for (const t of txns) await dbPut('transactions', t);
await loadState();
state.flags.anchorsV3 = true;
state.flags.categoryAccounts = { 'Expense|Restaurants': 'Main Card' };
state.flags.realAvailCards = ['Main Card'];

// ── Missing account detection + recovery ──
check('missing account detected', manage.missingAccounts().map(m => m.name).includes('Old Bank'));
check('Old Bank side of the transfer counts nowhere before recovery', near(balanceLatest('Old Bank'), 0));
manage.openAccountsSheet(); await tick(40);
check('Missing section rendered', $('#sheetBody').textContent.includes('Missing'));
await click($('.a-recover[data-name="Old Bank"]'));
check('recover sheet guesses Checking from a transfer-out', $('#rv-type .picker-val').textContent === 'Checking');
await click($('#rv-go'), 150);
check('recovered account exists', !!state.accounts.find(a => a.name === 'Old Bank'));
check('history now flows: +1000 −1300 = −300', near(balanceLatest('Old Bank'), -300));
check('close sheet offers the $0 fix', !!$('#cl-fix'));
await click($('#cl-fix'), 150);
const ob = state.accounts.find(a => a.name === 'Old Bank');
check('closed after the fix', ob && ob.active === false && !!ob.closedAt);
check('opening set so it ends at exactly $0', near(balanceLatest('Old Bank'), 0));
check('opening pinned at its first active month', !!state.balanceAnchors.find(a => a.account === 'Old Bank' && a.month === '2026-01' && near(a.amount, 300)));
check('no longer missing', !manage.missingAccounts().length);

// ── Delete is guarded when the account is in use ──
const card = state.accounts.find(a => a.name === 'Spare Card');
manage.openAccountsSheet(); await tick(40);
await click($(`.a-edit[data-id="${card.id}"]`));
await click($('#ae-del'));
check('in-use delete shows the guard sheet, not a delete', !!$('#dl-close') && !!state.accounts.find(a => a.name === 'Spare Card'));
// Merge Spare Card into Main Card
await click($('#dl-merge'));
await pick('Main Card'); await tick(200);
check('merged account deleted', !state.accounts.find(a => a.name === 'Spare Card'));
check('its transaction moved', state.transactions.find(t => t.id === 't4').account === 'Main Card');
check('target balance includes it', near(balanceAt('Main Card', 2026, 2), 55));

// ── Rename cascades into pins, rules and Real Available ──
const main = state.accounts.find(a => a.name === 'Main Card');
manage.openAccountsSheet(); await tick(40);
await click($(`.a-edit[data-id="${main.id}"]`));
const nameInp = $('#ae-name'); nameInp.value = 'Citi Card'; nameInp.dispatchEvent(new dom.window.Event('input'));
await click($('#ae-save'), 200);
check('rename moved transactions', state.transactions.filter(t => t.account === 'Citi Card').length === 2);
check('rename moved the category default', state.flags.categoryAccounts['Expense|Restaurants'] === 'Citi Card');
check('rename moved Real Available config', state.flags.realAvailCards.includes('Citi Card') && !state.flags.realAvailCards.includes('Main Card'));

// ── Unused account deletes directly ──
await dbPut('accounts', { id:'a9', name:'Empty', type:'Savings', active:true, order:9 });
state.accounts.push({ id:'a9', name:'Empty', type:'Savings', active:true, order:9 });
manage.openAccountsSheet(); await tick(40);
await click($('.a-edit[data-id="a9"]'));
await click($('#ae-del'), 150);
check('unused account deleted outright', !state.accounts.find(a => a.name === 'Empty'));

// ── Closing a $0 account is one tap, and leaves Real Available ──
await dbPut('accounts', { id:'a10', name:'Zero Card', type:'Credit Card', active:true, order:10 });
state.accounts.push({ id:'a10', name:'Zero Card', type:'Credit Card', active:true, order:10 });
state.flags.realAvailCards = [...state.flags.realAvailCards, 'Zero Card'];
manage.openAccountsSheet(); await tick(40);
await click($('.a-edit[data-id="a10"]'));
await click($('#ae-close'));
check('zero-balance close has no fix button', !$('#cl-fix'));
await click($('#cl-close'), 150);
check('closed', state.accounts.find(a => a.name === 'Zero Card').active === false);
check('closed card dropped from Real Available', !state.flags.realAvailCards.includes('Zero Card'));

check('zero captured errors', errors.length === 0, errors[0]);
done('account lifecycle tests');
