/* ============================================================
   subscriptions.js — recurring-charge detector + sheet.

   v1.1.0: parameterized by transaction type, so the Forecast reuses it for
   recurring Income too.

   NEW(v3.0): MERCHANT-level detection first. Grouping only by category
   meant Netflix + Spotify + Hulu logged under one "Subscriptions" category
   looked like one noisy series (median gap ~10 days, mismatched amounts)
   and none of them was detected. Now transactions are grouped by merchant
   (the description, normalized) and each merchant's charges are tested on
   their own; whatever isn't claimed by a merchant series falls back to the
   old category grouping — which still covers entries logged without a
   description. Each series carries the ids of its transactions, so Pace can
   tell recurring spend from variable spend exactly.
   ============================================================ */

import { $, fmt, parseLocalDate, addDays, sumMoney, round2, esc, squash } from './util.js';
import { state, dataVersion } from './db.js';
import { openSheet } from './sheet.js';
import { merchantCore } from './merchants.js';

/* ── NEW(v2.9.1): memoized per data version + calendar day ──────────── */
let _recCache = new Map();
let _recStamp = '';
function recStamp(){ return `${dataVersion.n}|${new Date().toDateString()}`; }

// Median + stdev helpers used for amount consistency / gap regularity tests
const med = (arr) => {
  const s = [...arr].sort((a,b) => a-b);
  const n = s.length;
  return n % 2 ? s[(n-1)/2] : (s[n/2-1] + s[n/2]) / 2;
};
const stdev = (arr) => {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a,b)=>a+b,0) / arr.length;
  const v = arr.reduce((a,b) => a + (b-m)*(b-m), 0) / (arr.length - 1);
  return Math.sqrt(v);
};
const mostCommon = (vals) => {
  const c = {};
  for (const v of vals) if (v) c[v] = (c[v] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
};

/* NEW(v3.2): twice-a-month pay (the 10th and the 25th). A fixed 14/15-day
   step drifts off a semi-monthly paycheck by a few days every month, so the
   forecast and payday projection follow the days of the month instead.
   `dates` are Date objects; returns [lowDay, highDay] or null unless the last
   several months each show the same two paydays (±3 days, weekends shift). */
export function semiMonthlySlots(dates){
  const ds = [...dates].sort((a, b) => a - b).slice(-10);
  const byMonth = new Map();
  for (const d of ds){
    const k = d.getFullYear() * 12 + d.getMonth();
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(d.getDate());
  }
  const keys = [...byMonth.keys()].sort((a, b) => a - b);
  // Every month but the (possibly partial) first and last holds exactly two.
  if (keys.slice(1, -1).some(k => byMonth.get(k).length !== 2)) return null;
  const pairs = keys.map(k => byMonth.get(k)).filter(a => a.length === 2).map(a => [...a].sort((x, y) => x - y));
  if (pairs.length < 2) return null;
  const lo = Math.round(med(pairs.map(p => p[0])));
  const hi = Math.round(med(pairs.map(p => p[1])));
  if (hi - lo < 10 || hi - lo > 20) return null;
  if (pairs.some(p => Math.abs(p[0] - lo) > 3 || Math.abs(p[1] - hi) > 3)) return null;
  // A fixed 14-day step also lands twice a month, but its days slide a couple
  // of days every month — a real semi-monthly pay repeats the same days.
  const same = (i, v) => pairs.filter(p => p[i] === v).length / pairs.length;
  if (same(0, lo) < 0.6 || same(1, hi) < 0.6) return null;
  return [lo, hi];
}

function classifyCadence(mg){
  if (mg >= 25 && mg <= 35) return { label:'Monthly', canon:30 };
  if (mg >= 12 && mg <= 17) return { label:'Bi-weekly', canon:14 };
  if (mg >= 6  && mg <= 9)  return { label:'Weekly', canon:7 };
  if (mg >= 55 && mg <= 75) return { label:'Bi-monthly', canon:60 };
  if (mg >= 85 && mg <= 100) return { label:'Quarterly', canon:91 };
  if (mg >= 340 && mg <= 390) return { label:'Yearly', canon:365 };
  return null;
}

// Is this set of rows a regular series? Returns the series stats or null.
function analyzeSeries(rows, todayD){
  if (rows.length < 2) return null;
  rows.sort((a,b) => a.date - b.date);
  const dates = rows.map(r => r.date);
  const amts = rows.map(r => r.amount);
  const gaps = [];
  for (let i = 0; i < dates.length - 1; i++) gaps.push(Math.round((dates[i+1] - dates[i]) / 86400000));
  const medGap = med(gaps);
  const medAmt = med(amts);
  const cadence = classifyCadence(medGap);
  if (!cadence) return null;
  // Amount tolerance: >=60% of amounts within ±25% of median
  const tol = Math.max(1.0, medAmt * 0.25);
  const matches = amts.filter(a => Math.abs(a - medAmt) <= tol).length;
  if (matches / amts.length < 0.6) return null;
  // Gap regularity: stdev/medGap < 0.6
  if (gaps.length >= 2 && medGap > 0){
    const cv = stdev(gaps) / medGap;
    if (cv > 0.6) return null;
  }
  const last = dates[dates.length - 1];
  const lastGap = gaps[gaps.length - 1] || cadence.canon;
  const next = addDays(last, lastGap); // FIX(v1.2): DST-safe day stepping
  const monthlyEquiv = medAmt * (30 / cadence.canon);
  const yearStart = new Date(todayD.getFullYear(), 0, 1);
  const ytdSpend = sumMoney(rows.filter(r => r.date >= yearStart), r => r.amount);
  // NEW(v2.6): price-change detection — median of the two most recent
  // charges vs the prior series, only when the prior series was a stable
  // fixed price (≥80% within ±8%) and the two recent charges agree (v2.8).
  let priceChange = null;
  if (amts.length >= 4){
    const priorList = amts.slice(0, -2);
    const prior = med(priorList);
    const recent = med(amts.slice(-2));
    const tight = priorList.filter(a => Math.abs(a - prior) <= Math.max(0.5, prior * 0.08)).length;
    const recentPair = amts.slice(-2);
    const recentConsistent = Math.abs(recentPair[0] - recentPair[1]) <= Math.max(0.5, recent * 0.05);
    if (prior > 0 && tight / priorList.length >= 0.8 && recentConsistent &&
        Math.abs(recent - prior) > Math.max(1, prior * 0.05)){
      priceChange = { from: Math.round(prior*100)/100, to: Math.round(recent*100)/100 };
    }
  }
  return {
    count: rows.length, medAmt,
    cadence: cadence.label, canonDays: cadence.canon,
    monthlyEquiv, last, next, ytdSpend, priceChange,
    slots: cadence.canon === 14 ? semiMonthlySlots(dates) : null,    // NEW(v3.2)
    primaryAccount: mostCommon(rows.map(r => r.account)),
    txnIds: new Set(rows.map(r => r.id))
  };
}

/* NEW(v3.2): a recent regime. A new job — a different pay, a different
   rhythm — buries the new paychecks under a year of the old ones, so the
   whole series looks irregular and nothing is detected. Income only: try the
   newest 8 / 6 / 4 deposits, which must agree tightly on the amount and
   include something from the last 45 days. */
function recentRegime(rows, todayD){
  const sorted = [...rows].sort((a, b) => a.date - b.date);
  if (Math.round((todayD - sorted[sorted.length - 1].date) / 86400000) > 45) return null;
  for (const n of [8, 6, 4]){
    if (sorted.length <= n) continue;
    const win = sorted.slice(-n);
    const m = med(win.map(r => r.amount));
    if (win.filter(r => Math.abs(r.amount - m) <= Math.max(1, m * 0.1)).length / win.length < 0.8) continue;
    const s = analyzeSeries(win, todayD);
    if (s) return s;
  }
  return null;
}

/**
 * detectRecurring — surface regular, consistently-priced series of `type`
 * transactions. Each result: { key, label, category, type, count, medAmt,
 * cadence, canonDays, monthlyEquiv, last, next, ytdSpend, primaryAccount,
 * priceChange, txnIds }.
 * Used by the Subscriptions sheet, Forecast, Pace, and Insights.
 */
export function detectRecurring(type='Expense', cutoffDays=400){
  const stamp = recStamp();
  if (stamp !== _recStamp){ _recCache = new Map(); _recStamp = stamp; }
  const cacheKey = `${type}|${cutoffDays}`;
  if (_recCache.has(cacheKey)) return _recCache.get(cacheKey);

  const todayD = new Date();
  const items = [];
  for (const t of state.transactions){
    if (t.type !== type || !t.date) continue;
    const d = parseLocalDate(t.date);
    const age = Math.round((todayD - d) / 86400000);
    if (!(age <= cutoffDays && age >= 0)) continue;   // also drops unparseable dates
    items.push({ id:t.id, date:d, amount:t.amount, description:String(t.description ?? ''),
                 account:t.account, category:t.category || '(uncategorized)' });
  }

  const results = [];
  const claimed = new Set();

  // Pass 1 — merchants. A merchant needs 3+ charges, or exactly 2 at the
  // identical price (a brand-new subscription), so two random visits to the
  // same store a month apart don't read as a subscription.
  const byMerchant = {};
  for (const it of items){
    const key = squash(merchantCore(it.description));
    if (key.length < 3) continue;
    (byMerchant[key] || (byMerchant[key] = [])).push(it);
  }
  for (const [key, rows] of Object.entries(byMerchant)){
    if (rows.length < 2) continue;
    if (rows.length === 2 && Math.round(rows[0].amount * 100) !== Math.round(rows[1].amount * 100)) continue;
    const s = analyzeSeries(rows, todayD) || (type === 'Income' ? recentRegime(rows, todayD) : null);
    if (!s) continue;
    rows.forEach(r => claimed.add(r.id));
    results.push({
      key: 'm:' + key, type,
      label: mostCommon(rows.map(r => merchantCore(r.description))) || key,
      category: mostCommon(rows.map(r => r.category)),
      ...s
    });
  }

  // Pass 2 — categories, from whatever no merchant series claimed.
  const byCat = {};
  for (const it of items){
    if (claimed.has(it.id)) continue;
    (byCat[it.category] || (byCat[it.category] = [])).push(it);
  }
  for (const [cat, rows] of Object.entries(byCat)){
    const s = analyzeSeries(rows, todayD) || (type === 'Income' ? recentRegime(rows, todayD) : null);
    if (!s) continue;
    results.push({ key: 'c:' + cat, type, label: cat, category: cat, ...s });
  }

  results.sort((a,b) => b.monthlyEquiv - a.monthlyEquiv);
  _recCache.set(cacheKey, results);
  return results;
}

/* ─── Subscriptions sheet (Expense-only view) ─────────────────────── */
export function openSubscriptionsSheet(){
  const subs = detectRecurring('Expense');
  const totalMonthly = round2(subs.reduce((s,r) => s + r.monthlyEquiv, 0));
  const totalYearly = round2(totalMonthly * 12);
  const totalYtd = sumMoney(subs, r => r.ytdSpend);
  const todayD = new Date();
  const formatDate = (d) => `${d.getMonth()+1}/${d.getDate()}`;
  const dueStatus = (d) => {
    const days = Math.round((d - todayD) / 86400000);
    if (days < 0) return { cls:'overdue', label:`${-days}d ago` };
    if (days === 0) return { cls:'today', label:'Today' };
    if (days <= 3) return { cls:'soon', label:`in ${days}d` };
    if (days <= 14) return { cls:'future', label:`in ${days}d` };
    return { cls:'future', label:formatDate(d) };
  };

  $('#sheetBody').innerHTML = `
    <h2>Subscriptions & Recurring</h2>
    <div class="muted small" style="margin-bottom:14px;">
      Auto-detected from your last 13 months of expenses — by merchant where you've named it, by category otherwise. Surfaces anything with regular cadence and consistent amounts.
    </div>
    <div class="sub-totals">
      <div class="sub-tile"><div class="l">Monthly</div><div class="v">${fmt(totalMonthly)}</div></div>
      <div class="sub-tile"><div class="l">Yearly</div><div class="v">${fmt(totalYearly)}</div></div>
      <div class="sub-tile"><div class="l">YTD spent</div><div class="v">${fmt(totalYtd)}</div></div>
    </div>
    ${subs.length === 0 ? `
      <div class="empty" style="padding:30px 10px;">
        <div class="big">No recurring detected.</div>
        Needs a few charges from the same merchant (or category) with regular spacing.
      </div>
    ` : `
      <div style="margin-top:14px;">
        ${subs.map(s => {
          const status = dueStatus(s.next);
          const pct = totalMonthly > 0 ? (s.monthlyEquiv / totalMonthly * 100) : 0;
          return `
            <div class="sub-row">
              <div class="sub-head">
                <div class="sub-name">${esc(s.label)}${s.priceChange ? `<span class="sub-pricechange">${s.priceChange.to > s.priceChange.from ? '↑' : '↓'} $${s.priceChange.from.toFixed(2)} → $${s.priceChange.to.toFixed(2)}</span>` : ''}</div>
                <div class="sub-amt">${fmt(s.medAmt)}</div>
              </div>
              <div class="sub-meta">
                <span>${s.cadence}</span>
                ${s.label !== s.category ? `<span>·</span><span>${esc(s.category)}</span>` : ''}
                <span>·</span>
                <span>${s.count} charge${s.count===1?'':'s'}</span>
                <span>·</span>
                <span>Last ${formatDate(s.last)}</span>
                <span>·</span>
                <span class="sub-next ${status.cls}">Next ${status.label}</span>
              </div>
              <div class="sub-bar"><i style="width:${pct}%;"></i></div>
              <div class="sub-foot">
                <span class="muted small">${fmt(s.monthlyEquiv)}/mo · ${fmt(s.ytdSpend)} YTD${s.primaryAccount ? ' · ' + esc(s.primaryAccount) : ''}</span>
                <span class="muted small">${pct.toFixed(0)}% of total</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `}
    <div class="muted small" style="margin-top:14px;text-align:center;">
      Tip: give subscriptions a description (e.g. "Netflix") so each is tracked on its own.
    </div>
  `;
  openSheet();
}
