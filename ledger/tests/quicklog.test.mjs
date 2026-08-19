import { bootEnv, makeChecker, tick } from './_env.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const $ = s => dom.window.document.querySelector(s);
const $$ = s => Array.from(dom.window.document.querySelectorAll(s));
const { state, dbPut, loadState } = await import('../js/db.js');
await import('../js/app.js'); await tick(200);

await dbPut('accounts', { id:'a1', name:'RH CC', type:'Credit Card', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'WF Checking', type:'Checking', active:true, order:1 });
await dbPut('categories', { id:'Expense', list:['Misc','Restaurants','Gas','Groceries'] });
await dbPut('categories', { id:'Income', list:['Salary','Cash Back'] });
const d = (off) => new Date(Date.now() - off*86400000).toISOString().slice(0,10);
// Restaurants 5x on RH CC (dominant), Gas 2x, Groceries 1x on WF
for (let i=0;i<5;i++) await dbPut('transactions', { id:'r'+i, date:d(i*5), type:'Expense', account:'RH CC', category:'Restaurants', amount:20, description:'' });
for (let i=0;i<2;i++) await dbPut('transactions', { id:'g'+i, date:d(i*9), type:'Expense', account:'RH CC', category:'Gas', amount:35, description:'' });
await dbPut('transactions', { id:'gr1', date:d(3), type:'Expense', account:'WF Checking', category:'Groceries', amount:50, description:'' });
await loadState();

const { navigate } = await import('../js/app.js');
navigate('home'); await tick();

// three type buttons
const btns = $$('.qa-btn');
check('three type buttons', btns.length === 3 && ['Expense','Income','Refund'].every(t => btns.some(b => b.dataset.type === t)));

// tap Expense → picker opens, usage-ranked
btns.find(b => b.dataset.type === 'Expense').click(); await tick();
check('picker sheet opened', $('#sheet').classList.contains('open'));
const opts = $$('.picker-option').map(o => o.textContent.trim().replace('✓',''));
check('Restaurants ranked first', opts[0] === 'Restaurants');
check('Gas ranked second', opts[1] === 'Gas');
check('configured-but-unused categories padded in', opts.includes('Misc'));

// pick Restaurants → Add prefilled with usual account, focus amount
$$('.picker-option').find(o => o.textContent.includes('Restaurants')).click(); await tick(100);
const { addForm } = await import('../js/add.js');
check('navigated to add', state.view === 'add');
check('type prefilled', addForm.type === 'Expense');
check('category prefilled', addForm.category === 'Restaurants');
check('usual account inferred (RH CC)', addForm.account === 'RH CC');
check('sheet closed after pick', !$('#sheet').classList.contains('open'));
check('amount focused', dom.window.document.activeElement?.id === 'f-amount');

// Income button with zero history for some cats: picker still works
navigate('home'); await tick();
$$('.qa-btn').find(b => b.dataset.type === 'Income').click(); await tick();
const incOpts = $$('.picker-option').map(o => o.textContent.trim());
check('income picker shows configured categories', incOpts.includes('Salary'));
done('quick-log tests');
