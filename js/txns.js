/* ============================================================
   txns.js — Activity tab: search + filter chips + grouped txn list.
   The search input is rendered once and kept in place across keystrokes
   so the mobile keyboard doesn't close on every filter update.
   ============================================================ */

import { $, $$, fmt, monthKey, monthName, parseLocalDate, today, toast, toastAction, parseAmount, toCents, esc, haptic } from './util.js';
import { state, dbDel, dbPut } from './db.js';
import { openSheet, closeSheet } from './sheet.js';
import { renderCurrent } from './app.js';
import { startEdit } from './add.js';
import { invalidateMerchantCache } from './merchants.js';
import { cascadeForChange } from './balances.js';
import { trashTxn, restoreTxn } from './trash.js';

// NEW(v2.0): amount + date-range filters. amtExact matches to the cent
// (the "did I log that $77.18 charge?" case); min/max are inclusive bounds;
// a date range overrides the month chip while active.
export const txnFilters = { type:'all', search:'', month:'current',
  amtExact:null, amtMin:null, amtMax:null, dateFrom:'', dateTo:'' };

// NEW(v2.5): render cap. "All months" over years of history built 1,000+
// DOM rows on every visit — layout cost dwarfs the JS math on mobile. The
// list renders the newest CAP rows and offers one tap to render the rest.
// Resets whenever filters change.
const RENDER_CAP = 150;
let renderAll_ = false;
export function resetRenderCap(){ renderAll_ = false; }

export function renderTxns(){
  const v = $('#view-txns');
  v.innerHTML = `
    <input class="input txn-search" id="t-search" type="search" placeholder="Search description, category, account…" value="${esc(txnFilters.search)}" />
    <div class="txn-filters">
      ${['all','Expense','Income','Refund','Investment','Transfer','CC Payment','Loan Payment','Balance Transfer'].map(t =>
        `<button class="chip" data-type="${t}" aria-pressed="${txnFilters.type===t}">${t==='all'?'All':t}</button>`
      ).join('')}
      <button class="chip" data-month="toggle" aria-pressed="${txnFilters.month==='all'}">${txnFilters.month==='all'?'All months':'This month'}</button>
      <button class="chip" data-adv="amount" aria-pressed="${amountFilterActive()}">${amountChipLabel()}</button>
      <button class="chip" data-adv="dates" aria-pressed="${dateFilterActive()}">${dateChipLabel()}</button>
    </div>
    <div id="txn-results"></div>
  `;
  renderTxnResults();

  // NEW(v2.5): debounced — was filtering + rebuilding the list per keystroke.
  let searchT = null;
  $('#t-search', v).addEventListener('input', e => {
    txnFilters.search = e.target.value;
    resetRenderCap();
    clearTimeout(searchT);
    searchT = setTimeout(renderTxnResults, 140);
  });
  $$('.chip[data-type]', v).forEach(c => c.addEventListener('click', () => {
    txnFilters.type = c.dataset.type; resetRenderCap(); updateChipStates(); renderTxnResults();
  }));
  $('.chip[data-month]', v).addEventListener('click', () => {
    txnFilters.month = txnFilters.month === 'current' ? 'all' : 'current';
    resetRenderCap(); updateChipStates(); renderTxnResults();
  });
  // NEW(v2.0): amount / date-range filter sheets
  $('.chip[data-adv="amount"]', v).addEventListener('click', openAmountFilterSheet);
  $('.chip[data-adv="dates"]', v).addEventListener('click', openDateFilterSheet);
}

/* ─── NEW(v2.0): advanced filter helpers ─────────────────────────── */
function amountFilterActive(){ return txnFilters.amtExact != null || txnFilters.amtMin != null || txnFilters.amtMax != null; }
function dateFilterActive(){ return !!(txnFilters.dateFrom || txnFilters.dateTo); }
function amountChipLabel(){
  if (txnFilters.amtExact != null) return `$${txnFilters.amtExact.toFixed(2)}`;
  if (txnFilters.amtMin != null && txnFilters.amtMax != null) return `$${txnFilters.amtMin}–$${txnFilters.amtMax}`;
  if (txnFilters.amtMin != null) return `≥ $${txnFilters.amtMin}`;
  if (txnFilters.amtMax != null) return `≤ $${txnFilters.amtMax}`;
  return 'Amount';
}
function dateChipLabel(){
  if (txnFilters.dateFrom && txnFilters.dateTo) return `${txnFilters.dateFrom.slice(5)} → ${txnFilters.dateTo.slice(5)}`;
  if (txnFilters.dateFrom) return `From ${txnFilters.dateFrom.slice(5)}`;
  if (txnFilters.dateTo) return `To ${txnFilters.dateTo.slice(5)}`;
  return 'Dates';
}

function openAmountFilterSheet(){
  $('#sheetBody').innerHTML = `
    <h2>Filter by Amount</h2>
    <div class="field">
      <label>Exact amount <span class="muted small">(matches to the cent — great for "did I log this?")</span></label>
      <input class="input" id="af-exact" type="text" inputmode="decimal" placeholder="e.g. 77.18" value="${txnFilters.amtExact != null ? txnFilters.amtExact.toFixed(2) : ''}" />
    </div>
    <div class="muted small" style="margin:4px 0 10px;">— or a range —</div>
    <div class="row-2">
      <div class="field"><label>Min ($)</label><input class="input" id="af-min" type="text" inputmode="decimal" placeholder="0" value="${txnFilters.amtMin ?? ''}" /></div>
      <div class="field"><label>Max ($)</label><input class="input" id="af-max" type="text" inputmode="decimal" placeholder="∞" value="${txnFilters.amtMax ?? ''}" /></div>
    </div>
    <button class="btn" id="af-apply">Apply</button>
    <button class="btn ghost" id="af-clear" style="margin-top:10px;">Clear Amount Filter</button>
  `;
  openSheet();
  $('#af-apply').addEventListener('click', () => {
    const ex = parseAmount($('#af-exact').value);
    const mn = parseAmount($('#af-min').value);
    const mx = parseAmount($('#af-max').value);
    txnFilters.amtExact = isNaN(ex) ? null : ex;
    // Exact wins over the range; only read the range if exact is empty.
    txnFilters.amtMin = txnFilters.amtExact != null || isNaN(mn) ? null : mn;
    txnFilters.amtMax = txnFilters.amtExact != null || isNaN(mx) ? null : mx;
    resetRenderCap(); closeSheet(); renderTxns();
  });
  $('#af-clear').addEventListener('click', () => {
    txnFilters.amtExact = txnFilters.amtMin = txnFilters.amtMax = null;
    resetRenderCap(); closeSheet(); renderTxns();
  });
}

function openDateFilterSheet(){
  $('#sheetBody').innerHTML = `
    <h2>Filter by Date Range</h2>
    <div class="muted small" style="margin-bottom:12px;">While a range is set, it replaces the This month / All months chip.</div>
    <div class="row-2">
      <div class="field"><label>From</label><input class="input" id="df-from" type="date" value="${txnFilters.dateFrom}" /></div>
      <div class="field"><label>To</label><input class="input" id="df-to" type="date" value="${txnFilters.dateTo}" /></div>
    </div>
    <button class="btn" id="df-apply">Apply</button>
    <button class="btn ghost" id="df-clear" style="margin-top:10px;">Clear Date Filter</button>
  `;
  openSheet();
  $('#df-apply').addEventListener('click', () => {
    txnFilters.dateFrom = $('#df-from').value || '';
    txnFilters.dateTo = $('#df-to').value || '';
    resetRenderCap(); closeSheet(); renderTxns();
  });
  $('#df-clear').addEventListener('click', () => {
    txnFilters.dateFrom = txnFilters.dateTo = '';
    resetRenderCap(); closeSheet(); renderTxns();
  });
}

function updateChipStates(){
  const v = $('#view-txns');
  $$('.chip[data-type]', v).forEach(c => c.setAttribute('aria-pressed', txnFilters.type === c.dataset.type));
  const monthChip = $('.chip[data-month]', v);
  if (monthChip){
    monthChip.setAttribute('aria-pressed', txnFilters.month === 'all');
    monthChip.textContent = txnFilters.month === 'all' ? 'All months' : 'This month';
  }
}

function renderTxnResults(){
  const v = $('#view-txns');
  const results = $('#txn-results', v);
  if (!results) return;
  const { year, month } = state.selected;
  const ym = `${year}-${String(month).padStart(2,'0')}`;

  let list = state.transactions;
  // NEW(v2.0): an explicit date range overrides the month chip.
  if (dateFilterActive()){
    if (txnFilters.dateFrom) list = list.filter(t => t.date && t.date >= txnFilters.dateFrom);
    if (txnFilters.dateTo) list = list.filter(t => t.date && t.date <= txnFilters.dateTo);
  } else if (txnFilters.month === 'current'){
    list = list.filter(t => monthKey(t.date) === ym);
  }
  if (txnFilters.type !== 'all') list = list.filter(t => t.type === txnFilters.type);
  // NEW(v2.0): amount filters compare in cents to dodge float equality traps.
  if (txnFilters.amtExact != null){
    const target = toCents(txnFilters.amtExact);
    list = list.filter(t => toCents(t.amount) === target);
  } else {
    if (txnFilters.amtMin != null) list = list.filter(t => toCents(t.amount) >= toCents(txnFilters.amtMin));
    if (txnFilters.amtMax != null) list = list.filter(t => toCents(t.amount) <= toCents(txnFilters.amtMax));
  }
  if (txnFilters.search){
    const q = txnFilters.search.toLowerCase();
    list = list.filter(t =>
      String(t.description ?? '').toLowerCase().includes(q) || /* FIX(v2.1): non-string descriptions */
      String(t.category ?? '').toLowerCase().includes(q) ||
      String(t.account ?? '').toLowerCase().includes(q)
    );
  }
  // newest-first, capped (NEW v2.5)
  const sorted = [...list].sort((a,b) => (b.date||'').localeCompare(a.date||''));
  const total = sorted.length;
  const shown = renderAll_ ? sorted : sorted.slice(0, RENDER_CAP);
  const truncated = total > shown.length;

  const groups = {};
  shown.forEach(t => { (groups[t.date] = groups[t.date] || []).push(t); });
  const dates = Object.keys(groups).sort((a,b) => b.localeCompare(a));

  results.innerHTML = dates.length === 0
    ? `<div class="empty"><div class="big">Nothing here yet.</div>No transactions match these filters.</div>`
    : dates.map(d => `
        <div class="txn-day">${formatDayHeader(d)}</div>
        ${groups[d].map(t => txnHTML(t)).join('')}
      `).join('') + (truncated
        ? `<button class="btn ghost" id="txn-show-all" style="margin-top:10px;">Show all ${total} (${total - shown.length} more)</button>`
        : '');
  $$('.txn', results).forEach(el => el.addEventListener('click', () => openTxnSheet(el.dataset.id)));
  $('#txn-show-all', results)?.addEventListener('click', () => { renderAll_ = true; renderTxnResults(); });
}

function formatDayHeader(iso){
  const d = parseLocalDate(iso);
  const t = parseLocalDate(today());
  const diff = Math.round((t - d) / 86400000);
  const wd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  if (diff === 0) return 'Today · ' + wd + ' ' + (d.getMonth()+1) + '/' + d.getDate();
  if (diff === 1) return 'Yesterday · ' + wd + ' ' + (d.getMonth()+1) + '/' + d.getDate();
  return wd + ' · ' + monthName(d.getMonth()+1, true) + ' ' + d.getDate();
}

export function txnHTML(t){
  const iconMap = {
    'Expense': ['exp','−'],
    'Income': ['inc','+'],
    'Refund': ['rfnd','↺'],
    'Investment': ['inv','◇'],
    'Transfer': ['tfr','⇄'],
    'CC Payment': ['pay','✓'],
    'Loan Payment': ['pay','✓'],
    'Balance Transfer': ['bxfr','⇉']
  };
  const [cls, sym] = iconMap[t.type] || ['',''];
  const amtCls = (t.type === 'Income' || t.type === 'Refund') ? 'pos' : (t.type === 'Expense' ? 'neg' : 'neu');
  // FIX(v1.2): user-entered strings escaped before innerHTML.
  const meta = esc((t.fromAccount ? `${t.fromAccount} → ` : '') + t.account + (t.description ? ' · ' + t.description : ''));
  return `
    <div class="txn" data-id="${t.id}">
      <div class="txn-icon ${cls}">${sym}</div>
      <div class="txn-body">
        <div class="txn-cat">${esc(t.category || t.type)}</div>
        <div class="txn-meta">${meta}</div>
      </div>
      <div class="txn-amt ${amtCls}">${amtCls==='pos'?'+':amtCls==='neg'?'−':''}$${t.amount.toFixed(2)}</div>
    </div>
  `;
}

export function openTxnSheet(id){
  const t = state.transactions.find(x => x.id === id);
  if (!t) return;
  $('#sheetBody').innerHTML = `
    <h2>Transaction</h2>
    <div class="card" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;">
        <div style="font-family:'Instrument Serif',serif;font-size:30px;color:${t.type==='Income'||t.type==='Refund'?'var(--green)':t.type==='Expense'?'var(--red)':'var(--text)'};">$${t.amount.toFixed(2)}</div>
        <div class="muted small">${t.date}</div>
      </div>
      <div style="font-size:14px;font-weight:500;">${esc(t.category || t.type)}</div>
      <div class="muted small" style="margin-top:6px;">${t.type} · ${esc(t.account)}${t.fromAccount ? ' (from '+esc(t.fromAccount)+')' : ''}</div>
      ${t.description ? `<div style="margin-top:10px;font-size:13.5px;">${esc(t.description)}</div>` : ''}
    </div>
    <button class="btn" id="sh-edit">Edit</button>
    <button class="btn danger" id="sh-del" style="margin-top:10px;">Delete</button>
  `;
  openSheet();
  $('#sh-edit').addEventListener('click', () => { closeSheet(); startEdit(t); });
  $('#sh-del').addEventListener('click', async () => {
    // NEW(v2.0): soft delete — the txn moves to the trash store (30-day
    // retention, restorable from More → Trash) and the toast offers Undo.
    // FIX(v2.9.2): the confirm() popup on top of that was double safety —
    // trash + Undo already make this fully reversible, so it's gone.
    await trashTxn(t);
    await dbDel('transactions', t.id);
    state.transactions = state.transactions.filter(x => x.id !== t.id);
    await cascadeForChange(t, null);
    // If this transaction was the auto-logged payment for a bill, clear that
    // bill's "paid" flag for the affected month(s). Otherwise the bill would
    // keep showing Paid with no backing transaction — which, for standard
    // bills, also makes "Real available" overstate by the bill's amount.
    // (Restoring from trash does NOT re-link the bill — it shows unpaid.)
    for (const bill of state.bills){
      if (!bill.paidMonths) continue;
      let changed = false;
      for (const [ym, txnId] of Object.entries(bill.paidMonths)){
        if (txnId === t.id){ delete bill.paidMonths[ym]; changed = true; }
      }
      if (changed) await dbPut('bills', bill);
    }
    invalidateMerchantCache();
    haptic([10,30,10]); /* NEW(v2.2): destructive pattern */
    // FIX(v2.9.2): renderCurrent, not renderTxns — this sheet can now open
    // from the Home "Recent" card, and re-rendering the hidden Activity view
    // would have left Home showing the deleted transaction.
    closeSheet(); renderCurrent();
    toastAction('Deleted', 'Undo', async () => {
      await restoreTxn({ ...t, deletedAt: Date.now() });
      renderCurrent();
      toast('Restored');
    });
  });
}
