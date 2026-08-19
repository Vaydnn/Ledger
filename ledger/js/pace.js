/* ============================================================
   pace.js — NEW(v2.6): month-end pace projection.

   Answers "where does this month land?" mid-month, smarter than a
   naive (spent ÷ days × month) extrapolation, which is wrong in both
   directions: it double-projects fixed costs (rent hits day 1 and gets
   multiplied) and whipsaws early in the month.

   The model splits spending into FIXED and VARIABLE:

   FIXED  = bills (the bills store knows what's unpaid and due) plus
            detected recurring expenses (subscriptions.js cadence
            detection) whose next occurrence lands before month-end.
            These are added once, at face value — never extrapolated.

   VARIABLE = everything else (groceries, eating out, Steam…).
            Projected from a daily rate that BLENDS this month's actual
            rate with the median daily variable rate of the last three
            complete months. The blend weight slides with elapsed days
            (w = D/21, capped at 1): early in the month your history
            speaks, by week three your actuals do. Median over three
            months keeps one freak month from skewing the baseline.

   INCOME = actual so far + remaining occurrences of detected recurring
            income (e.g. bi-weekly salary) stepped through month-end.
            An expected payday that already slipped is NOT assumed.

   Everything sums in integer cents. Only computed for the live
   calendar month — past months are facts, not forecasts.
   ============================================================ */

import { monthAbbr, toCents, fromCents, round2, addDays, toLocalISO, parseLocalDate } from './util.js';
import { state, dataVersion } from './db.js';
import { monthTotals } from './effects.js';
import { detectRecurring } from './subscriptions.js';
import { billAppliesToMonth, getBillAmount, getBillDueDay } from './bills.js';

/* ── Income stream detection — amount-clustered, recency-scoped ──────
   Category-level cadence detection (subscriptions.js) fails on income
   regime changes: a "Salary" category holding old weekly intern checks
   AND new bi-weekly full-time checks has a garbage median. Real example
   from the live dataset: intern $126–170 weekly through May, then
   $2,119.04 bi-weekly after a promotion — category-level detection
   returned nothing.

   This detector clusters recent (≤130d) income by AMOUNT first (±12%
   bands), then checks each cluster's date gaps against known pay
   cadences (weekly / bi-weekly / semi-monthly / monthly). Two
   occurrences suffice — a new pay regime has only two data points in
   its first month, and that's exactly when projection matters most. */
function detectIncomeStreams(){
  const cutoff = addDays(new Date(), -130);
  const rows = state.transactions
    .filter(t => t.type === 'Income' && t.date && parseLocalDate(t.date) >= cutoff)
    .map(t => ({ d: parseLocalDate(t.date), amt: t.amount }))
    .sort((a,b) => a.d - b.d);

  const clusters = [];
  for (const r of rows){
    let c = clusters.find(c => Math.abs(r.amt - c.med) <= Math.max(5, c.med * 0.12));
    if (!c){ c = { amts:[], dates:[], med: r.amt }; clusters.push(c); }
    c.amts.push(r.amt); c.dates.push(r.d);
    c.med = med(c.amts);
  }

  const inBand = (g) => (g >= 6 && g <= 9) || (g >= 12 && g <= 18) || (g >= 27 && g <= 33);
  const streams = [];
  for (const c of clusters){
    if (c.dates.length < 2) continue;
    const gaps = [];
    for (let i = 0; i < c.dates.length - 1; i++) gaps.push(Math.round((c.dates[i+1] - c.dates[i]) / 86400000));
    const g = med(gaps);
    if (!inBand(g)) continue;
    // every gap must be roughly the stream's cadence — pure regularity check
    if (!gaps.every(x => Math.abs(x - g) <= 4)) continue;
    streams.push({ medAmt: c.med, gapDays: g, last: c.dates[c.dates.length - 1] });
  }
  return streams;
}

const med = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b) => a-b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
};

// NEW(v2.9.1): memoized — Home calls this (directly and via insights) on
// every render; it's several full-history scans. Only the data version and
// the calendar day can change the answer.
let _paceCache = null;
let _paceKey = '';
export function computePace(){
  const cacheKey = `${dataVersion.n}|${new Date().toDateString()}`;
  if (_paceCache && _paceKey === cacheKey) return _paceCache;

  const now = new Date();
  const year = now.getFullYear(), month = now.getMonth() + 1;
  const D = now.getDate();
  const N = new Date(year, month, 0).getDate();
  const ym = `${year}-${String(month).padStart(2,'0')}`;
  const monthEnd = new Date(year, month - 1, N);

  const tot = monthTotals(year, month);
  const spentSoFar = toCents(tot.exp);
  const incSoFar = toCents(tot.inc);

  /* ── fixed remaining: unpaid bills due from today onward ── */
  let fixedRemaining = 0;
  const billCategories = new Set();
  for (const b of state.bills){
    if (b.active === false) continue;
    if (!billAppliesToMonth(b, year, month)) continue;
    if (b.category) billCategories.add(b.category);
    const paid = !!(b.paidMonths || {})[ym];
    if (paid) continue;
    if (getBillDueDay(b) >= D) fixedRemaining += toCents(getBillAmount(b));
  }

  /* ── recurring expenses (subscriptions) ── */
  const recurring = detectRecurring('Expense', 400);
  const recurringCats = new Set(recurring.map(r => r.category));
  // remaining: next occurrence falls within (today, month-end], skipping
  // anything the bills store already covers (no double counting)
  for (const r of recurring){
    if (r.category && billCategories.has(r.category)) continue;
    let next = r.next;
    let guard = 0;
    while (next && next <= monthEnd && guard++ < 4){
      if (next > now) fixedRemaining += toCents(r.medAmt);
      next = addDays(next, r.canonDays);
    }
  }

  /* ── variable vs fixed split for a given month ──
     fixed-so-far = bill-logged txns (ids in paidMonths) + txns in
     recurring-detected categories. The rest is variable. */
  const billTxnIds = new Set();
  for (const b of state.bills){
    for (const id of Object.values(b.paidMonths || {})) billTxnIds.add(id);
  }
  const variableForMonth = (yy, mm) => {
    const key = `${yy}-${String(mm).padStart(2,'0')}`;
    let v = 0;
    for (const t of state.transactions){
      if (t.type !== 'Expense' || !t.date || t.date.slice(0,7) !== key) continue;
      if (billTxnIds.has(t.id)) continue;
      if (t.category && recurringCats.has(t.category)) continue;
      v += toCents(t.amount);
    }
    return v;
  };

  const variableSoFar = variableForMonth(year, month);

  // historical daily variable rate — last 3 complete months, median
  const histRates = [];
  for (let i = 1; i <= 3; i++){
    const d = new Date(year, month - 1 - i, 1);
    const yy = d.getFullYear(), mm = d.getMonth() + 1;
    const days = new Date(yy, mm, 0).getDate();
    const v = variableForMonth(yy, mm);
    if (v > 0) histRates.push(v / days);
  }
  const histDaily = med(histRates);
  const curDaily = D > 0 ? variableSoFar / D : 0;
  // blend: history early, actuals by week three
  const w = Math.min(1, D / 21);
  const blendedDaily = histDaily > 0 ? (w * curDaily + (1 - w) * histDaily) : curDaily;
  const projVariableRemaining = Math.round(blendedDaily * (N - D));

  const projSpend = spentSoFar + fixedRemaining + projVariableRemaining;

  /* ── income: remaining occurrences of detected streams ── */
  let incRemaining = 0;
  const incStreams = detectIncomeStreams();
  for (const s of incStreams){
    let next = addDays(s.last, s.gapDays);
    let guard = 0;
    while (next && next <= monthEnd && guard++ < 4){
      if (next > now) incRemaining += toCents(s.medAmt);
      next = addDays(next, s.gapDays);
    }
  }
  const projInc = incSoFar + incRemaining;

  /* ── budget comparison ── */
  let budgetTotal = 0;
  for (const b of state.budgets){
    if (b.year !== year || b.type !== 'Expense') continue;
    budgetTotal += toCents((b.amounts || {})[monthAbbr[month-1]] || 0);
  }

  const result = {
    year, month, D, N,
    spentSoFar: fromCents(spentSoFar),
    projSpend: fromCents(projSpend),
    incSoFar: fromCents(incSoFar),
    projInc: fromCents(projInc),
    projNet: fromCents(projInc - projSpend),
    fixedRemaining: fromCents(fixedRemaining),
    variableDaily: round2(fromCents(Math.round(blendedDaily))),
    budgetTotal: fromCents(budgetTotal),
    histMonths: histRates.length,
    incRecurringFound: incStreams.length > 0
  };
  _paceCache = result;
  _paceKey = cacheKey;
  return result;
}

/* ── Home card ─────────────────────────────────────────────── */
export function renderPaceCard(){
  const now = new Date();
  const { year, month } = state.selected;
  // pace is a forecast — only for the live month
  if (year !== now.getFullYear() || month !== now.getMonth() + 1) return '';
  if (!state.transactions.length) return '';

  const p = computePace();
  if (p.projSpend <= 0 && p.projInc <= 0) return '';

  const pctSpent = p.projSpend > 0 ? Math.min(1, p.spentSoFar / p.projSpend) : 0;
  const pctTime = p.D / p.N;
  const netPos = p.projNet >= 0;
  const fmtK = (v) => '$' + Math.round(v).toLocaleString();

  let budgetLine = '';
  if (p.budgetTotal > 0){
    const diff = round2(p.budgetTotal - p.projSpend);
    budgetLine = diff >= 0
      ? `<span style="color:var(--green);">on pace ${fmtK(diff)} under</span> the ${fmtK(p.budgetTotal)} budget`
      : `<span style="color:var(--red);">on pace ${fmtK(-diff)} over</span> the ${fmtK(p.budgetTotal)} budget`;
  }

  return `
    <div class="card" style="margin-top:14px;">
      <h3 class="card-title">Month-End Pace <span class="pill">day ${p.D} of ${p.N}</span></h3>
      <div class="pace-bar">
        <i style="width:${(pctSpent*100).toFixed(1)}%;"></i>
        <b style="left:${(pctTime*100).toFixed(1)}%;" title="today"></b>
      </div>
      <div class="pace-rows">
        <div class="pace-row"><span class="muted">Spending</span><span class="mono">${fmtK(p.spentSoFar)} → <b>${fmtK(p.projSpend)}</b></span></div>
        <div class="pace-row"><span class="muted">Income</span><span class="mono">${fmtK(p.incSoFar)} → <b>${fmtK(p.projInc)}</b></span></div>
        <div class="pace-row"><span class="muted">Projected net</span><span class="mono" style="color:${netPos ? 'var(--green)' : 'var(--red)'};">${netPos ? '+' : '−'}${fmtK(Math.abs(p.projNet))}</span></div>
      </div>
      ${budgetLine ? `<div class="muted small" style="margin-top:8px;">${budgetLine}</div>` : ''}
      <div class="muted small" style="margin-top:${budgetLine ? '4px' : '8px'};">
        ${fmtK(p.fixedRemaining)} in known bills &amp; recurring still to hit · variable ~${fmtK(p.variableDaily)}/day${p.histMonths ? ` (blended with ${p.histMonths}-mo habits)` : ''}${p.incRecurringFound ? '' : ' · no recurring income detected'}
      </div>
    </div>
  `;
}
