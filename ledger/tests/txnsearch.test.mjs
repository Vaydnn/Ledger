/* NEW(v2.10): Activity search must match a txn's fromAccount, not just its
   destination account — searching "Wells Fargo" should surface CC payments
   made FROM Wells Fargo Checking to some other card. */
import { bootEnv, makeChecker, tick } from './_env.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const $ = s => dom.window.document.querySelector(s);
const $$ = s => Array.from(dom.window.document.querySelectorAll(s));
const { state, dbPut, loadState } = await import('../js/db.js');
await import('../js/app.js'); await tick(200);

await dbPut('accounts', { id:'a1', name:'Wells Fargo Checking', type:'Checking', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'Chase Freedom', type:'Credit Card', active:true, order:1 });
await dbPut('categories', { id:'Expense', list:['Misc'] });
const today = new Date().toISOString().slice(0,10);

// destination match (already worked): expense ON the WF account
await dbPut('transactions', { id:'t1', date:today, type:'Expense', account:'Wells Fargo Checking', category:'Misc', amount:12, description:'coffee' });
// source match (the v2.10 fix): CC payment FROM WF to Chase
await dbPut('transactions', { id:'t2', date:today, type:'CC Payment', account:'Chase Freedom', fromAccount:'Wells Fargo Checking', category:null, amount:200, description:'' });
// control: unrelated txn, must NOT match
await dbPut('transactions', { id:'t3', date:today, type:'Expense', account:'Chase Freedom', category:'Misc', amount:8, description:'snack' });
await loadState();

const { navigate } = await import('../js/app.js');
navigate('txns'); await tick();

const search = $('#t-search');
check('search input renders', !!search);

// type "wells fargo" (case-insensitive) and let the 140ms debounce fire
search.value = 'wells fargo';
search.dispatchEvent(new dom.window.Event('input', { bubbles:true }));
await tick(300);

const shownIds = () => $$('.txn', $('#txn-results')).map(el => el.dataset.id);
let ids = shownIds();
check('destination-account txn matches', ids.includes('t1'));
check('fromAccount txn matches (CC payment from WF)', ids.includes('t2'));
check('unrelated txn excluded', !ids.includes('t3'));

// narrowing to the card name still works and includes the payment
search.value = 'chase';
search.dispatchEvent(new dom.window.Event('input', { bubbles:true }));
await tick(300);
ids = shownIds();
check('card-name search includes payment + expense, excludes WF-only txn',
  ids.includes('t2') && ids.includes('t3') && !ids.includes('t1'));

done('txn account search tests');
