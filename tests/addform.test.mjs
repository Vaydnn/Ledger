/* v3.0 Add form: per-category default account (explicit rule + learned
   habit), never overriding a manual pick; "Always use…" saves a rule;
   blank date rejected; double-tap Save logs once; a hand-logged bill
   payment offers to mark the bill paid. Drives the real form. */
import { bootEnv, makeChecker, tick } from './_env.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const $ = s => dom.window.document.querySelector(s);
const $$ = s => Array.from(dom.window.document.querySelectorAll(s));
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));

const { state, dbPut, loadState } = await import('../js/db.js');
const app = await import('../js/app.js'); await tick(150);
const { addForm, resetAddForm } = await import('../js/add.js');
const { isBillPaid } = await import('../js/bills.js');
const { today } = await import('../js/util.js');
const click = async (el, ms = 60) => { el.click(); await tick(ms); };
const pick = async (label) => { const o = $$('.picker-option').find(x => x.querySelector('span').textContent.trim() === label); if (o) await click(o); return !!o; };
const type = (sel, v) => { const el = $(sel); el.value = v; el.dispatchEvent(new dom.window.Event('input')); };
const ym = today().slice(0, 7);

for (const [i, [name, t]] of [['Checking','Checking'],['Everyday Card','Credit Card'],['Dining Card','Credit Card']].entries()){
  await dbPut('accounts', { id:'a'+i, name, type:t, active:true, order:i });
}
for (const [k, list] of Object.entries({ Expense:['Groceries','Misc','Restaurants','Utilities'], Income:['Salary'], Refund:['Return'] })){
  await dbPut('categories', { id:k, list });
}
// History: lots of Everyday Card use overall; Restaurants lately on Dining Card.
const d = (n) => { const x = new Date(); x.setDate(x.getDate() - n); return x.toISOString().slice(0, 10); };
let id = 0;
for (let n = 1; n <= 40; n++) await dbPut('transactions', { id:'h'+(id++), date:d(n), type:'Expense', account:'Everyday Card', category:'Groceries', amount:20, description:'' });
for (let n = 1; n <= 12; n++) await dbPut('transactions', { id:'h'+(id++), date:d(n * 3), type:'Expense', account:'Dining Card', category:'Restaurants', amount:15, description:'' });
for (let n = 1; n <= 3; n++) await dbPut('transactions', { id:'h'+(id++), date:d(150 + n), type:'Expense', account:'Everyday Card', category:'Restaurants', amount:15, description:'' });
await dbPut('bills', { id:'b1', name:'Internet', recurrence:'monthly', type:'Expense', account:'Checking', amount:70, dueDay:20, category:'Utilities', active:true, paidMonths:{} });
await loadState();
state.flags.anchorsV3 = true;
await tick(700); // let loadState's delayed "Restored N category lists" toast pass

app.navigate('add'); await tick(40);
check('form opens on the most-used account', addForm.account === 'Everyday Card', addForm.account);

// Learned habit: picking Restaurants switches to Dining Card.
await click($('#f-cat'));
await pick('Restaurants'); await tick(40);
check('habit switches Restaurants → Dining Card', addForm.account === 'Dining Card', addForm.account);
check('hint explains why', ($('.field-hint')?.textContent || '').includes('Restaurants'));

// Explicit rule beats habit.
state.flags.categoryAccounts = { 'Expense|Groceries': 'Dining Card' };
await click($('#f-cat'));
await pick('Groceries'); await tick(40);
check('explicit rule wins over 40 txns of habit', addForm.account === 'Dining Card', addForm.account);

// A manual pick is never overridden, and offers "Always use…".
await click($('#f-acct'));
await pick('Everyday Card'); await tick(40);
check('manual pick sticks', addForm.account === 'Everyday Card');
check('offer to make it the rule', ($('#toast').textContent || '').includes('Always use Everyday Card for Groceries'), JSON.stringify($('#toast').textContent));
await click($('#toast-act'), 80);
check('"Always" saves the rule', state.flags.categoryAccounts['Expense|Groceries'] === 'Everyday Card');
await click($('#f-cat'));
await pick('Restaurants'); await tick(40);
check('after a manual pick, category changes keep the account', addForm.account === 'Everyday Card');

// Blank date is refused.
resetAddForm({ type:'Expense' }); app.navigate('add'); await tick(40);
type('#f-amount', '12.50');
const dateInp = $('#f-date'); dateInp.value = ''; dateInp.dispatchEvent(new dom.window.Event('input'));
const n0 = state.transactions.length;
await click($('#f-save'), 150);
check('blank date not saved', state.transactions.length === n0);
check('says why', ($('#toast').textContent || '').includes('Pick a date'));

// Double-tap Save logs exactly one transaction.
resetAddForm({ type:'Expense' }); app.navigate('add'); await tick(40);
type('#f-amount', '9.99');
const save = $('#f-save');
save.click(); save.click(); save.click();
await tick(300);
check('triple-tap Save logs once', state.transactions.length === n0 + 1, `${n0} → ${state.transactions.length}`);

// Hand-logged bill → offer to mark paid.
resetAddForm({ type:'Expense' }); app.navigate('add'); await tick(40);
await click($('#f-cat')); await pick('Utilities'); await tick(40);
await click($('#f-acct')); await pick('Checking'); await tick(40);
type('#f-amount', '70.00');
type('#f-desc', 'Internet');
await click($('#f-save'), 200);
check('bill match offered', ($('#toast').textContent || '').includes('looks like "Internet"'));
await click($('#toast-act'), 200);
const bill = state.bills.find(b => b.id === 'b1');
check('marked paid with that transaction', isBillPaid(bill, ym) && state.transactions.some(t => t.id === bill.paidMonths[ym] && t.amount === 70));

check('zero captured errors', errors.length === 0, errors[0]);
done('add form v3 tests');
