/* ============================================================
   effects.js — core financial math.
   txnEffects(): how a transaction shifts each account's balance.
   balanceAt(): balance through end of a given month.
   monthTotals(): headline income/exp/inv/refund/net for a month.

   FIX(v1.2): all aggregation runs in integer cents and is rounded back to
   dollars at the boundary.

   NEW(v3.0): balances are DERIVED, never stored. Up to v2.10 every account
   had a per-year row of twelve stored month-start balances, kept in step by
   a "cascade" that re-ran after every edit. Keeping stored numbers in sync
   with the transactions needed fixes in v1.1.1, v1.1.4, v2.9.1 and v2.10.2
   (stale months, lost December→January carryover, dormant accounts reading
   $0). Now the only stored balance data is a short list of ANCHORS — "this
   account started month M with $X" (an account's opening balance, typed by
   the user) — and every balance is:

       latest anchor at or before the month  +  net of transactions since

   An account with no anchor simply opened at $0. With the per-month index
   below that's a binary search plus two prefix-sum lookups per query.
   ============================================================ */

import { monthAbbr, toCents, fromCents, ymOf, currentYm } from './util.js';
import { state, dataVersion } from './db.js';

/* ── Version-keyed derived-math index (v2.5, extended v3.0) ───────────
   One pass per data version builds:
     - aType:        account name → type
     - acctMonthNet: account → { 'YYYY-MM': net effect, cents }
     - totals:       'YYYY-MM' → { inc, exp, inv, ccPay, rfnd } (cents)
     - series:       account → { months: sorted 'YYYY-MM'[], prefix: cents[] }
                     prefix[i] = net of months[0..i-1]
     - anchors:      account → anchors sorted by month
   Rebuilt at most once per relevant write (dataVersion bumps in db.js) and
   never during pure renders. */
let _idxV = -1;
let _idx = null;

function getIndex(){
  if (_idx && _idxV === dataVersion.n) return _idx;
  const aType = {};
  state.accounts.forEach(a => aType[a.name] = a.type);
  const acctMonthNet = {};
  const totals = {};
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
  const series = {};
  for (const [acct, mm] of Object.entries(acctMonthNet)){
    const months = Object.keys(mm).sort();
    const prefix = [0];
    for (const m of months) prefix.push(prefix[prefix.length - 1] + mm[m]);
    series[acct] = { months, prefix };
  }
  const anchors = {};
  for (const a of state.balanceAnchors || []){
    if (!a.account || !a.month) continue;
    (anchors[a.account] || (anchors[a.account] = [])).push(a);
  }
  for (const list of Object.values(anchors)) list.sort((x, y) => x.month.localeCompare(y.month));
  _idx = { aType, acctMonthNet, totals, series, anchors };
  _idxV = dataVersion.n;
  return _idx;
}

// Maps "account name" → its type string, for fast lookup during effects computation.
export function acctTypeMap(){
  return getIndex().aType;
}

// Compute the deltas a transaction produces on balances, in CENTS.
// Convention:
//   Checking/Savings: +income, +refund, -expense, -investment, -transferOut, +transferIn, -ccPayment
//   Credit cards / Loans: +expense (debt up), -refund (debt down), -ccPayment (debt down),
//                         -balanceTransferOut, +balanceTransferIn
// A transaction naming an account that doesn't exist (deleted) has no effect
// on it — v3.0's Accounts sheet surfaces those as "missing accounts".
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

/* ── NEW(v3.0): derived balances ───────────────────────────────────── */
// Net of every month strictly before `ym` (cents).
function netBefore(acct, ym){
  const s = getIndex().series[acct];
  if (!s) return 0;
  let lo = 0, hi = s.months.length;          // first index with months[i] >= ym
  while (lo < hi){ const mid = (lo + hi) >> 1; if (s.months[mid] < ym) lo = mid + 1; else hi = mid; }
  return s.prefix[lo];
}

// The anchor in effect for a month: the latest one at or before it.
export function anchorFor(acct, ym){
  const list = getIndex().anchors[acct];
  if (!list) return null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].month <= ym) return list[i];
  return null;
}
// Anchor set exactly on this month (the Balances sheet shows these as pinned).
export function anchorAt(acct, ym){
  return (getIndex().anchors[acct] || []).find(a => a.month === ym) || null;
}

function startCents(acct, ym){
  const a = anchorFor(acct, ym);
  if (a) return toCents(a.amount) + netBefore(acct, ym) - netBefore(acct, a.month);
  return netBefore(acct, ym);
}

// Balance at the START of a month (what the Balances sheet calls "Starting").
export function getStartingBalance(accountName, year, monthIdx){
  return fromCents(startCents(accountName, ymOf(year, monthIdx)));
}

// Balance at end of a month (start + that month's activity).
export function balanceAt(accountName, year, monthIdx){
  const ym = ymOf(year, monthIdx);
  return fromCents(startCents(accountName, ym) + (getIndex().acctMonthNet[accountName]?.[ym] || 0));
}

// The account's balance including everything logged so far — future-dated
// transactions too (a bill scheduled for the 30th already counts), same
// semantics as v1.2–v2.10.
export function balanceLatest(accountName){
  const idx = getIndex();
  let last = currentYm();
  const s = idx.series[accountName];
  if (s && s.months.length && s.months[s.months.length - 1] > last) last = s.months[s.months.length - 1];
  const [y, m] = last.split('-').map(Number);
  return balanceAt(accountName, y, m);
}

// Headline KPI totals for a single month — O(1) index lookup.
export function monthTotals(year, monthIdx){
  const ym = ymOf(year, monthIdx);
  const t = getIndex().totals[ym] || { inc:0, exp:0, inv:0, ccPay:0, rfnd:0 };
  // Net = money you have more of this month. Refunds add to net.
  return {
    inc: fromCents(t.inc), exp: fromCents(t.exp), inv: fromCents(t.inv),
    ccPay: fromCents(t.ccPay), rfnd: fromCents(t.rfnd),
    net: fromCents(t.inc + t.rfnd - t.exp - t.inv)
  };
}

// Net of all transactions affecting a given account in a specific month.
export function monthNetForAccount(accountName, year, monthIdx){
  return fromCents(getIndex().acctMonthNet[accountName]?.[ymOf(year, monthIdx)] || 0);
}

// First month this account has any activity ('YYYY-MM' or null).
export function firstActivityMonth(accountName){
  const s = getIndex().series[accountName];
  return s && s.months.length ? s.months[0] : null;
}

/* ── NEW(v3.0): one-time migration helper ──────────────────────────────
   Given legacy per-year startingBalances rows, return the anchors that make
   the derived model reproduce them exactly. Walks each account month by
   month through every year that HAS a stored row; wherever the stored start
   differs from (derived start so far), an anchor is placed at that month
   with the stored value. On consistent data — every device that ran the
   cascade — that's just the true openings (e.g. a loan's starting balance).
   Years without a stored row are skipped (v2 read those as $0 starts, a
   display quirk, not user intent). Pure: reads the index, writes nothing. */
export function anchorsFromLegacy(legacyRows){
  const byAcct = {};
  for (const r of legacyRows || []){
    if (!r || !r.account || !r.year) continue;
    (byAcct[r.account] || (byAcct[r.account] = [])).push(r);
  }
  const out = [];
  for (const [acct, rows] of Object.entries(byAcct)){
    rows.sort((a, b) => a.year - b.year);
    const anchors = [];  // built incrementally, evaluated locally
    const derivedStart = (ym) => {
      let a = null;
      for (let i = anchors.length - 1; i >= 0; i--) if (anchors[i].month <= ym){ a = anchors[i]; break; }
      return a ? toCents(a.amount) + netBefore(acct, ym) - netBefore(acct, a.month) : netBefore(acct, ym);
    };
    for (const r of rows){
      for (let i = 0; i < 12; i++){
        const ym = ymOf(r.year, i + 1);
        const stored = toCents(r[monthAbbr[i]] || 0);
        if (stored !== derivedStart(ym)) anchors.push({ account: acct, month: ym, amount: fromCents(stored) });
      }
    }
    out.push(...anchors);
  }
  return out;
}
