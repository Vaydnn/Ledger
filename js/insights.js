/* ============================================================
   insights.js — what's worth a look right now.

   v3.2 rewrite. The old card filled itself with things that are always true
   ("5 months in the green", "Biggest category: Groceries", "on pace for…" —
   the Pace card already says that), so it read the same every day. Now an
   insight has to be NEW or ACTIONABLE, and the card disappears when there
   is nothing to say:

   - dup-suspect     possible double-logged transaction
   - budget-breach   a category over budget with real month left
   - price-change    a subscription changed price
   - outlier-high/low  a category far from its 6-month median — now naming
                       the merchant behind it
   - income-down     income well below average
   - bill-cluster    several bills in the next 7 days
   - big-ticket      a top-5% expense
   - NEW cash-tight        the next pay run (or payday) leaves you short
   - NEW stmt-gap          the statement balance you entered doesn't match what
                           Ledger computes — something is missing or doubled
   - NEW stmt-due          a card's statement is due within a week (or past due)
   - NEW variable-bill     a variable bill came in well off its average
   - NEW week              the last 7 days vs a typical week

   Every insight can be dismissed (×) — it stays gone until its subject
   changes (the dismissal is keyed to the month, merchant, statement…). Rows
   open the thing they're about. Tone: 'good' | 'warn' | 'neutral'.
   ============================================================ */

import { monthKey, monthName, fmt, fmtShort, toCents, fromCents, daysBetween, esc, today, addDays, toLocalISO, parseLocalDate } from './util.js';
import { state, dataVersion } from './db.js';
import { monthTotals } from './effects.js';
import { detectRecurring } from './subscriptions.js';        // NEW(v2.8)
import { billAppliesToMonth, getBillAmount, getBillDueDay, isBillPaid, isVariableBill, billActual, billHistory } from './bills.js'; // NEW(v2.8)
import { statementInfo, cardCycle } from './statement.js';   // NEW(v3.2)
import { nextMonthPlan } from './nextmonth.js';              // NEW(v3.2)
import { merchantCore } from './merchants.js';               // NEW(v3.2)
import { budgetSpentMap, budgetMonth } from './budgets.js'; // NEW(v3.0), v3.1

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
  const spentMap = budgetSpentMap(year, monthIdx); // FIX(v3.0): refunds net back in, same as the budget card
  const cache = { [monthIdx]: spentMap };
  const out = [];
  for (const b of state.budgets){
    if (b.year !== year || b.type !== 'Expense') continue;
    const target = budgetMonth(b, monthIdx, cache).target;   // v3.1: includes rollover
    if (target <= 0) continue;
    const used = spentMap[`Expense|${b.category}`] || 0;
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
    !isBillPaid(b, ym) &&
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

/* ── NEW(v3.2) detectors ─────────────────────────────────────────── */

// Who is behind a category's month: its top merchant, when one stands out.
function topMerchant(category, year, monthIdx){
  const ym = `${year}-${String(monthIdx).padStart(2,'0')}`;
  const by = {};
  let total = 0;
  for (const t of state.transactions){
    if (t.type !== 'Expense' || t.category !== category || !t.date || monthKey(t.date) !== ym) continue;
    const name = merchantCore(String(t.description ?? '')) || String(t.description ?? '').trim();
    total += toCents(t.amount);
    if (!name) continue;
    const g = by[name] || (by[name] = { name, c: 0, n: 0 });
    g.c += toCents(t.amount); g.n++;
  }
  const best = Object.values(by).sort((a, b) => b.c - a.c)[0];
  if (!best || best.c < total * 0.4) return null;
  return { name: best.name, amount: fromCents(best.c), count: best.n };
}

// The cash side: does the next pay run (or payday) leave you short?
function detectCashTight(year, monthIdx){
  const now = new Date();
  if (now.getFullYear() !== year || now.getMonth() + 1 !== monthIdx) return null;
  let p;
  try { p = nextMonthPlan(); } catch (e){ return null; }
  if (!p || !p.run) return null;
  if (p.low.amount >= 200) return null;
  return { amount: p.low.amount, date: p.low.date, run: p.run };
}

// Cards whose entered statement balance disagrees with what Ledger computes.
function detectStatementGaps(){
  const out = [];
  for (const a of state.accounts){
    if (!a.active || a.type !== 'Credit Card' || !cardCycle(a.name)) continue;
    const s = statementInfo(a.name);
    if (!s || !s.entered) continue;
    const gap = s.statement - s.computed;
    if (Math.abs(gap) >= 5) out.push({ card: a.name, s, gap });
  }
  return out.sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap));
}

// Statements still unpaid and due within a week (or past due). A card an
// Auto (CC) bill already tracks gets its reminders from the bill.
function detectStatementsDue(){
  const t = today();
  const out = [];
  for (const a of state.accounts){
    if (!a.active || a.type !== 'Credit Card' || !cardCycle(a.name)) continue;
    if (state.bills.some(b => b.recurrence === 'auto-cc' && b.active !== false && b.linkedAccount === a.name)) continue;
    const s = statementInfo(a.name);
    if (!s || s.remaining < 1) continue;
    const days = daysBetween(t, s.dueIso);
    if (days <= 7) out.push({ card: a.name, s, days });
  }
  return out.sort((x, y) => x.days - y.days);
}

// Variable bills that landed well off their recent average this month.
function detectVariableBills(year, monthIdx){
  const ym = `${year}-${String(monthIdx).padStart(2,'0')}`;
  const out = [];
  for (const b of state.bills){
    if (!isVariableBill(b) || b.active === false) continue;
    const actual = billActual(b, ym);
    if (actual == null) continue;
    const prior = billHistory(b).filter(([k]) => k < ym).slice(-3);
    if (prior.length < 2) continue;
    const avg = mean(prior.map(([, a]) => a));
    const diff = actual - avg;
    if (Math.abs(diff) < Math.max(10, avg * 0.08)) continue;
    out.push({ bill: b, actual, avg, diff });
  }
  return out.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
}

// The last 7 days of spending vs a typical week (the median of the 8 before).
function detectWeek(year, monthIdx){
  const now = new Date();
  if (now.getFullYear() !== year || now.getMonth() + 1 !== monthIdx) return null;
  const end = today();
  const sumRange = (fromIso, toIso) => fromCents(state.transactions
    .filter(t => t.type === 'Expense' && t.date && t.date >= fromIso && t.date <= toIso)
    .reduce((s, t) => s + toCents(t.amount), 0));
  const d = parseLocalDate(end);
  const week = sumRange(toLocalISO(addDays(d, -6)), end);
  const prior = [];
  for (let i = 1; i <= 8; i++) prior.push(sumRange(toLocalISO(addDays(d, -6 - 7 * i)), toLocalISO(addDays(d, -7 * i))));
  const nonZero = prior.filter(v => v > 0);
  if (nonZero.length < 6) return null;
  const typical = med(nonZero);
  if (typical < 50) return null;
  const diff = week - typical;
  if (Math.abs(diff) < 75) return null;
  const ratio = week / typical;
  if (ratio >= 1.4 || ratio <= 0.6) return { week, typical, ratio, diff, end };
  return null;
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
  const key = `${dataVersion.n}|${year}-${monthIdx}|${max}|${(state.flags.dismissedDups || []).length}|${Object.keys(state.flags.insightDismissed || {}).length}|${new Date().toDateString()}`;
  if (_insCache && _insKey === key) return _insCache;
  const all = [];

  // Outlier categories — the most actionable insight
  const outliers = detectOutlierCategories(year, monthIdx);
  for (const o of outliers.slice(0, 2)){
    const pct = Math.round(o.ratio * 100);
    // FIX(v2.8): branch on which SIDE of typical we're on. The live-month
    // detector emits highs from 1.2× up; the old >=1.5 gate here dumped a
    // 1.2–1.5× high into the "low spend" branch ("only 144% of typical").
    if (o.ratio > 1){
      const who = topMerchant(o.category, year, monthIdx);
      all.push({
        kind: 'outlier-high',
        _category: o.category,
        _key: `out:${year}-${monthIdx}:${o.category}`,
        _act: ['category', o.category],
        title: `${esc(o.category)} is ${pct}% of your 6-mo median`,
        detail: `${fmt(o.current)} this month vs ${fmt(o.median)} typical.${who ? ` Mostly ${esc(who.name)}: ${fmt(who.amount)}${who.count > 1 ? ` over ${who.count} charges` : ''}.` : ''}`,
        tone: 'warn',
        weight: 90 + Math.min(20, Math.round((o.ratio - 1) * 30))
      });
    } else {
      all.push({
        kind: 'outlier-low',
        _key: `low:${year}-${monthIdx}:${o.category}`,
        _act: ['category', o.category],
        title: `${esc(o.category)} is only ${pct}% of typical`,
        detail: `${fmt(o.current)} vs ${fmt(o.median)} typical — nice restraint.`,
        tone: 'good',
        weight: 55
      });
    }
  }

  // Month-vs-average for income (only the worrying direction — a good month needs no card)
  const incCmp = compareToAvg('Income', year, monthIdx);
  if (incCmp && incCmp.ratio <= 0.7){
    all.push({
      kind: 'income-down',
      _key: `inc:${year}-${monthIdx}`,
      title: `Income down — ${Math.round(incCmp.ratio * 100)}% of avg`,
      detail: `${fmt(incCmp.current)} vs ${fmt(incCmp.avg)} typical.`,
      tone: 'warn',
      weight: 80
    });
  }

  // NEW(v2.8): early budget breach — over budget with real month left
  for (const br of detectEarlyBudgetBreach(year, monthIdx).slice(0, 1)){
    all.push({
      kind: 'budget-breach',
      _category: br.category,
      _key: `bud:${year}-${monthIdx}:${br.category}`,
      _act: ['budgets'],
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
      _dismissKey: d.key,
      _act: ['txn', d.b.id], // NEW(v2.9.2): renders a × that remembers the pair
      title: `Possible duplicate: 2× ${fmt(d.a.amount)} on ${esc(d.a.account)}`,
      detail: `${esc(d.a.date)} and ${esc(d.b.date)}${d.a.description ? ' · ' + esc(String(d.a.description)) : ''} — same amount ${d.gap === 0 ? 'same day' : Math.round(d.gap) + 'd apart'}. Real, or logged twice?`,
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
      _key: `price:${r.label}:${r.priceChange.to}`,
      _act: ['subs'],
      title: `${esc(r.label)} ${up ? 'went up' : 'went down'}: ${fmt(r.priceChange.from)} → ${fmt(r.priceChange.to)}`,
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
      _key: `cluster:${today()}`,
      _act: ['bills'],
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
      _key: `big:${bigT.txn.id}`,
      _act: ['txn', bigT.txn.id],
      title: `Top-5% expense: ${fmt(bigT.txn.amount)}`,
      detail: `${esc(bigT.txn.category || '')}${bigT.txn.description ? ' · ' + esc(String(bigT.txn.description)) : ''} on ${esc(bigT.txn.date)}.`,
      tone: 'neutral',
      weight: 50
    });
  }

  // NEW(v3.2): the cash side — the next pay run leaves you short
  const tight = detectCashTight(year, monthIdx);
  if (tight){
    const neg = tight.amount < 0;
    all.push({
      kind: 'cash-tight',
      _key: `dip:${toLocalISO(tight.run)}`,
      _act: ['nextmonth'],
      title: neg ? `Cash runs ${fmtShort(-tight.amount)} short around ${monthName(tight.date.getMonth() + 1, true)} ${tight.date.getDate()}` : `Cash gets tight: ${fmtShort(tight.amount)} left around ${monthName(tight.date.getMonth() + 1, true)} ${tight.date.getDate()}`,
      detail: `After the ${monthName(tight.run.getMonth() + 1, true)} ${tight.run.getDate()} pay run, until the next paycheck lands. Open Next month to see what's in it.`,
      tone: 'warn',
      weight: neg ? 98 : 94
    });
  }

  // NEW(v3.2): a statement balance you entered that Ledger can't reproduce
  if (new Date().getFullYear() === year && new Date().getMonth() + 1 === monthIdx){
    for (const g of detectStatementGaps().slice(0, 1)){
      all.push({
        kind: 'stmt-gap',
        _key: `gap:${g.card}:${g.s.closeIso}:${Math.round(g.gap)}`,
        _act: ['card', g.card],
        title: `${esc(g.card)}: your bank says ${fmt(g.s.statement)}, Ledger has ${fmt(g.s.computed)}`,
        detail: g.gap > 0 ? `${fmt(g.gap)} missing — an unlogged charge, or a posting-date difference?` : `${fmt(-g.gap)} extra in Ledger — a duplicate or a charge your bank hasn't posted?`,
        tone: 'warn',
        weight: 93
      });
    }
    for (const d of detectStatementsDue().slice(0, 1)){
      all.push({
        kind: 'stmt-due',
        _key: `due:${d.card}:${d.s.closeIso}`,
        _act: ['card', d.card],
        title: d.days < 0 ? `${esc(d.card)} statement is ${-d.days}d past due` : d.days === 0 ? `${esc(d.card)} statement is due today` : `${esc(d.card)} statement due in ${d.days}d`,
        detail: `${fmt(d.s.remaining)} still due of the ${fmt(d.s.statement)} statement that closed ${monthName(Number(d.s.closeIso.slice(5, 7)), true)} ${Number(d.s.closeIso.slice(8))}.`,
        tone: d.days <= 3 ? 'warn' : 'neutral',
        weight: d.days <= 3 ? 91 : 78
      });
    }
  }

  // NEW(v3.2): a variable bill that came in off its average
  for (const v of detectVariableBills(year, monthIdx).slice(0, 1)){
    const up = v.diff > 0;
    all.push({
      kind: 'variable-bill',
      _key: `var:${v.bill.id}:${year}-${monthIdx}:${Math.round(v.actual)}`,
      _act: ['bills'],
      title: `${esc(v.bill.name)} came in ${fmt(v.actual)} — ${fmt(Math.abs(v.diff))} ${up ? 'above' : 'below'} its average`,
      detail: `Your last bills averaged ${fmt(v.avg)}.`,
      tone: up ? 'warn' : 'good',
      weight: 88
    });
  }

  // NEW(v3.2): the last 7 days against a typical week
  const wk = detectWeek(year, monthIdx);
  if (wk){
    const up = wk.diff > 0;
    all.push({
      kind: 'week',
      _key: `week:${wk.end}`,
      _act: ['activity'],
      title: up ? `${fmtShort(wk.week)} spent in the last 7 days — ${wk.ratio.toFixed(1)}× a typical week` : `Quiet week: ${fmtShort(wk.week)} in 7 days vs ${fmtShort(wk.typical)} typical`,
      detail: up ? `${fmtShort(wk.diff)} above your usual ${fmtShort(wk.typical)}.` : `${fmtShort(-wk.diff)} under your usual week.`,
      tone: up ? 'warn' : 'good',
      weight: up ? 80 : 56
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
  const dismissed = state.flags.insightDismissed || {};
  const filtered = all.filter(i => {
    if (i._key && dismissed[i._key]) return false;     // NEW(v3.2): × — stays gone until the subject changes
    // FIX(v3.0): compare categories directly (a substring match on the
    // title also suppressed "Gas" whenever "Gas Station" changed price).
    if (i.kind === 'outlier-high' && (priceChangedCats.has(i._category) || breachedCats.has(i._category))) return false;
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
  const xBtn = (attrs) => `<button class="ins-dismiss" type="button" ${attrs} aria-label="Dismiss" style="background:none;border:none;color:var(--text-3);font-size:17px;line-height:1;padding:2px 6px;cursor:pointer;flex-shrink:0;align-self:flex-start;">×</button>`;
  return `
    <div class="card insights-card" style="margin-top:14px;">
      <h3 class="card-title">Worth a look <span class="pill">${monthName(monthIdx, true)}</span></h3>
      ${insights.map(i => `
        <div class="insight-row${i._act ? ' is-act' : ''}"${i._act ? ` data-iact="${esc(i._act[0])}" data-iarg="${esc(i._act[1] ?? '')}"` : ''}>
          <span class="insight-dot" style="background:${toneDot[i.tone]};"></span>
          <div class="insight-body">
            <div class="insight-title">${i.title}</div>
            <div class="insight-detail">${i.detail}</div>
          </div>
          ${i._dismissKey ? xBtn(`data-key="${esc(i._dismissKey)}"`) : i._key ? xBtn(`data-ikey="${esc(i._key)}"`) : ''}
        </div>
      `).join('')}
    </div>
  `;
}
