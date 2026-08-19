/* ============================================================
   breakdown.js — NEW in v1.1.0.

   Monthly Breakdown sheet. For the currently selected month:
     - Summary tiles: Income / Expenses / Net
     - Four sections: Income, Expenses, Investments, Refunds
       Each section shows every category present, sorted by amount desc,
       with percent-of-section bar and month-over-month delta.
     - Tap a category row → drill-down listing that category's txns
       for the month.
   ============================================================ */

import { $, $$, fmt, fmtShort, monthKey, monthName, parseLocalDate, toCents, fromCents, sumMoney, esc } from './util.js';
import { state } from './db.js';
import { monthTotals } from './effects.js';
import { openSheet } from './sheet.js';

// Sum transactions of `type` grouped by category for a given month.
// Returns { totals: {cat: amount, ...}, total }
function groupByCategory(type, year, monthIdx){
  const ym = `${year}-${String(monthIdx).padStart(2,'0')}`;
  // FIX(v1.2): category sums accumulate in cents.
  const totals = {};
  let total = 0; // cents
  for (const t of state.transactions){
    if (t.type !== type) continue;
    if (!t.date || monthKey(t.date) !== ym) continue;
    const cat = t.category || '(uncategorized)';
    totals[cat] = (totals[cat] || 0) + toCents(t.amount);
    total += toCents(t.amount);
  }
  for (const k of Object.keys(totals)) totals[k] = fromCents(totals[k]);
  return { totals, total: fromCents(total) };
}

// Previous month's (year, monthIdx)
function prevMonth(year, monthIdx){
  let y = year, m = monthIdx - 1;
  if (m < 1){ m = 12; y -= 1; }
  return { year:y, month:m };
}

// Render one section (Income / Expenses / Investments / Refunds)
function renderSection(label, type, toneCls, year, monthIdx){
  const { totals, total } = groupByCategory(type, year, monthIdx);
  const prev = prevMonth(year, monthIdx);
  const prevTotals = groupByCategory(type, prev.year, prev.month).totals;

  const rows = Object.entries(totals)
    .map(([cat, amt]) => ({
      cat, amt,
      prev: prevTotals[cat] || 0,
      pct: total > 0 ? amt / total : 0
    }))
    .sort((a, b) => b.amt - a.amt);

  if (rows.length === 0){
    return `
      <div class="brk-section">
        <div class="brk-sec-head">
          <div class="brk-sec-label">${label}</div>
          <div class="brk-sec-total muted">—</div>
        </div>
        <div class="muted small" style="padding:4px 0 14px;font-style:italic;">No ${label.toLowerCase()} this month.</div>
      </div>
    `;
  }

  return `
    <div class="brk-section">
      <div class="brk-sec-head">
        <div class="brk-sec-label">${label}</div>
        <div class="brk-sec-total ${toneCls}">${fmt(total)}</div>
      </div>
      ${rows.map(r => {
        const delta = r.amt - r.prev;
        const deltaCls = delta > 0 ? 'up' : delta < 0 ? 'down' : '';
        const deltaText = r.prev === 0
          ? 'new this month'
          : `${delta >= 0 ? '+' : '−'}${fmtShort(Math.abs(delta))} vs ${monthName(prev.month, true)}`;
        return `
          <button class="brk-row" data-type="${type}" data-cat="${esc(r.cat)}" type="button">
            <div class="brk-row-top">
              <div class="brk-row-cat">${esc(r.cat)}</div>
              <div class="brk-row-amt mono">${fmt(r.amt)}</div>
            </div>
            <div class="brk-row-bar ${toneCls}"><i style="width:${(r.pct*100).toFixed(1)}%;"></i></div>
            <div class="brk-row-foot">
              <span>${(r.pct*100).toFixed(0)}% of ${label.toLowerCase()}</span>
              <span class="brk-delta ${deltaCls}">${deltaText}</span>
            </div>
          </button>
        `;
      }).join('')}
    </div>
  `;
}

// Drill-down: list every transaction of (type, category) for this month
function openCategoryDrill(type, category){
  const { year, month } = state.selected;
  const ym = `${year}-${String(month).padStart(2,'0')}`;
  const txns = state.transactions
    .filter(t => t.type === type && (t.category || '(uncategorized)') === category && monthKey(t.date) === ym)
    .sort((a, b) => b.date.localeCompare(a.date));
  const sum = sumMoney(txns, t => t.amount);

  $('#sheetBody').innerHTML = `
    <h2>${esc(category)}</h2>
    <div class="muted small" style="margin-bottom:14px;">${type} · ${monthName(month)} ${year} · ${txns.length} transaction${txns.length===1?'':'s'} · ${fmt(sum)}</div>
    ${txns.length === 0
      ? `<div class="empty"><div class="big">Nothing here.</div></div>`
      : txns.map(t => {
          const d = parseLocalDate(t.date);
          const dayLbl = `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]} ${monthName(d.getMonth()+1, true)} ${d.getDate()}`;
          return `
            <div class="txn">
              <div class="txn-body">
                <div class="txn-cat">${esc(t.description || category)}</div>
                <div class="txn-meta">${dayLbl} · ${esc(t.account)}</div>
              </div>
              <div class="txn-amt mono">${fmt(t.amount)}</div>
            </div>
          `;
        }).join('')
    }
    <button class="btn ghost" id="brk-back" style="margin-top:16px;">← Back to Breakdown</button>
  `;
  openSheet();
  $('#brk-back').addEventListener('click', openBreakdownSheet);
}

export function openBreakdownSheet(){
  const { year, month } = state.selected;
  const tot = monthTotals(year, month);

  $('#sheetBody').innerHTML = `
    <h2>Breakdown · ${monthName(month, true)} ${year}</h2>
    <div class="muted small" style="margin-bottom:14px;">Every category, sorted by amount. Tap a row to see the transactions.</div>

    <div class="sub-totals">
      <div class="sub-tile"><div class="l">Income</div><div class="v" style="color:var(--green);">${fmt(tot.inc + tot.rfnd)}</div></div>
      <div class="sub-tile"><div class="l">Expenses</div><div class="v" style="color:var(--red);">${fmt(tot.exp)}</div></div>
      <div class="sub-tile"><div class="l">Net</div><div class="v" style="color:${tot.net >= 0 ? 'var(--green)' : 'var(--red)'};">${fmt(tot.net, true)}</div></div>
    </div>

    ${renderSection('Income', 'Income', 'income', year, month)}
    ${renderSection('Expenses', 'Expense', 'expense', year, month)}
    ${renderSection('Investments', 'Investment', 'invest', year, month)}
    ${renderSection('Refunds', 'Refund', 'refund', year, month)}

    <div class="muted small" style="margin-top:14px;text-align:center;line-height:1.55;">
      Deltas compare to ${monthName(prevMonth(year, month).month, true)} ${prevMonth(year, month).year}.
    </div>
  `;
  openSheet();

  $$('.brk-row').forEach(b => b.addEventListener('click', () => {
    openCategoryDrill(b.dataset.type, b.dataset.cat);
  }));
}
