/* ============================================================
   charts.js — NEW(v3.1): More → Charts.

   Spending by month (6 / 12 / 24 months, average line), category trends
   (any of your top categories, month by month) and a full-size net worth
   chart (6M / 1Y / All). Plain SVG, sized by viewBox, so it scales from the
   cover screen to the unfolded dialog. Tap a bar for that month's figures.
   ============================================================ */

import { $, $$, fmt, fmtShort, esc, monthName, toCents, fromCents, toLocalISO } from './util.js';
import { state } from './db.js';
import { monthTotals } from './effects.js';
import { openSheet } from './sheet.js';

const W = 600;
let tab = 'spending', span = 12, category = null, nwRange = '1y';

// The n months ending at (y, m) — oldest first.
export function monthsBack(n, y, m){
  const out = [];
  for (let i = n - 1; i >= 0; i--){
    const d = new Date(y, m - 1 - i, 1);
    out.push({ y: d.getFullYear(), m: d.getMonth() + 1, ym: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` });
  }
  return out;
}

export function spendingByMonth(n, y, m){
  return monthsBack(n, y, m).map(p => { const t = monthTotals(p.y, p.m); return { ...p, exp: t.exp, inc: t.inc }; });
}

// Expense total per month for one category (cents-summed).
export function categorySeries(cat, n, y, m){
  const months = monthsBack(n, y, m);
  const idx = new Map(months.map((p, i) => [p.ym, i]));
  const c = new Array(months.length).fill(0);
  for (const t of state.transactions){
    if (t.type !== 'Expense' || (t.category || '(uncategorized)') !== cat || !t.date) continue;
    const i = idx.get(t.date.slice(0, 7));
    if (i != null) c[i] += toCents(t.amount);
  }
  return months.map((p, i) => ({ ...p, value: fromCents(c[i]) }));
}

export function topCategories(n, y, m, limit = 8){
  const from = monthsBack(n, y, m)[0].ym, to = `${y}-${String(m).padStart(2, '0')}`;
  const sums = {};
  for (const t of state.transactions){
    if (t.type !== 'Expense' || !t.date) continue;
    const ym = t.date.slice(0, 7);
    if (ym < from || ym > to) continue;
    const k = t.category || '(uncategorized)';
    sums[k] = (sums[k] || 0) + toCents(t.amount);
  }
  return Object.entries(sums).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k);
}

const avgOf = (vals) => vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;

// Bars + dashed average line. `cur` = index highlighted (the month you're on).
export function barChartSVG(points, { cur = -1, h = 220 } = {}){
  const vals = points.map(p => p.value);
  const max = Math.max(1, ...vals);
  const avg = avgOf(vals);
  const padT = 16, padB = 26, gap = points.length > 14 ? 3 : 6;
  const bw = (W - gap * (points.length - 1)) / points.length;
  const y = (v) => padT + (1 - v / max) * (h - padT - padB);
  const step = points.length > 14 ? 3 : points.length > 8 ? 2 : 1;
  return `
    <svg class="ch-svg" viewBox="0 0 ${W} ${h}" role="img" aria-label="Bar chart">
      ${points.map((p, i) => `<rect class="ch-bar${i === cur ? ' cur' : ''}" data-i="${i}" x="${(i * (bw + gap)).toFixed(1)}" y="${y(p.value).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h - padB - y(p.value)).toFixed(1)}" rx="3"/>`).join('')}
      ${avg > 0 ? `<line class="ch-avg" x1="0" x2="${W}" y1="${y(avg).toFixed(1)}" y2="${y(avg).toFixed(1)}"/>` : ''}
      ${points.map((p, i) => i % step === (points.length - 1) % step ? `<text class="ch-x" x="${(i * (bw + gap) + bw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle">${esc(monthName(p.m, true))}</text>` : '').join('')}
    </svg>`;
}

function netWorthPoints(range){
  const all = state.netWorth.map(d => ({ date: d.date, value: (d.checking || 0) + (d.savings || 0) + (d.investments || 0) - (d.ccDebt || 0) - (d.otherDebt || 0), d }));
  if (range === 'all' || !all.length) return all;
  const last = new Date(all[all.length - 1].date + 'T00:00:00');
  const from = new Date(last.getFullYear(), last.getMonth() - (range === '6m' ? 6 : 12), last.getDate());
  const iso = toLocalISO(from);
  return all.filter(p => p.date >= iso);
}

export function lineChartSVG(points, { h = 260 } = {}){
  if (!points.length) return '';
  const vals = points.map(p => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const spanV = Math.max(1, max - min);
  const padL = 4, padR = 4, padT = 22, padB = 26;
  const x = (i) => padL + (points.length === 1 ? (W - padL - padR) / 2 : i / (points.length - 1) * (W - padL - padR));
  const y = (v) => padT + (1 - (v - min) / spanV) * (h - padT - padB);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${h - padB} L${x(0).toFixed(1)},${h - padB} Z`;
  const lbl = (iso) => { const d = new Date(iso + 'T00:00:00'); return `${monthName(d.getMonth() + 1, true)} ${String(d.getFullYear()).slice(2)}`; };
  return `
    <svg class="ch-svg ch-line" viewBox="0 0 ${W} ${h}" role="img" aria-label="Net worth over time">
      <defs><linearGradient id="chgrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(232,153,84,.32)"/><stop offset="100%" stop-color="rgba(232,153,84,0)"/>
      </linearGradient></defs>
      <line class="ch-grid" x1="0" x2="${W}" y1="${y(max).toFixed(1)}" y2="${y(max).toFixed(1)}"/>
      <line class="ch-grid" x1="0" x2="${W}" y1="${y(min).toFixed(1)}" y2="${y(min).toFixed(1)}"/>
      <text class="ch-y" x="${W - 2}" y="${(y(max) - 5).toFixed(1)}" text-anchor="end">${esc(fmtShort(max))}</text>
      <text class="ch-y" x="${W - 2}" y="${(y(min) - 5).toFixed(1)}" text-anchor="end">${esc(fmtShort(min))}</text>
      <path d="${area}" fill="url(#chgrad)"/>
      <path class="ch-path" d="${line}"/>
      ${points.map((p, i) => `<circle class="ch-dot" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="${points.length > 30 ? 2 : 3.5}"/>`).join('')}
      <text class="ch-x" x="${padL}" y="${h - 8}">${esc(lbl(points[0].date))}</text>
      <text class="ch-x" x="${W - padR}" y="${h - 8}" text-anchor="end">${esc(lbl(points[points.length - 1].date))}</text>
    </svg>`;
}

const segHTML = (id, opts, cur) => `<div class="seg" id="${id}" role="tablist">${opts.map(([v, l]) =>
  `<button type="button" class="seg-btn ${String(cur) === String(v) ? 'active' : ''}" data-v="${v}">${esc(l)}</button>`).join('')}</div>`;

function spendingTab(y, m){
  const pts = spendingByMonth(span, y, m);
  const bars = pts.map(p => ({ ...p, value: p.exp }));
  const avg = avgOf(bars.map(b => b.value));
  return `
    ${segHTML('ch-span', [[6, '6 months'], [12, '12 months'], [24, '24 months']], span)}
    <div class="ch-head"><div class="l">Spent per month</div><div class="v">${fmt(avg)}<span class="safe-unit">avg</span></div></div>
    ${barChartSVG(bars, { cur: bars.length - 1 })}
    <div class="ch-cap" id="ch-cap">${capFor(pts[pts.length - 1])}</div>
    <div class="ch-legend"><span class="ch-key bar"></span>Expenses <span class="ch-key avg"></span>Average</div>`;
}
const capFor = (p) => p ? `${esc(monthName(p.m))} ${p.y}: <b>${fmt(p.exp ?? p.value)}</b>${p.inc != null ? ` spent · ${fmt(p.inc)} income` : ''}` : '';

function categoriesTab(y, m){
  const cats = topCategories(12, y, m);
  if (!cats.length) return '<div class="empty"><div class="big">No spending yet.</div>Category trends appear once you log expenses.</div>';
  if (!category || !cats.includes(category)) category = cats[0];
  const pts = categorySeries(category, span, y, m);
  const vals = pts.map(p => p.value);
  const avg = avgOf(vals), last = vals[vals.length - 1];
  const hi = pts.reduce((a, b) => b.value > a.value ? b : a, pts[0]);
  const vs = avg > 0 ? Math.round((last - avg) / avg * 100) : 0;
  return `
    <div class="cat-chips ch-cats">${cats.map(c => `<button type="button" class="chip" data-cat="${esc(c)}" aria-pressed="${c === category}">${esc(c)}</button>`).join('')}</div>
    ${segHTML('ch-span', [[6, '6 months'], [12, '12 months'], [24, '24 months']], span)}
    <div class="ch-head"><div class="l">${esc(category)} per month</div><div class="v">${fmt(avg)}<span class="safe-unit">avg</span></div></div>
    ${barChartSVG(pts, { cur: pts.length - 1 })}
    <div class="ch-cap" id="ch-cap">${capFor(pts[pts.length - 1])}</div>
    <div class="ch-stats">
      <div><div class="l">This month vs avg</div><div class="v ${vs > 0 ? 'neg' : 'pos'}">${vs > 0 ? '+' : ''}${vs}%</div></div>
      <div><div class="l">Highest</div><div class="v">${fmt(hi.value)} <span class="muted small">${esc(monthName(hi.m, true))} ${String(hi.y).slice(2)}</span></div></div>
    </div>`;
}

function netWorthTab(){
  const pts = netWorthPoints(nwRange);
  if (!pts.length) return '<div class="empty"><div class="big">No net worth snapshots yet.</div>One is saved automatically each month, or add one from More.</div>';
  const first = pts[0].value, last = pts[pts.length - 1].value, ch = last - first;
  const L = pts[pts.length - 1].d;
  return `
    ${segHTML('ch-nw', [['6m', '6M'], ['1y', '1Y'], ['all', 'All']], nwRange)}
    <div class="ch-head"><div class="l">Net worth</div><div class="v">${fmt(last)}</div></div>
    <div class="muted small" style="margin:-4px 0 6px;">${ch >= 0 ? '+' : '−'}${fmt(Math.abs(ch))} since ${esc(pts[0].date)} · ${pts.length} snapshot${pts.length === 1 ? '' : 's'}</div>
    ${lineChartSVG(pts)}
    <div class="ch-stats">
      <div><div class="l">Assets</div><div class="v">${fmt((L.checking || 0) + (L.savings || 0) + (L.investments || 0))}</div></div>
      <div><div class="l">Debt</div><div class="v amber">${fmt((L.ccDebt || 0) + (L.otherDebt || 0))}</div></div>
    </div>`;
}

export function openChartsSheet(startTab){
  if (startTab) tab = startTab;
  const draw = () => {
    const { year: y, month: m } = state.selected;
    $('#sheetBody').innerHTML = `
      <h2>Charts</h2>
      ${segHTML('ch-tab', [['spending', 'Spending'], ['categories', 'Categories'], ['networth', 'Net worth']], tab)}
      <div id="ch-body" class="ch-body">${tab === 'spending' ? spendingTab(y, m) : tab === 'categories' ? categoriesTab(y, m) : netWorthTab()}</div>`;
    $$('#ch-tab .seg-btn').forEach(b => b.addEventListener('click', () => { tab = b.dataset.v; draw(); }));
    $$('#ch-span .seg-btn').forEach(b => b.addEventListener('click', () => { span = Number(b.dataset.v); draw(); }));
    $$('#ch-nw .seg-btn').forEach(b => b.addEventListener('click', () => { nwRange = b.dataset.v; draw(); }));
    $$('.ch-cats .chip').forEach(b => b.addEventListener('click', () => { category = b.dataset.cat; draw(); }));
    // Tap a bar → that month's figures.
    const pts = tab === 'spending' ? spendingByMonth(span, y, m) : tab === 'categories' && category ? categorySeries(category, span, y, m) : [];
    $$('#ch-body .ch-bar').forEach(r => r.addEventListener('click', () => {
      $$('#ch-body .ch-bar').forEach(x => x.classList.toggle('cur', x === r));
      $('#ch-cap').innerHTML = capFor(pts[Number(r.dataset.i)]);
    }));
  };
  draw();
  openSheet({ wide: true });
}
