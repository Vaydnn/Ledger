/* ============================================================
   insights.js — auto-detected observations about the current month.

   Produces up to ~3 insights, each {kind, title, detail, tone},
   chosen from a set of detectors:

   - outlierCategory   — spending in a category is unusually high or low
                         vs its 6-month median
   - streakPositive    — N consecutive months with positive net
   - monthVsAvg        — income or expense this month vs 6-month average
   - biggestCategory   — the largest expense category this month
   - dayOfMonthBurn    — spend pace vs calendar pace, for the current month
   - newCategory       — a category showing up this month that hasn't
                         appeared in recent months

   Tone: 'good' | 'warn' | 'neutral' — drives the card's color accent.
   ============================================================ */

import { monthAbbr, monthKey, monthName, fmt, fmtShort, toCents, fromCents, daysBetween, esc } from './util.js';
import { state, dataVersion } from './db.js';
import { monthTotals } from './effects.js';
import { computePace } from './pace.js';                    // NEW(v2.8)
import { detectRecurring } from './subscriptions.js';        // NEW(v2.8)
import { billAppliesToMonth, getBillAmount, getBillDueDay } from './bills.js'; // NEW(v2.8)

// Median of a numeric array
function med(arr){
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n-1)/2] : (s[n/2-1] + s[n/2]) / 2;
}
function mean(arr){
  if (!arr.length) return 0;
  return arr.reduce((a,b) => a+b, 0) / arr.length;
}

// Return an array of (year, monthIdx) covering the N months immediately
// before (year, monthIdx), newest-first.
function priorMonths(year, monthIdx, n){
  const out = [];
  let y = year, m = monthIdx - 1;
  for (let i = 0; i < n; i++){
    if (m < 1){ m = 12; y -= 1; }
    out.push({ year:y, month:m });
    m -= 1;
  }
  return out;
}

// Sum category spend in a (year, monthIdx) for a given txn type ('Expense' usually)
// FIX(v1.2): all sums in this module accumulate in cents.
function categorySpend(type, category, year, monthIdx){
  const ym = `${year}-${String(monthIdx).padStart(2,'0')}`;
  let sum = 0;
  for (const t of state.transactions){
    if (t.type !== type) continue;
    if (t.category !== category) continue;
    if (!t.date || monthKey(t.date) !== ym) continue;
    sum += toCents(t.amount);
  }
  return fromCents(sum);
}

// Per-category sum map for a specific type in a given month
function categoryMap(type, year, monthIdx){
  const ym = `${year}-${String(monthIdx).padStart(2,'0')}`;
  const out = {};
  for (const t of state.transactions){
    if (t.type !== type) continue;
    if (!t.date || monthKey(t.date) !== ym) continue;
    out[t.category || '(uncategorized)'] = (out[t.category || '(uncategorized)'] || 0) + toCents(t.amount);
  }
  for (const k of Object.keys(out)) out[k] = fromCents(out[k]);
  return out;
}

/* ─── Individual detectors ─────────────────────────── */

// Returns array of { category, current, median, ratio } for categories
// whose current-month spend is >150% or <50% of their 6-month median.
function detectOutlierCategories(year, monthIdx){
  const prior = priorMonths(year, monthIdx, 6);
  const currentMap = categoryMap('Expense', year, monthIdx);

  // FIX(v2.8): partial-month awareness. The old version compared a
  // PARTIAL live month against FULL-month medians — on day 8 everything
  // looked like "only 30% of typical" (noise) and genuine overspending
  // hid until late month. For the live month:
  //   - HIGH flags fire only when the partial spend ALREADY exceeds the
  //     full-month median × 1.2 — a certainty, not a projection.
  //   - LOW flags are suppressed until day 24 (before that, "low" just
  //     means "the month isn't over").
  // Closed months keep the original full-vs-full comparison.
  const now = new Date();
  const live = now.getFullYear() === year && now.getMonth() + 1 === monthIdx;
  const lateEnough = !live || now.getDate() >= 24;

  const out = [];
  for (const [cat, current] of Object.entries(currentMap)){
    const history = prior.map(p => categorySpend('Expense', cat, p.year, p.month));
    const nonZero = history.filter(v => v > 0);
    if (nonZero.length < 3) continue; // need enough history to judge
    const median = med(nonZero);
    if (median < 10) continue; // skip tiny categories — noise
    const ratio = current / median;
    if (live){
      if (ratio >= 1.2) out.push({ category:cat, current, median, ratio });
      else if (lateEnough && ratio > 0 && ratio <= 0.5) out.push({ category:cat, current, median, ratio });
    } else if (ratio >= 1.5 || (ratio > 0 && ratio <= 0.5)){
      out.push({ category:cat, current, median, ratio });
    }
  }
  // Biggest absolute $ delta first
  out.sort((a, b) => Math.abs(b.current - b.median) - Math.abs(a.current - a.median));
  return out;
}

/* ── NEW(v2.8) detectors ─────────────────────────────────────────── */

// Possible duplicate logs: same |amount| + account + type within ≤2 days
// in the viewed month, excluding bill-logged txns. Catches the double-log
// at insight time instead of a month later at reconcile time.
function detectDuplicateSuspects(year, monthIdx){
  const ym = `${year}-${String(monthIdx).padStart(2,'0')}`;
  const billIds = new Set();
  for (const b of state.bills) for (const id of Object.values(b.paidMonths || {})) billIds.add(id);
  // NEW(v2.9.2): dismissed pairs stay dismissed — a false positive (two real
  // identical charges) used to pin the top insight slot for the whole month.
  const dismissed = new Set(state.flags.dismissedDups || []);
  const rows = state.transactions
    .filter(t => t.date && t.date.slice(0,7) === ym && t.type === 'Expense' && !billIds.has(t.id) && t.amount >= 5)
    .sort((a,b) => a.date.localeCompare(b.date));
  const pairs = [];
  for (let i = 0; i < rows.length; i++){
    for (let j = i + 1; j < rows.length; j++){
      const a = rows[i], b = rows[j];
      if (toCents(a.amount) !== toCents(b.amount) || a.account !== b.account) continue;
      // FIX(v2.9.1): daysBetween (local-midnight parsing), not new Date() —
      // the rest of the app standardized on local dates for exactly this.
      const gap = Math.abs(daysBetween(a.date, b.date));
      if (gap > 2) continue;
      const key = [a.id, b.id].sort().join('|');
      if (dismissed.has(key)) continue;
      // identical descriptions on the SAME day are plausibly real (two coffees);
      // same amount 1-2 days apart with matching or empty descriptions is the
      // classic double-log signature
      pairs.push({ a, b, gap, key });
    }
  }
  return pairs;
}

// Recent subscription price changes (detected in subscriptions.js), scoped
// to ones whose latest charge is recent enough to matter.
function detectPriceChanges(){
  const cutoff = new Date(Date.now() - 45 * 86400000);
  return detectRecurring('Expense', 400)
    .filter(r => r.priceChange && r.last >= cutoff)
    .sort((a,b) => Math.abs(b.priceChange.to - b.priceChange.from) - Math.abs(a.priceChange.to - a.priceChange.from));
}

// Budgeted category already breached with the month still running.
function detectEarlyBudgetBreach(year, monthIdx){
  const now = new Date();
  if (now.getFullYear() !== year || now.getMonth() + 1 !== monthIdx) return [];
  const daysLeft = new Date(year, monthIdx, 0).getDate() - now.getDate();
  if (daysLeft < 5) return []; // late-month breaches are visible on the budget card anyway
  const mAbbr = monthAbbr[monthIdx-1];
  const spentMap = categoryMap('Expense', year, monthIdx);
  const out = [];
  for (const b of state.budgets){
    if (b.year !== year || b.type !== 'Expense') continue;
    const target = (b.amounts || {})[mAbbr] || 0;
    if (target <= 0) continue;
    const used = spentMap[b.category] || 0;
    if (used > target) out.push({ category: b.category, used, target, daysLeft });
  }
  out.sort((a,b) => (b.used - b.target) - (a.used - a.target));
  return out;
}

// Bills clustering in the next 7 days (live month) — a cash-timing heads-up.
function detectBillCluster(year, monthIdx){
  const now = new Date();
  if (now.getFullYear() !== year || now.getMonth() + 1 !== monthIdx) return null;
  const ym = `${year}-${String(monthIdx).padStart(2,'0')}`;
  const D = now.getDate();
  const due = state.bills.filter(b =>
    b.active !== false &&
    billAppliesToMonth(b, year, monthIdx) &&
    !(b.paidMonths || {})[ym] &&
    getBillDueDay(b) >= D && getBillDueDay(b) <= D + 7
  );
  if (due.length < 2) return null;
  let sum = 0;
  for (const b of due) sum += toCents(getBillAmount(b));
  sum = fromCents(sum);
  if (sum < 200) return null;
  return { count: due.length, sum };
}

// Largest single expense this month vs personal all-time distribution.
function detectBigTicket(year, monthIdx){
  const ym = `${year}-${String(monthIdx).padStart(2,'0')}`;
  const monthTxns = state.transactions.filter(t => t.type === 'Expense' && t.date && t.date.slice(0,7) === ym);
  if (!monthTxns.length) return null;
  const biggest = monthTxns.reduce((a,b) => b.amount > a.amount ? b : a);
  if (biggest.amount < 100) return null;
  const all = state.transactions.filter(t => t.type === 'Expense' && t.amount > 0).map(t => t.amount).sort((a,b) => a-b);
  if (all.length < 50) return null;
  const p95 = all[Math.floor(all.length * 0.95)];
  if (biggest.amount < p95) return null;
  return { txn: biggest };
}

// Consecutive months with positive net, looking back from (year, monthIdx)
function detectPositiveStreak(year, monthIdx){
  let streak = 0;
  let y = year, m = monthIdx;
  while (true){
    const t = monthTotals(y, m);
    if (t.net > 0) streak += 1;
    else break;
    m -= 1;
    if (m < 1){ m = 12; y -= 1; }
    if (streak > 24) break; // sanity cap
    // Stop if we go beyond any data we have
    const ym = `${y}-${String(m).padStart(2,'0')}`;
    const anyData = state.transactions.some(tt => tt.date.startsWith(ym));
    if (!anyData) break;
  }
  return streak;
}

// Compare current month's total (for a txn type) to the 6-month average.
// Returns {ratio, diff, current, avg} or null if insufficient history.
function compareToAvg(type, year, monthIdx){
  const prior = priorMonths(year, monthIdx, 6);
  const priorTotals = prior.map(p => {
    const ym = `${p.year}-${String(p.month).padStart(2,'0')}`;
    let sum = 0;
    for (const t of state.transactions){
      if (t.type !== type) continue;
      if (!t.date || monthKey(t.date) !== ym) continue;
      sum += toCents(t.amount);
    }
    return fromCents(sum);
  });
  const nonZero = priorTotals.filter(v => v > 0);
  if (nonZero.length < 3) return null;
  const avg = mean(nonZero);

  const currentYm = `${year}-${String(monthIdx).padStart(2,'0')}`;
  let current = 0;
  for (const t of state.transactions){
    if (t.type !== type) continue;
    if (!t.date || monthKey(t.date) !== currentYm) continue;
    current += toCents(t.amount);
  }
  current = fromCents(current);
  if (avg === 0 || current === 0) return null;
  return { current, avg, ratio: current / avg, diff: current - avg };
}

function detectBiggestCategory(year, monthIdx){
  const map = categoryMap('Expense', year, monthIdx);
  let best = null, max = 0;
  for (const [cat, amt] of Object.entries(map)){
    if (amt > max){ max = amt; best = cat; }
  }
  if (!best) return null;
  const total = Object.values(map).reduce((s,v) => s+v, 0);
  return { category:best, amount:max, shareOfExpenses: total > 0 ? max/total : 0 };
}

// Burn rate pacing — only meaningful for the currently-ongoing month.
// Compares actual expenses vs the pace expected based on days elapsed.
function detectBurnRate(year, monthIdx){
  const now = new Date();
  if (now.getFullYear() !== year || now.getMonth() + 1 !== monthIdx) return null;

  const ym = `${year}-${String(monthIdx).padStart(2,'0')}`;
  const expenses = fromCents(state.transactions
    .filter(t => t.type === 'Expense' && t.date && monthKey(t.date) === ym)
    .reduce((s,t) => s + toCents(t.amount), 0));
  if (expenses < 100) return null;

  const day = now.getDate();
  const daysInMonth = new Date(year, monthIdx, 0).getDate();

  // Project full-month spend based on daily rate
  const projected = (expenses / day) * daysInMonth;

  // Compare projected to 6-mo avg expense
  const avgCmp = compareToAvg('Expense', year, monthIdx);
  if (!avgCmp) return null;

  return { projected, elapsed:day, total:daysInMonth, avg:avgCmp.avg };
}

/* ─── Top-level aggregator ─────────────────────────── */

// Returns an ordered list of 0..N insight objects.
// Each insight: { kind, title, detail, tone: 'good'|'warn'|'neutral' }
// NEW(v2.9.1): memoized. The detectors below are dozens of full-history
// scans and this runs on every Home render (every save, tab return, and
// cross-tab sync). Results only change with the data or the calendar day.
let _insCache = null;
let _insKey = '';
export function detectInsights(year, monthIdx, max=3){
  // Cache key includes the dismissed-dup count: dismissing writes to meta
  // (unversioned by design), so it wouldn't bump dataVersion on its own.
  const key = `${dataVersion.n}|${year}-${monthIdx}|${max}|${(state.flags.dismissedDups || []).length}|${new Date().toDateString()}`;
  if (_insCache && _insKey === key) return _insCache;
  const all = [];

  // Streak: positive runs are a morale win
  const streak = detectPositiveStreak(year, monthIdx);
  if (streak >= 2){
    all.push({
      kind: 'streak',
      title: `${streak} month${streak===1?'':'s'} in the green`,
      detail: `Net has been positive ${streak} months running.`,
      tone: 'good',
      weight: streak >= 4 ? 95 : 70
    });
  }

  // Outlier categories — the most actionable insight
  const outliers = detectOutlierCategories(year, monthIdx);
  for (const o of outliers.slice(0, 2)){
    const pct = Math.round(o.ratio * 100);
    // FIX(v2.8): branch on which SIDE of typical we're on. The live-month
    // detector emits highs from 1.2× up; the old >=1.5 gate here dumped a
    // 1.2–1.5× high into the "low spend" branch ("only 144% of typical").
    if (o.ratio > 1){
      all.push({
        kind: 'outlier-high',
        title: `${esc(o.category)} is ${pct}% of your 6-mo median`,
        detail: `${fmt(o.current)} this month vs ${fmt(o.median)} typical.`,
        tone: 'warn',
        weight: 90 + Math.min(20, Math.round((o.ratio - 1) * 30))
      });
    } else {
      all.push({
        kind: 'outlier-low',
        title: `${esc(o.category)} is only ${pct}% of typical`,
        detail: `${fmt(o.current)} vs ${fmt(o.median)} typical — nice restraint.`,
        tone: 'good',
        weight: 55
      });
    }
  }

  // Month-vs-average for income
  const incCmp = compareToAvg('Income', year, monthIdx);
  if (incCmp && incCmp.ratio >= 1.2){
    all.push({
      kind: 'income-up',
      title: `Income is ${Math.round(incCmp.ratio * 100)}% of 6-mo avg`,
      detail: `${fmt(incCmp.current)} this month vs ${fmt(incCmp.avg)} typical.`,
      tone: 'good',
      weight: 75
    });
  } else if (incCmp && incCmp.ratio <= 0.7){
    all.push({
      kind: 'income-down',
      title: `Income down — ${Math.round(incCmp.ratio * 100)}% of avg`,
      detail: `${fmt(incCmp.current)} vs ${fmt(incCmp.avg)} typical.`,
      tone: 'warn',
      weight: 80
    });
  }

  // Burn rate — NEW(v2.8): runs on the pace engine (fixed/variable split,
  // recurring-income aware) instead of the naive linear projection, and
  // compares against the 6-mo average expense.
  const liveMonth = new Date().getFullYear() === year && new Date().getMonth() + 1 === monthIdx;
  if (liveMonth){
    const expCmp = compareToAvg('Expense', year, monthIdx);
    if (expCmp){
      const p = computePace();
      if (p.projSpend > expCmp.avg * 1.15){
        all.push({
          kind: 'burn',
          title: `On pace for ${fmtShort(p.projSpend)} in expenses`,
          detail: `${fmtShort(p.projSpend - expCmp.avg)} above your 6-mo average · ${fmtShort(p.fixedRemaining)} of it is known bills still to hit.`,
          tone: 'warn',
          weight: 85
        });
      } else if (p.projSpend > 0 && p.projSpend < expCmp.avg * 0.85){
        all.push({
          kind: 'burn-under',
          title: `On pace for ${fmtShort(p.projSpend)} — light month`,
          detail: `${fmtShort(expCmp.avg - p.projSpend)} below your 6-mo average if the pace holds.`,
          tone: 'good',
          weight: 65
        });
      }
    }
  }

  // NEW(v2.8): early budget breach — over budget with real month left
  for (const br of detectEarlyBudgetBreach(year, monthIdx).slice(0, 1)){
    all.push({
      kind: 'budget-breach',
      _category: br.category,
      title: `${esc(br.category)} already over budget`,
      detail: `${fmt(br.used)} spent vs ${fmt(br.target)} budgeted, with ${br.daysLeft} days left in the month.`,
      tone: 'warn',
      weight: 96
    });
  }

  // NEW(v2.8): possible duplicate logs — data integrity beats everything
  const dups = detectDuplicateSuspects(year, monthIdx);
  if (dups.length){
    const d = dups[0];
    all.push({
      kind: 'dup-suspect',
      _dismissKey: d.key, // NEW(v2.9.2): renders a × that remembers the pair
      title: `Possible duplicate: 2× ${fmt(d.a.amount)} on ${esc(d.a.account)}`,
      detail: `${d.a.date} and ${d.b.date}${d.a.description ? ' · ' + esc(String(d.a.description)) : ''} — same amount ${d.gap === 0 ? 'same day' : Math.round(d.gap) + 'd apart'}. Real, or logged twice?`,
      tone: 'warn',
      weight: 99
    });
  }

  // NEW(v2.8): subscription price changes with a recent charge
  const priceChanged = detectPriceChanges();
  for (const r of priceChanged.slice(0, 1)){
    const up = r.priceChange.to > r.priceChange.from;
    all.push({
      kind: 'price-change',
      _category: r.category,
      title: `${esc(r.category)} ${up ? 'went up' : 'went down'}: ${fmt(r.priceChange.from)} → ${fmt(r.priceChange.to)}`,
      detail: `${up ? '+' : '−'}${fmt(Math.abs(r.priceChange.to - r.priceChange.from))} per ${r.cadence.toLowerCase()} charge${up ? ' — worth a look.' : '.'}`,
      tone: up ? 'warn' : 'good',
      weight: 92
    });
  }

  // NEW(v2.8): bills clustering in the next 7 days
  const cluster = detectBillCluster(year, monthIdx);
  if (cluster){
    all.push({
      kind: 'bill-cluster',
      title: `${cluster.count} bills due in the next 7 days`,
      detail: `${fmt(cluster.sum)} total — make sure the cash side is ready.`,
      tone: 'neutral',
      weight: 72
    });
  }

  // NEW(v2.8): biggest single expense vs personal history
  const bigT = detectBigTicket(year, monthIdx);
  if (bigT){
    all.push({
      kind: 'big-ticket',
      title: `Top-5% expense: ${fmt(bigT.txn.amount)}`,
      detail: `${esc(bigT.txn.category || '')}${bigT.txn.description ? ' · ' + esc(String(bigT.txn.description)) : ''} on ${bigT.txn.date}.`,
      tone: 'neutral',
      weight: 50
    });
  }

  // Biggest category — always true but only surface if nothing else
  const big = detectBiggestCategory(year, monthIdx);
  if (big && big.amount > 50){
    all.push({
      kind: 'biggest',
      title: `Biggest category: ${esc(big.category)}`,
      detail: `${fmt(big.amount)} · ${Math.round(big.shareOfExpenses*100)}% of expenses`,
      tone: 'neutral',
      weight: 30
    });
  }

  /* ── NEW(v2.8): smarter ranking ──────────────────────────────────
     1. Causal suppression — a price-change insight EXPLAINS the same
        category's outlier-high; showing both wastes a slot saying one
        thing twice. The specific (causal) insight wins.
     2. Kind diversity — at most one insight per kind in the final cut,
        so three category outliers can't crowd out everything else. */
  const priceChangedCats = new Set(all.filter(i => i.kind === 'price-change').map(i => i._category));
  // budget-breach makes the same category's outlier-high redundant — the
  // breach is the more specific, more actionable version of the same fact.
  const breachedCats = new Set(all.filter(i => i.kind === 'budget-breach').map(i => i._category));
  const filtered = all.filter(i => {
    if (i.kind === 'outlier-high'){
      for (const cat of priceChangedCats) if (i.title.includes(esc(cat))) return false;
      for (const cat of breachedCats) if (i.title.includes(esc(cat))) return false;
    }
    return true;
  });
  filtered.sort((a,b) => b.weight - a.weight);
  const picked = [];
  const seenKinds = new Set();
  for (const i of filtered){
    if (seenKinds.has(i.kind)) continue;
    seenKinds.add(i.kind);
    picked.push(i);
    if (picked.length >= max) break;
  }
  _insCache = picked;
  _insKey = key;
  return picked;
}

/* ─── Home card renderer ─────────────────────────── */
export function renderInsightsCard(year, monthIdx){
  const insights = detectInsights(year, monthIdx, 3);
  if (insights.length === 0) return '';
  const toneDot = { good:'var(--green)', warn:'var(--amber)', neutral:'var(--text-3)' };
  return `
    <div class="card insights-card" style="margin-top:14px;">
      <h3 class="card-title">Insights <span class="pill">${monthName(monthIdx, true)}</span></h3>
      ${insights.map(i => `
        <div class="insight-row">
          <span class="insight-dot" style="background:${toneDot[i.tone]};"></span>
          <div class="insight-body">
            <div class="insight-title">${i.title}</div>
            <div class="insight-detail">${i.detail}</div>
          </div>
          ${i._dismissKey ? `<button class="ins-dismiss" type="button" data-key="${i._dismissKey}" aria-label="Dismiss" style="background:none;border:none;color:var(--text-3);font-size:17px;line-height:1;padding:2px 6px;cursor:pointer;flex-shrink:0;align-self:flex-start;">×</button>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}
