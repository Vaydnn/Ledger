import { bootEnv, makeChecker, tick } from './_env.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const $ = s => dom.window.document.querySelector(s);
const $$ = s => Array.from(dom.window.document.querySelectorAll(s));
const { state, dbPut, loadState, openDB } = await import('../js/db.js');
await import('../js/app.js'); await tick(150);

const now = new Date();
const Y = now.getFullYear(), M = now.getMonth()+1, D = now.getDate();
const ym = `${Y}-${String(M).padStart(2,'0')}`;
const mAbbrs = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const prevYM = (i) => { const d = new Date(Y, M-1-i, 15); return d.toISOString().slice(0,7); };

await dbPut('accounts', { id:'a1', name:'RH CC', type:'Credit Card', active:true, order:0 });
await dbPut('categories', { id:'Expense', list:['Restaurants','Streaming','Shopping'] });

const db = await openDB();
const put = (t) => new Promise(res => { const tx = db.transaction('transactions','readwrite'); tx.objectStore('transactions').put(t); tx.oncomplete = res; });
let id = 0; const T = (date, cat, amt, desc='') => put({ id:'x'+(id++), date, type:'Expense', account:'RH CC', category:cat, amount:amt, description:desc, updatedAt: Date.now() });

// 6 months history: Restaurants ~$100/mo; Streaming stable $15.99 then hikes to $22.99
for (let i = 1; i <= 6; i++){
  await T(prevYM(i)+'-10', 'Restaurants', 100);
  await T(prevYM(i)+'-05', 'Streaming', i <= 1 ? 22.99 : 15.99); // most recent prior month already hiked
}
// this month: Streaming hiked charge, duplicate suspect pair, small restaurants
await T(`${ym}-01`, 'Streaming', 22.99);
await T(`${ym}-02`, 'Restaurants', 30);
const d1 = `${ym}-${String(Math.max(1, D-2)).padStart(2,'0')}`;
const d2 = `${ym}-${String(Math.max(1, D-1)).padStart(2,'0')}`;
await T(d1, 'Shopping', 64.20, 'Amazon');
await T(d2, 'Shopping', 64.20, 'Amazon');
// budget breach: Shopping budgeted $50, spent $128.40, with days left (skip late-month)
const amounts = Object.fromEntries(mAbbrs.map(m => [m, 50]));
await dbPut('budgets', { id:'bb', year:Y, type:'Expense', category:'Shopping', amounts });
await loadState();

const ins = await import('../js/insights.js');
const list = ins.detectInsights(Y, M, 6);
console.log('insights:', list.map(i => `[${i.kind}] ${i.title}`));

check('duplicate suspect detected', list.some(i => i.kind === 'dup-suspect' && i.title.includes('64.2')));
const daysLeft = new Date(Y, M, 0).getDate() - D;
if (daysLeft >= 5) check('early budget breach detected', list.some(i => i.kind === 'budget-breach' && i.title.includes('Shopping')));
else check('breach suppressed late-month (by design)', !list.some(i => i.kind === 'budget-breach'));
check('price change surfaced', list.some(i => i.kind === 'price-change' && i.title.includes('Streaming')));
// causal suppression: Streaming outlier-high must NOT also appear
check('outlier suppressed when price-change explains it', !list.some(i => i.kind === 'outlier-high' && i.title.includes('Streaming')));
// partial-month: Restaurants at $30 of $100 median must NOT flag low before day 24
if (D < 24) check('no premature low-spend flag', !list.some(i => i.kind === 'outlier-low' && i.title.includes('Restaurants')));
else check('late-month low flag allowed', true);
// diversity: no kind repeats
const kinds = list.map(i => i.kind);
check('one insight per kind', new Set(kinds).size === kinds.length);
check('all insights well-formed', list.every(i => i.title && i.detail && ['good','warn','neutral'].includes(i.tone)));
done('insights tests');
