/* ============================================================
   yearview.js — NEW in v1.1.0.

   Calendar heatmap of daily net for an entire year.
   Layout: 12 mini-calendars (3 cols × 4 rows on phones, 4×3 on tablets).
   Each cell's color intensity scales with that day's net-positive
   or net-negative amount, normalized against the year's max magnitude.

   Tap a cell → drill-down list of that day's transactions.
   ============================================================ */

import { $, $$, fmt, fmtShort, monthName, parseLocalDate, toLocalISO, toCents, fromCents, esc } from './util.js';
import { state } from './db.js';
import { openSheet } from './sheet.js';

// Returns {daily: Map(isoDate → net), maxAbs, totalNet, bestDay, worstDay}
function computeYearData(year){
  // FIX(v1.2): daily nets accumulate in cents (heatmap bucket thresholds were
  // computed on drifting floats).
  const daily = {};
  let maxAbs = 0;
  let totalNet = 0; // cents
  for (const t of state.transactions){
    if (!t.date || !t.date.startsWith(String(year))) continue;
    const signed =
      t.type === 'Income' || t.type === 'Refund' ? toCents(t.amount) :
      t.type === 'Expense' || t.type === 'Investment' ? -toCents(t.amount) :
      0; // transfers/payments don't change net
    if (signed === 0) continue;
    daily[t.date] = (daily[t.date] || 0) + signed;
    totalNet += signed;
  }
  for (const k of Object.keys(daily)) daily[k] = fromCents(daily[k]);
  totalNet = fromCents(totalNet);
  let bestDay = null, worstDay = null;
  for (const [d, v] of Object.entries(daily)){
    if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    if (!bestDay || v > daily[bestDay]) bestDay = d;
    if (!worstDay || v < daily[worstDay]) worstDay = d;
  }
  return { daily, maxAbs, totalNet, bestDay, worstDay };
}

// Render one 7-col × 6-row mini-calendar for a specific month
function renderMonthGrid(year, monthIdx, daily, maxAbs){
  const firstDay = new Date(year, monthIdx - 1, 1);
  const firstWeekday = firstDay.getDay(); // 0 = Sun
  const daysInMonth = new Date(year, monthIdx, 0).getDate();

  // Sum net for this month (for header)
  let monthNet = 0; // cents
  for (let d = 1; d <= daysInMonth; d++){
    const iso = `${year}-${String(monthIdx).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if (daily[iso]) monthNet += toCents(daily[iso]);
  }
  monthNet = fromCents(monthNet);

  // Build cells: leading blanks + days (we deliberately don't add trailing blanks
  // — grid is auto-flow so the last row just ends where the month does)
  const cells = [];
  for (let i = 0; i < firstWeekday; i++){
    cells.push(`<div class="yv-cell blank"></div>`);
  }
  for (let d = 1; d <= daysInMonth; d++){
    const iso = `${year}-${String(monthIdx).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const net = daily[iso] || 0;
    let cls = 'zero', intensity = 0;
    if (net !== 0 && maxAbs > 0){
      intensity = Math.min(1, Math.abs(net) / maxAbs);
      cls = net > 0 ? 'pos' : 'neg';
    }
    // 5 opacity buckets for visual distinction without being noisy
    const bucket = intensity === 0 ? 0 : Math.max(1, Math.ceil(intensity * 4));
    cells.push(`
      <button class="yv-cell ${cls} b${bucket}" data-iso="${iso}" type="button" aria-label="${iso}: ${fmt(net, true)}">
        <span class="yv-day">${d}</span>
      </button>
    `);
  }

  return `
    <div class="yv-month">
      <div class="yv-month-head">
        <div class="yv-month-name">${monthName(monthIdx, true)}</div>
        <div class="yv-month-net ${monthNet >= 0 ? 'pos' : 'neg'}">${monthNet === 0 ? '—' : fmt(monthNet, true)}</div>
      </div>
      <div class="yv-weekdays">
        <span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span>
      </div>
      <div class="yv-grid">${cells.join('')}</div>
    </div>
  `;
}

// Drill-down for a tapped day
function openDayDrill(iso){
  const txns = state.transactions
    .filter(t => t.date === iso)
    .sort((a, b) => (b.type === 'Income' || b.type === 'Refund') - (a.type === 'Income' || a.type === 'Refund'));
  const d = parseLocalDate(iso);
  const header = `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]} · ${monthName(d.getMonth()+1)} ${d.getDate()}, ${d.getFullYear()}`;

  const signedSum = fromCents(txns.reduce((s, t) => {
    if (t.type === 'Income' || t.type === 'Refund') return s + toCents(t.amount);
    if (t.type === 'Expense' || t.type === 'Investment') return s - toCents(t.amount);
    return s;
  }, 0));

  $('#sheetBody').innerHTML = `
    <h2>${header}</h2>
    <div class="muted small" style="margin-bottom:14px;">${txns.length} transaction${txns.length===1?'':'s'} · Net ${fmt(signedSum, true)}</div>
    ${txns.length === 0
      ? `<div class="empty"><div class="big">Nothing logged.</div></div>`
      : txns.map(t => {
          const isPos = t.type === 'Income' || t.type === 'Refund';
          const isNeg = t.type === 'Expense' || t.type === 'Investment';
          const cls = isPos ? 'pos' : isNeg ? 'neg' : 'neu';
          const sign = isPos ? '+' : isNeg ? '−' : '';
          return `
            <div class="txn">
              <div class="txn-body">
                <div class="txn-cat">${esc(t.category || t.type)}</div>
                <div class="txn-meta">${esc(t.account)}${t.description ? ' · ' + esc(t.description) : ''}</div>
              </div>
              <div class="txn-amt ${cls}">${sign}$${t.amount.toFixed(2)}</div>
            </div>
          `;
        }).join('')
    }
    <button class="btn ghost" id="yv-back" style="margin-top:16px;">← Back to Year View</button>
  `;
  openSheet();
  $('#yv-back').addEventListener('click', openYearViewSheet);
}

export function openYearViewSheet(){
  const year = state.selected.year;
  const { daily, maxAbs, totalNet, bestDay, worstDay } = computeYearData(year);
  const activeDays = Object.keys(daily).length;

  const bestNet  = bestDay  ? daily[bestDay]  : 0;
  const worstNet = worstDay ? daily[worstDay] : 0;

  const formatDayLbl = (iso) => {
    if (!iso) return '—';
    const d = parseLocalDate(iso);
    return `${monthName(d.getMonth()+1, true)} ${d.getDate()}`;
  };

  $('#sheetBody').innerHTML = `
    <h2>Year View · ${year}</h2>
    <div class="muted small" style="margin-bottom:14px;">Daily net across the year. Green = money in, red = money out. Tap any day.</div>

    <div class="sub-totals">
      <div class="sub-tile"><div class="l">Net YTD</div><div class="v" style="color:${totalNet >= 0 ? 'var(--green)' : 'var(--red)'};">${fmt(totalNet, true)}</div></div>
      <div class="sub-tile"><div class="l">Best day</div><div class="v" style="color:var(--green);font-size:16px;">${fmtShort(bestNet)}<br><span class="muted small" style="font-family:'Geist',sans-serif;font-style:normal;font-size:11px;">${formatDayLbl(bestDay)}</span></div></div>
      <div class="sub-tile"><div class="l">Worst day</div><div class="v" style="color:var(--red);font-size:16px;">${fmtShort(worstNet)}<br><span class="muted small" style="font-family:'Geist',sans-serif;font-style:normal;font-size:11px;">${formatDayLbl(worstDay)}</span></div></div>
    </div>

    <div class="yv-months">
      ${Array.from({length:12}, (_,i) => renderMonthGrid(year, i+1, daily, maxAbs)).join('')}
    </div>

    <div class="muted small" style="margin-top:14px;text-align:center;line-height:1.55;">
      ${activeDays} active day${activeDays===1?'':'s'} this year. Max magnitude shown: ${fmtShort(maxAbs)}.
    </div>
  `;
  openSheet();

  $$('.yv-cell[data-iso]').forEach(c => c.addEventListener('click', () => openDayDrill(c.dataset.iso)));
}
