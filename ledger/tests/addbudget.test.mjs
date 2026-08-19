/* Regression (v2.9.3): adding a new budget through the real UI.
   The Type/Category pickers replace #sheetBody while open; the old
   callbacks wrote the picked value onto the detached form and never
   re-rendered — the user was stranded on the picker and could not
   continue. This drives the full flow: pick category → amount → save. */
import { bootEnv, makeChecker, tick } from './_env.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const $ = s => dom.window.document.querySelector(s);
const $$ = s => Array.from(dom.window.document.querySelectorAll(s));
const { state, dbPut, loadState } = await import('../js/db.js');
await import('../js/app.js'); await tick(200);

await dbPut('accounts', { id:'a1', name:'Checking', type:'Checking', active:true, order:0 });
await dbPut('categories', { id:'Expense', list:['Groceries','Gas','Misc'] });
await dbPut('categories', { id:'Income', list:['Salary'] });
await dbPut('transactions', { id:'t1', date:new Date().toISOString().slice(0,10), type:'Expense', account:'Checking', category:'Groceries', amount:10, description:'' });
await loadState();

const { openBudgetsSheet } = await import('../js/budgets.js');
openBudgetsSheet(); await tick(50);
check('budgets sheet open', $('#sheet').classList.contains('open'));
check('add-budget form present', !!$('#bn-cat-pick'));

// the bug: tapping a category used to leave the picker on screen forever
$('#bn-cat-pick').click(); await tick(50);
const opt = $$('.picker-option').find(o => o.textContent.includes('Gas'));
check('category picker opened with options', !!opt);
opt.click(); await tick(50);
check('sheet returned to the budget form after pick', !!$('#bn-cat-pick'));
check('picked category shown on the form', $('#bn-cat-pick').textContent.includes('Gas'));

// amount + save
$('#b-new-amt').value = '120';
$('#b-new-amt').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
$('#b-new-save').click(); await tick(150);
const saved = state.budgets.find(b => b.category === 'Gas' && b.type === 'Expense');
check('budget saved', !!saved);
check('amount applied to all 12 months', !!saved && saved.amounts.jan === 120 && saved.amounts.dec === 120);

// switching type resets the category (lists differ per type)
$('#bn-type-pick').click(); await tick(50);
$$('.picker-option').find(o => o.textContent.includes('Income'))?.click(); await tick(50);
check('type switched', $('#bn-type-pick').textContent.includes('Income'));
check('category reset after type switch', $('#bn-cat-pick').textContent.includes('Tap to pick'));

// duplicate guard still works
$('#bn-type-pick').click(); await tick(50);
$$('.picker-option').find(o => o.textContent.trim().startsWith('Expense'))?.click(); await tick(50);
$('#bn-cat-pick').click(); await tick(50);
$$('.picker-option').find(o => o.textContent.includes('Gas'))?.click(); await tick(50);
$('#b-new-save').click(); await tick(100);
check('duplicate budget rejected', state.budgets.filter(b => b.category === 'Gas' && b.type === 'Expense').length === 1);

done('add-budget tests');
