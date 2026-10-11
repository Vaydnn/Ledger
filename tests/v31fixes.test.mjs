/* v3.1 self-review fixes (items 1–5):
   1. editing a transaction / bill on a CLOSED account keeps that account
   2. the "Always use…" prompt asks once per category, never nags
   3. file pickers keep a broad type filter that still allows .CSV
   4. a paid-off card reads $0.00, not −$0.00
   5. short statement names don't fuzzy-match longer merchants */
import { bootEnv, makeChecker, tick, domHelpers } from './_env.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const { $, $$, click, pick, type } = domHelpers(dom);
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));

const { state, dbPut, loadState } = await import('../js/db.js');
const app = await import('../js/app.js'); await tick(150);
const { addForm, resetAddForm, startEdit } = await import('../js/add.js');

for (const [i, [name, t, active]] of [['Checking','Checking',true],['Old Bank','Checking',false],['Citi','Credit Card',true],['RH','Credit Card',true]].entries()){
  await dbPut('accounts', { id:'a'+i, name, type:t, active, order:i });
}
for (const [k, list] of Object.entries({ Expense:['Groceries','Restaurants','Misc'], Income:['Salary'], Refund:['Return'], Investment:['Brokerage'], CCPayment:['CC Payment'], LoanPayment:['Loan Payment'], Transfer:['Transfer'], BalanceTransfer:['Balance Transfer'] })){
  await dbPut('categories', { id:k, list });
}
await dbPut('transactions', { id:'old1', date:'2026-03-04', type:'Expense', account:'Old Bank', category:'Groceries', amount:42, description:'groceries' });
await dbPut('transactions', { id:'old2', date:'2026-03-05', type:'Transfer', account:'Checking', fromAccount:'Old Bank', category:'Transfer', amount:300, description:'' });
await dbPut('bills', { id:'b1', name:'Old rent', recurrence:'monthly', type:'Expense', account:'Old Bank', amount:500, dueDay:3, category:'Rent', active:true, paidMonths:{} });
await loadState();
state.flags.anchorsV3 = true;
await tick(700); // let any delayed load toasts pass

/* ── 1. closed-account edits ── */
startEdit(state.transactions.find(t => t.id === 'old1')); await tick(60);
check('edit form keeps the closed account', addForm.account === 'Old Bank', addForm.account);
check('…and labels it closed', ($('#f-acct')?.textContent || '').includes('closed'));
type('#f-desc', 'groceries (fixed typo)');
await click($('#f-save'), 200);
const o1 = state.transactions.find(t => t.id === 'old1');
check('saving the edit leaves the account alone', o1.account === 'Old Bank' && o1.description === 'groceries (fixed typo)', JSON.stringify(o1));

startEdit(state.transactions.find(t => t.id === 'old2')); await tick(60);
check('transfer edit keeps the closed SOURCE account', addForm.fromAccount === 'Old Bank', addForm.fromAccount);
await click($('#f-save'), 200);
check('transfer saved unchanged', state.transactions.find(t => t.id === 'old2').fromAccount === 'Old Bank');

// The closed account is offered (labeled) only while editing its own txn.
startEdit(state.transactions.find(t => t.id === 'old1')); await tick(60);
await click($('#f-acct'));
const closedOpt = $$('.picker-option').find(o => o.dataset.v === 'Old Bank');
check('picker lists the closed account with a "closed" note', !!closedOpt && closedOpt.textContent.includes('closed'));
await click($('#picker-cancel'));
resetAddForm({ type:'Expense' }); app.navigate('add'); await tick(60);
await click($('#f-acct'));
check('a NEW transaction does not offer closed accounts', !$$('.picker-option').some(o => o.dataset.v === 'Old Bank'));
await click($('#picker-cancel'));

const { openBillSheet } = await import('../js/bills.js');
openBillSheet('b1'); await tick(60);
await click($('#bf-save'), 200);
check('bill on a closed account keeps it after save', state.bills.find(b => b.id === 'b1').account === 'Old Bank');

/* ── 2. "Always use…" asks once per category ── */
const toastText = () => $('#toast').textContent || '';
const overrideTo = async (cat, acct) => {
  resetAddForm({ type:'Expense' }); app.navigate('add'); await tick(40);
  $('#toast').textContent = '';
  await click($('#f-cat')); await pick(cat); await tick(30);
  const before = addForm.account;
  const target = before === acct ? (acct === 'Citi' ? 'RH' : 'Citi') : acct;
  await click($('#f-acct')); await pick(target); await tick(40);
  return target;
};
state.flags.categoryAccounts = {}; state.flags.categoryRuleAsked = {};
const t1 = await overrideTo('Restaurants', 'Citi');
check('first override in a category asks', toastText().includes(`Always use ${t1} for Restaurants`), toastText());
await overrideTo('Restaurants', 'RH');
check('second override in the same category does not ask again', !toastText().includes('Always use'), toastText());
await overrideTo('Misc', 'Citi');
check('a different category still gets asked once', toastText().includes('for Misc'), toastText());
state.flags.categoryAccounts = { 'Expense|Groceries': 'Citi' }; state.flags.categoryRuleAsked = {};
await overrideTo('Groceries', 'RH');
check('overriding an existing rule never asks', !toastText().includes('Always use'), toastText());
const { dbAll } = await import('../js/db.js');
const savedFlags = (await dbAll('meta')).find(m => m.id === 'flags');
check('asked-state is persisted in flags', !!savedFlags?.categoryRuleAsked?.['Expense|Misc'], JSON.stringify(savedFlags?.categoryRuleAsked));

/* ── 3. file-picker filters ── */
{
  let seen = null;
  const origCreate = dom.window.document.createElement.bind(dom.window.document);
  dom.window.document.createElement = function(tag){
    const el = origCreate(tag);
    if (String(tag).toLowerCase() === 'input') el.click = function(){ seen = this.accept; };
    return el;
  };
  const manage = await import('../js/manage.js');
  manage.restoreJSON(() => {});
  check('restore picker: JSON types + octet-stream (Drive / uppercase files)',
    /\.json/.test(seen) && /application\/json/.test(seen) && /application\/octet-stream/.test(seen), seen);
  check('restore picker is not unfiltered (no Camera/Recorder on Android)', !!seen);
  dom.window.document.createElement = origCreate;
}

/* ── 4. Home balance text ── */
{
  const { acctBalanceHTML } = await import('../js/home.js');
  const card = { type:'Credit Card' }, chk = { type:'Checking' };
  const txt = (h) => h.replace(/<[^>]+>/g, '');
  check('paid-off card reads $0.00', txt(acctBalanceHTML(card, 0)) === '$0.00', acctBalanceHTML(card, 0));
  check('rounding dust on a card reads $0.00', txt(acctBalanceHTML(card, 0.001)) === '$0.00');
  check('owed card keeps the minus', txt(acctBalanceHTML(card, 612.4)) === '−$612.40');
  check('card credit reads +credit', txt(acctBalanceHTML(card, -20)) === '+$20.00 credit');
  check('overdrawn checking reads negative', txt(acctBalanceHTML(chk, -50)) === '−$50.00');
  check('positive checking unchanged', txt(acctBalanceHTML(chk, 1234)) === '$1,234.00');
}

/* ── 5. fuzzy merchant matching ── */
{
  const mer = await import('../js/merchants.js');
  // Synthetic merchants (same shapes as the real-world cases: a short name
  // that's a prefix of a longer one, a short name + word break, a long
  // prefix, a brand written without its space).
  for (const [d, cat] of [['Acmeco Optical','Health'],['Taco','Restaurants'],['Joe\'s Coffee Roasters','Restaurants'],['Megamart','Groceries'],['Bean Bros','Restaurants']]){
    await dbPut('transactions', { id:'fz-'+d, date:'2026-09-01', type:'Expense', account:'Citi', category:cat, amount:5, description:d });
  }
  await loadState();
  const f = (n) => mer.findMerchantFuzzy(n)?.display || null;
  check('"ACMECO" does not match "Acmeco Optical"', f('ACMECO') === null, f('ACMECO'));
  check('"TACO SHACK" still matches "Taco" at a word break', f('TACO SHACK') === 'Taco', f('TACO SHACK'));
  check('"TACOSHACK" (no break) does not match short "Taco"', f('TACOSHACK') === null, f('TACOSHACK'));
  check('long merchant prefix still matches ("MEGAMART SUPERCENTER")', f('MEGAMART SUPERCENTER') === 'Megamart', f('MEGAMART SUPERCENTER'));
  check('squashed brand still matches ("BEANBROS COFFEE")', f('BEANBROS COFFEE') === 'Bean Bros', f('BEANBROS COFFEE'));
  check('near-complete prefix matches ("JOES COFFEE ROAST")', f('JOES COFFEE ROAST') === "Joe's Coffee Roasters", f('JOES COFFEE ROAST'));
  check('exact still wins', f('acmeco optical') === 'Acmeco Optical');
}

check('zero captured errors', errors.length === 0, errors[0]);
done('v3.1 fixes tests');
