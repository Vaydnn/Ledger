/* ============================================================
   effects.js — core financial math.
   txnEffects(): how a transaction shifts each account's stored balance.
   balanceAt(): balance through end of a given month.
   monthTotals(): headline income/exp/inv/refund/net for a month.

   FIX(v1.2): all aggregation now runs in integer cents and is rounded
   back to dollars at the boundary. Raw float accumulation over 1000+
   transactions produced drift (…000000005 tails) that could flip
   >=0 / <0 comparisons and compounded through the balance cascade.
   ============================================================ */

import { monthAbbr, toCents, fromCents } from './util.js';
import { state, dataVersion } from './db.js';

/* ── NEW(v2.5): version-keyed derived-math index ──────────────────────
   Every public function below used to scan all transactions per call —
   and Home alone calls balanceLatest once per account, monthTotals, the
   budget map, and getBillAmount per auto-cc bill, on every render. With
   1,000+ transactions that was thousands of redundant effect computations
   per interaction, growing linearly with history.

   One pass now builds, per data version:
     - aType:        account name → type
     - acctMonthNet: account → Map('YYYY-MM' → net effect, cents)
     - monthTotals:  'YYYY-MM' → {inc,exp,inv,ccPay,rfnd} (cents)
   All public functions become index lookups. The index rebuilds at most
   once per write (dataVersion bumps in db.js) and NEVER during pure
   renders — tab switching does zero transaction scans. */
let _idxV = -1;
let _idx = null;

function getIndex(){
  if (_idx && _idxV === dataVersion.n) return _idx;
  const aType = {};
  state.accounts.forEach(a => aType[a.name] = a.type);
  const acctMonthNet = {};   // account → { 'YYYY-MM': cents }
  const totals = {};         // 'YYYY-MM' → { inc, exp, inv, ccPay, rfnd }
  for (const t of state.transactions){
    if (!t.date) continue;
    const ym = t.date.slice(0, 7);
    const amt = toCents(t.amount);
    const tot = totals[ym] || (totals[ym] = { inc:0, exp:0, inv:0, ccPay:0, rfnd:0 });
    if (t.type === 'Income') tot.inc += amt;
    else if (t.type === 'Refund') tot.rfnd += amt;
    else if (t.type === 'Expense') tot.exp += amt;
    else if (t.type === 'Investment') tot.inv += amt;
    else if (t.type === 'CC Payment' || t.type === 'Loan Payment') tot.ccPay += amt;
    const eff = txnEffectsCents(t, aType);
    for (const acct in eff){
      const mm = acctMonthNet[acct] || (acctMonthNet[acct] = {});
      mm[ym] = (mm[ym] || 0) + eff[acct];
    }
  }
  _idx = { aType, acctMonthNet, totals };
  _idxV = dataVersion.n;
  return _idx;
}

// Maps "account name" → its type string, for fast lookup during effects computation.
export function acctTypeMap(){
  return getIndex().aType;
}

// Compute the deltas a transaction produces on stored balances, in CENTS.
// Convention:
//   Checking/Savings: +income, +refund, -expense, -investment, -transferOut, +transferIn, -ccPayment
//   Credit cards / Loans: +expense (debt up), -refund (debt down), -ccPayment (debt down),
//                         -balanceTransferOut, +balanceTransferIn
// FIX(v1.2): returns integer cents (txnEffectsCents); the dollar-returning
// txnEffects() wrapper is preserved so external callers keep their contract.
export function txnEffectsCents(t, acctType){
  const eff = {};
  const aT = acctType[t.account];
  const fT = acctType[t.fromAccount];
  const amt = toCents(t.amount);
  const isCash = (x) => x === 'Checking' || x === 'Savings';
  const isDebt = (x) => x === 'Credit Card' || x === 'Loan';
  if (t.type === 'Income'){
    if (isCash(aT)) eff[t.account] = (eff[t.account]||0) + amt;
    else if (isDebt(aT)) eff[t.account] = (eff[t.account]||0) - amt; // legacy: Income on card → reduces debt
  }
  else if (t.type === 'Refund'){
    if (isCash(aT)) eff[t.account] = (eff[t.account]||0) + amt;
    else if (isDebt(aT)) eff[t.account] = (eff[t.account]||0) - amt;
  }
  else if (t.type === 'Expense'){
    if (isCash(aT)) eff[t.account] = (eff[t.account]||0) - amt;
    else if (isDebt(aT)) eff[t.account] = (eff[t.account]||0) + amt;
  }
  else if (t.type === 'Investment'){
    if (isCash(aT)) eff[t.account] = (eff[t.account]||0) - amt;
  }
  else if (t.type === 'Transfer'){
    if (isCash(aT)) eff[t.account] = (eff[t.account]||0) + amt;
    if (isCash(fT)) eff[t.fromAccount] = (eff[t.fromAccount]||0) - amt;
  }
  else if (t.type === 'CC Payment' || t.type === 'Loan Payment'){
    if (isDebt(aT)) eff[t.account] = (eff[t.account]||0) - amt;
    if (isCash(fT)) eff[t.fromAccount] = (eff[t.fromAccount]||0) - amt;
  }
  else if (t.type === 'Balance Transfer'){
    if (isDebt(aT)) eff[t.account] = (eff[t.account]||0) + amt;
    if (isDebt(fT)) eff[t.fromAccount] = (eff[t.fromAccount]||0) - amt;
  }
  return eff;
}

// Back-compat wrapper: same shape as before, in dollars.
export function txnEffects(t, acctType){
  const cents = txnEffectsCents(t, acctType);
  const eff = {};
  for (const [k, v] of Object.entries(cents)) eff[k] = fromCents(v);
  return eff;
}

export function getStartingBalance(accountName, year, monthIdx){
  const rec = state.startingBalances.find(b => b.account === accountName && b.year === year);
  if (!rec) return 0;
  return rec[monthAbbr[monthIdx-1]] || 0;
}

// Balance at end of selected month (starting balance + all txn effects in that month)
// NEW(v2.5): O(1) index lookup.
export function balanceAt(accountName, year, monthIdx){
  const ym = `${year}-${String(monthIdx).padStart(2,'0')}`;
  const bal = toCents(getStartingBalance(accountName, year, monthIdx))
    + (getIndex().acctMonthNet[accountName]?.[ym] || 0);
  return fromCents(bal);
}

// Latest balance through the CURRENT calendar year.
// FIX(v1.2): previously summed the *selected* year, so an auto-cc bill's
// "live balance" (and the Forecast's starting cash) silently became last
// year's numbers whenever the user browsed a past year. "Live" now always
// means the actual current year.
export function balanceLatest(accountName){
  // NEW(v2.5): sums the per-month index entries from January of the current
  // year onward (including any future-dated months) — identical semantics to
  // the old full scan, at O(active months) instead of O(all transactions).
  const yr = new Date().getFullYear();
  let bal = toCents(getStartingBalance(accountName, yr, 1));
  const floor = `${yr}-01`;
  const mm = getIndex().acctMonthNet[accountName];
  if (mm) for (const ym in mm){ if (ym >= floor) bal += mm[ym]; }
  return fromCents(bal);
}

// Headline KPI totals for a single month — NEW(v2.5): O(1) index lookup.
export function monthTotals(year, monthIdx){
  const ym = `${year}-${String(monthIdx).padStart(2,'0')}`;
  const t = getIndex().totals[ym] || { inc:0, exp:0, inv:0, ccPay:0, rfnd:0 };
  // Net = money you have more of this month. Refunds add to net.
  return {
    inc: fromCents(t.inc), exp: fromCents(t.exp), inv: fromCents(t.inv),
    ccPay: fromCents(t.ccPay), rfnd: fromCents(t.rfnd),
    net: fromCents(t.inc + t.rfnd - t.exp - t.inv)
  };
}

// Net of all transactions affecting a given account in a specific month.
// Used by the Balances sheet (activity column) and the year-view heatmap.
// NEW(v2.5): O(1) index lookup — this is the cascade's inner loop, called
// 12× per affected account-year on every transaction save.
export function monthNetForAccount(accountName, year, monthIdx){
  const ym = `${year}-${String(monthIdx).padStart(2,'0')}`;
  return fromCents(getIndex().acctMonthNet[accountName]?.[ym] || 0);
}
