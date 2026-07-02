/* Indexed derived-math (effects.js) must match brute-force scans EXACTLY
   across the synthetic dataset, for every account × month, plus cache
   invalidation under the app's mutate-then-put convention. */
import { bootEnv, makeChecker, bulkInsert } from './_env.mjs';
import { ACCOUNTS, makeDataset } from './fixtures.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();

const { state, dbPut, loadState, openDB } = await import('../js/db.js');
for (const a of ACCOUNTS) await dbPut('accounts', a);
const txns = makeDataset();
await bulkInsert(openDB, 'transactions', txns);
await loadState();
console.log('fixture txns:', state.transactions.length);

const fx = await import('../js/effects.js');
const { toCents, fromCents } = await import('../js/util.js');

const refAType = () => { const m = {}; state.accounts.forEach(a => m[a.name] = a.type); return m; };
function refMonthNet(acct, y, mo){
  const aT = refAType();
  const s = `${y}-${String(mo).padStart(2,'0')}-01`;
  const e = mo === 12 ? `${y+1}-01-01` : `${y}-${String(mo+1).padStart(2,'0')}-01`;
  let d = 0;
  for (const t of state.transactions){
    if (!t.date || t.date < s || t.date >= e) continue;
    const f = fx.txnEffectsCents(t, aT);
    if (f[acct]) d += f[acct];
  }
  return fromCents(d);
}
function refLatest(acct){
  const aT = refAType(); const yr = new Date().getFullYear();
  let b = toCents(fx.getStartingBalance(acct, yr, 1));
  for (const t of state.transactions){
    if (!t.date || t.date < `${yr}-01-01`) continue;
    const f = fx.txnEffectsCents(t, aT);
    if (f[acct]) b += f[acct];
  }
  return fromCents(b);
}
function refTotals(y, mo){
  const ym = `${y}-${String(mo).padStart(2,'0')}`;
  let inc=0,exp=0,inv=0,cc=0,rf=0;
  for (const t of state.transactions){
    if (!t.date || t.date.slice(0,7) !== ym) continue;
    const a = toCents(t.amount);
    if (t.type==='Income') inc+=a; else if (t.type==='Refund') rf+=a; else if (t.type==='Expense') exp+=a;
    else if (t.type==='Investment') inv+=a; else if (t.type==='CC Payment'||t.type==='Loan Payment') cc+=a;
  }
  return { inc:fromCents(inc), exp:fromCents(exp), inv:fromCents(inv), ccPay:fromCents(cc), rfnd:fromCents(rf), net:fromCents(inc+rf-exp-inv) };
}

const now = new Date();
const years = [now.getFullYear()-1, now.getFullYear()];
for (const a of ACCOUNTS){
  check(`latest ${a.name}`, fx.balanceLatest(a.name) === refLatest(a.name));
  for (const y of years) for (let m=1; m<=12; m++)
    check(`net ${a.name} ${y}-${m}`, fx.monthNetForAccount(a.name,y,m) === refMonthNet(a.name,y,m));
}
for (const y of years) for (let m=1; m<=12; m++)
  check(`totals ${y}-${m}`, JSON.stringify(fx.monthTotals(y,m)) === JSON.stringify(refTotals(y,m)));

// invalidation under the app convention: mutate state + dbPut together
const ym = now.toISOString().slice(0,7);
const before = fx.monthTotals(now.getFullYear(), now.getMonth()+1).exp;
const nt = { id:'inv1', date:`${ym}-05`, type:'Expense', account:'Main CC', category:'Misc', amount:100, description:'inv' };
state.transactions.push(nt);
await dbPut('transactions', nt);
const after = fx.monthTotals(now.getFullYear(), now.getMonth()+1).exp;
check('cache invalidates on write', Math.abs(after - before - 100) < 0.001);

done('equivalence tests');
