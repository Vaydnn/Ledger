/* ============================================================
   subscriptions.js — recurring-charge detector + sheet.

   v1.1.0 change: the detector is parameterized by transaction type,
   so the Forecast can reuse it for recurring Income (paychecks etc.)
   in addition to Expense detection.
   ============================================================ */

import { $, fmt, parseLocalDate, monthName, addDays, sumMoney, round2, esc } from './util.js';
import { state, dataVersion } from './db.js';
import { openSheet } from './sheet.js';

/* ── NEW(v2.9.1): memoized per data version + calendar day ────────────
   detectRecurring is a full-history scan and Home calls it (via pace +
   insights) on EVERY render — every save, tab return, and cross-tab sync
   re-ran it from scratch. Results only change when a transaction changes
   (dataVersion) or the date rolls over (ages/next-due shift), so cache on
   exactly those two things. */
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

function classifyCadence(mg){
  if (mg >= 25 && mg <= 35) return { label:'Monthly', canon:30 };
  if (mg >= 12 && mg <= 17) return { label:'Bi-weekly', canon:14 };
  if (mg >= 6  && mg <= 9)  return { label:'Weekly', canon:7 };
  if (mg >= 55 && mg <= 75) return { label:'Bi-monthly', canon:60 };
  if (mg >= 85 && mg <= 100) return { label:'Quarterly', canon:91 };
  if (mg >= 340 && mg <= 390) return { label:'Yearly', canon:365 };
  return null;
}

/**
 * detectRecurring — group transactions of `type` by category, surface
 * any group with regular cadence and consistent amounts.
 * Used by Subscriptions view (Expense) and the Forecast (Income + Expense).
 */
export function detectRecurring(type='Expense', cutoffDays=400){
  const stamp = recStamp();
  if (stamp !== _recStamp){ _recCache = new Map(); _recStamp = stamp; }
  const key = `${type}|${cutoffDays}`;
  if (_recCache.has(key)) return _recCache.get(key);

  const todayD = new Date();
  const groups = {};
  for (const t of state.transactions){
    if (t.type !== type) continue;
    const d = parseLocalDate(t.date);
    const age = Math.round((todayD - d) / 86400000);
    if (age > cutoffDays || age < 0) continue;
    const cat = t.category || '(uncategorized)';
    (groups[cat] = groups[cat] || []).push({
      date:d, amount:t.amount, description:t.description, account:t.account
    });
  }

  const results = [];
  for (const [cat, rows] of Object.entries(groups)){
    if (rows.length < 2) continue;
    rows.sort((a,b) => a.date - b.date);
    const dates = rows.map(r => r.date);
    const amts = rows.map(r => r.amount);
    const gaps = [];
    for (let i = 0; i < dates.length - 1; i++) gaps.push(Math.round((dates[i+1] - dates[i]) / 86400000));
    if (!gaps.length) continue;
    const medGap = med(gaps);
    const medAmt = med(amts);
    const cadence = classifyCadence(medGap);
    if (!cadence) continue;
    // Amount tolerance: >=60% of amounts within ±25% of median
    const tol = Math.max(1.0, medAmt * 0.25);
    const matches = amts.filter(a => Math.abs(a - medAmt) <= tol).length;
    if (matches / amts.length < 0.6) continue;
    // Gap regularity: stdev/medGap < 0.6
    if (gaps.length >= 2 && medGap > 0){
      const cv = stdev(gaps) / medGap;
      if (cv > 0.6) continue;
    }
    const last = dates[dates.length - 1];
    const lastGap = gaps[gaps.length - 1] || cadence.canon;
    const next = addDays(last, lastGap); // FIX(v1.2): DST-safe day stepping
    const monthlyEquiv = medAmt * (30 / cadence.canon);
    const yearStart = new Date(todayD.getFullYear(), 0, 1);
    const ytdSpend = sumMoney(rows.filter(r => r.date >= yearStart), r => r.amount); // FIX(v1.2): cents-safe
    // Most common account for this recurring group — useful for Forecast
    const acctCounts = {};
    rows.forEach(r => { if (r.account) acctCounts[r.account] = (acctCounts[r.account]||0) + 1; });
    let primaryAccount = null, maxA = 0;
    for (const [a, c] of Object.entries(acctCounts)){ if (c > maxA){ maxA = c; primaryAccount = a; } }
    // NEW(v2.6): price-change detection — compares the median of the two
    // most recent charges against the median of everything before. Catches
    // silent subscription creep (the thing manual logging hides best).
    let priceChange = null;
    if (amts.length >= 4){
      const priorList = amts.slice(0, -2);
      const prior = med(priorList);
      const recent = med(amts.slice(-2));
      // Only meaningful when the PRIOR series was stable — a true fixed
      // price. Variable categories (groceries, mixed "Subscriptions")
      // bouncing around their median are noise, not a price hike.
      const tight = priorList.filter(a => Math.abs(a - prior) <= Math.max(0.5, prior * 0.08)).length;
      // FIX(v2.8): the two recent charges must also agree with EACH OTHER —
      // otherwise one stray charge in a recurring category (a second service
      // signup, a partial month) reads as a fake "new price".
      const recentPair = amts.slice(-2);
      const recentConsistent = Math.abs(recentPair[0] - recentPair[1]) <= Math.max(0.5, recent * 0.05);
      if (prior > 0 && tight / priorList.length >= 0.8 && recentConsistent &&
          Math.abs(recent - prior) > Math.max(1, prior * 0.05)){
        priceChange = { from: Math.round(prior*100)/100, to: Math.round(recent*100)/100 };
      }
    }
    results.push({
      category: cat, type, count: rows.length, medAmt,
      cadence: cadence.label, canonDays: cadence.canon,
      monthlyEquiv, last, next, ytdSpend, primaryAccount, priceChange
    });
  }
  results.sort((a,b) => b.monthlyEquiv - a.monthlyEquiv);
  _recCache.set(key, results);
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
      Auto-detected from your last 13 months of expenses. Surfaces anything with regular cadence and consistent amounts.
    </div>
    <div class="sub-totals">
      <div class="sub-tile"><div class="l">Monthly</div><div class="v">${fmt(totalMonthly)}</div></div>
      <div class="sub-tile"><div class="l">Yearly</div><div class="v">${fmt(totalYearly)}</div></div>
      <div class="sub-tile"><div class="l">YTD spent</div><div class="v">${fmt(totalYtd)}</div></div>
    </div>
    ${subs.length === 0 ? `
      <div class="empty" style="padding:30px 10px;">
        <div class="big">No recurring detected.</div>
        Need at least 2 expenses in the same category with regular spacing.
      </div>
    ` : `
      <div style="margin-top:14px;">
        ${subs.map(s => {
          const status = dueStatus(s.next);
          const pct = totalMonthly > 0 ? (s.monthlyEquiv / totalMonthly * 100) : 0;
          return `
            <div class="sub-row">
              <div class="sub-head">
                <div class="sub-name">${esc(s.category)}${s.priceChange ? `<span class="sub-pricechange">${s.priceChange.to > s.priceChange.from ? '↑' : '↓'} $${s.priceChange.from.toFixed(2)} → $${s.priceChange.to.toFixed(2)}</span>` : ''}</div>
                <div class="sub-amt">${fmt(s.medAmt)}</div>
              </div>
              <div class="sub-meta">
                <span>${s.cadence}</span>
                <span>·</span>
                <span>${s.count} charge${s.count===1?'':'s'}</span>
                <span>·</span>
                <span>Last ${formatDate(s.last)}</span>
                <span>·</span>
                <span class="sub-next ${status.cls}">Next ${status.label}</span>
              </div>
              <div class="sub-bar"><i style="width:${pct}%;"></i></div>
              <div class="sub-foot">
                <span class="muted small">${fmt(s.monthlyEquiv)}/mo · ${fmt(s.ytdSpend)} YTD</span>
                <span class="muted small">${pct.toFixed(0)}% of total</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `}
    <div class="muted small" style="margin-top:14px;text-align:center;">
      Tip: if a real subscription isn't listed, you may need 1–2 more transactions logged in its category.
    </div>
  `;
  openSheet();
}
