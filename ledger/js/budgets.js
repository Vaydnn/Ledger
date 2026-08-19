/* ============================================================
   budgets.js — Budgets sheet: view, edit, and add budgets.
   BUG FIX vs v1.0.5: same openPicker issue as Balances — three
   pickers inside the sheet (Budget picker, new-budget Type picker,
   new-budget Category picker) now correctly leave the sheet open.
   ============================================================ */

import { $, $$, fmt, fmtShort, monthAbbr, monthName, alphaSort, clamp, toast, uid, toCents, fromCents, parseAmount, esc } from './util.js';
import { state, dbPut, dbDel } from './db.js';
import { openSheet, openPicker } from './sheet.js';

const budgetsState = { budgetId: null };

// FIX(v2.9.3): the new-budget form's state lives here, not in the DOM.
// The Type/Category pickers replace #sheetBody while open, so the old
// callbacks were writing the picked value onto a DETACHED form element and
// never re-rendering — the user was stranded on the picker with the
// selection going nowhere. Same form-state pattern as the bill editor.
const newBudget = { type: 'Expense', category: '', amount: '' };

export function openBudgetsSheet(){
  const yr = state.selected.year;
  const yearBudgets = state.budgets.filter(b => b.year === yr);

  if (yearBudgets.length === 0){
    renderBudgetsSheet();
    openSheet();
    return;
  }
  if (!budgetsState.budgetId || !yearBudgets.find(b => b.id === budgetsState.budgetId)){
    budgetsState.budgetId = yearBudgets[0].id;
  }
  renderBudgetsSheet();
  openSheet();
}

function renderBudgetsSheet(){
  const yr = state.selected.year;
  const yearBudgets = state.budgets.filter(b => b.year === yr).slice().sort((a,b) => alphaSort(a.category, b.category));
  const current = yearBudgets.find(b => b.id === budgetsState.budgetId);

  // FIX(v1.2): budget usage accumulates in cents.
  const spent = {};
  for (const t of state.transactions){
    if (!t.date || t.date.slice(0,4) !== String(yr)) continue;
    if (!['Expense','Income','Investment'].includes(t.type)) continue;
    const m = monthAbbr[parseInt(t.date.slice(5,7)) - 1];
    const k = `${t.type}|${t.category}|${m}`;
    spent[k] = (spent[k] || 0) + toCents(t.amount);
  }
  for (const k of Object.keys(spent)) spent[k] = fromCents(spent[k]);

  const listHTML = yearBudgets.length === 0 ? '' : `
    <div class="field">
      <label>Budget</label>
      <button class="input picker-btn" id="b-pick" type="button">
        <span class="picker-val">${current ? `${esc(current.category)} · ${current.type}` : '—'}</span>
        <span class="picker-chev">▾</span>
      </button>
    </div>

    ${current ? `
      <div class="sb-list">
        ${monthAbbr.map((m, i) => {
          const target = current.amounts[m] || 0;
          const used = spent[`${current.type}|${current.category}|${m}`] || 0;
          const pct = target > 0 ? clamp(used / target, 0, 1.5) : 0;
          const barCls = pct >= 1 ? 'over' : pct >= 0.8 ? 'warn' : '';
          const remaining = target - used;
          return `
            <div class="sb-row budget-row">
              <div class="sb-month">${monthName(i+1, true)}</div>
              <div class="sb-field">
                <label>Budget</label>
                <input class="sb-input b-cell" data-id="${current.id}" data-m="${m}" data-midx="${i+1}" type="text" inputmode="decimal" value="${target.toFixed(2)}" />
              </div>
              <div class="sb-calc">
                <div class="sb-calc-row">
                  <span>Used</span>
                  <span class="mono">${used === 0 ? '—' : '$' + used.toFixed(2)}</span>
                </div>
                <div class="sb-calc-row end">
                  <span>${remaining >= 0 ? 'Left' : 'Over'}</span>
                  <span class="mono ${remaining >= 0 ? '' : 'neg'}">${target === 0 ? '—' : '$' + Math.abs(remaining).toFixed(2)}</span>
                </div>
                ${target > 0 ? `<div class="bar ${barCls}" style="margin-top:4px;"><i style="width:${pct*100}%;"></i></div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="btn ghost" id="b-fill-rest" style="flex:1;font-size:13px;padding:10px;">Fill forward from current month</button>
        <button class="btn danger" id="b-del" style="width:auto;padding:10px 14px;font-size:13px;">Delete</button>
      </div>

      <div class="muted small" style="margin-top:12px;padding:12px 14px;background:var(--bg-2);border:1px solid var(--line);border-radius:var(--r-sm);line-height:1.55;">
        <b style="color:var(--text-2);">Tip:</b> edit any month's budget, then tap <i>Fill forward</i> to copy that value into every later month. Great for mid-year raises or new rent.
      </div>
    ` : ''}
  `;

  $('#sheetBody').innerHTML = `
    <h2>Budgets · ${yr}</h2>
    <div class="muted small" style="margin-bottom:14px;">Edit any month. Use Fill forward to copy a value into all later months.</div>

    ${renderCopyForward(yr, yearBudgets)}

    ${listHTML}

    <hr class="sep" />
    <h3 style="font-family:'Instrument Serif',serif;font-size:20px;margin:14px 0 12px;font-style:italic;">Add Budget</h3>
    <div class="row-2">
      <div class="field">
        <label>Type</label>
        <button class="input picker-btn" id="bn-type-pick" type="button">
          <span class="picker-val">${newBudget.type}</span>
          <span class="picker-chev">▾</span>
        </button>
      </div>
      <div class="field">
        <label>Category</label>
        <button class="input picker-btn" id="bn-cat-pick" type="button">
          <span class="picker-val">${newBudget.category ? esc(newBudget.category) : 'Tap to pick…'}</span>
          <span class="picker-chev">▾</span>
        </button>
      </div>
    </div>
    <div class="field"><label>Monthly Amount (applies to all 12 months)</label><input class="input" id="b-new-amt" type="text" inputmode="decimal" placeholder="0.00" value="${esc(newBudget.amount)}" /></div>
    <button class="btn" id="b-new-save">Add Budget</button>
  `;

  // NEW(v2.0): copy budgets forward from the previous year — every January
  // used to mean rebuilding all budgets by hand. Copies only the ones that
  // don't already exist for this year, with each month's amounts intact.
  $('#b-copy-fwd')?.addEventListener('click', async () => {
    const prevYr = yr - 1;
    const missing = missingFromPrevYear(yr);
    if (!missing.length) return;
    if (!confirm(`Copy ${missing.length} budget${missing.length===1?'':'s'} from ${prevYr} into ${yr}? Monthly amounts come along.`)) return;
    for (const p of missing){
      const copy = { id: uid(), year: yr, type: p.type, category: p.category, amounts: { ...p.amounts } };
      await dbPut('budgets', copy);
      state.budgets.push(copy);
    }
    budgetsState.budgetId = null;
    toast(`Copied ${missing.length} from ${prevYr}`);
    openBudgetsSheet();
  });

  // Budget picker — re-renders in place, sheet stays open
  if (yearBudgets.length > 0){
    $('#b-pick').addEventListener('click', () => {
      const options = yearBudgets.map(b => `${b.category} · ${b.type}`);
      const currentLabel = current ? `${current.category} · ${current.type}` : null;
      openPicker('Budget', options, currentLabel, (val) => {
        const picked = yearBudgets.find(b => `${b.category} · ${b.type}` === val);
        if (picked){
          budgetsState.budgetId = picked.id;
          renderBudgetsSheet();
        }
      });
    });
  }

  // Budget cell edits
  $$('.b-cell').forEach(inp => {
    inp.addEventListener('change', async () => {
      const b = state.budgets.find(x => x.id === inp.dataset.id);
      if (!b) return;
      // FIX(v2.9.1): parseAmount, not parseFloat ('1,234.56' → 1 silently).
      const val = parseAmount(inp.value);
      if (isNaN(val)){ inp.value = (b.amounts[inp.dataset.m]||0).toFixed(2); return; }
      b.amounts[inp.dataset.m] = val;
      await dbPut('budgets', b);
      renderBudgetsSheet();
    });
    inp.addEventListener('focus', () => inp.select());
  });

  // Fill forward
  $('#b-fill-rest')?.addEventListener('click', async () => {
    if (!current) return;
    const selectedMonth = state.selected.month;
    const srcMonth = monthAbbr[selectedMonth - 1];
    const srcVal = current.amounts[srcMonth] || 0;
    if (!confirm(`Copy ${monthName(selectedMonth, true)}'s budget of $${srcVal.toFixed(2)} into every month after ${monthName(selectedMonth, true)}?`)) return;
    for (let i = selectedMonth; i < 12; i++){
      current.amounts[monthAbbr[i]] = srcVal;
    }
    await dbPut('budgets', current);
    toast(`Filled forward from ${monthName(selectedMonth, true)}`);
    renderBudgetsSheet();
  });

  // Delete budget
  $('#b-del')?.addEventListener('click', async () => {
    if (!current) return;
    if (!confirm(`Delete the "${current.category}" budget?`)) return;
    await dbDel('budgets', current.id);
    state.budgets = state.budgets.filter(b => b.id !== current.id);
    budgetsState.budgetId = null;
    openBudgetsSheet();
  });

  // New-budget form — FIX(v2.9.3): pickers now update `newBudget` and
  // re-render the sheet (the picker replaces #sheetBody while open, so
  // anything less left the user stranded on the picker list).
  $('#b-new-amt').addEventListener('input', e => newBudget.amount = e.target.value);
  $('#bn-type-pick').addEventListener('click', () => {
    openPicker('Budget Type', ['Expense','Income','Investment'], newBudget.type, (val) => {
      newBudget.type = val;
      newBudget.category = ''; // category lists differ per type
      renderBudgetsSheet();
    });
  });
  $('#bn-cat-pick').addEventListener('click', () => {
    const catList = state.categories[newBudget.type] || [];
    if (catList.length === 0){
      toast(`No ${newBudget.type} categories defined`);
      return;
    }
    openPicker(`${newBudget.type} Category`, catList, newBudget.category || null, (val) => {
      newBudget.category = val;
      renderBudgetsSheet();
    });
  });

  // Save new budget
  $('#b-new-save').addEventListener('click', async () => {
    const amtRaw = parseAmount(newBudget.amount); // FIX(v2.9.1): comma-safe
    const amt = isNaN(amtRaw) ? 0 : amtRaw;
    if (!newBudget.category) { toast('Pick a category'); return; }
    const exists = state.budgets.find(b => b.year === yr && b.type === newBudget.type && b.category === newBudget.category);
    if (exists){
      toast('That budget already exists — edit it above');
      return;
    }
    const amounts = {};
    monthAbbr.forEach(m => amounts[m] = amt);
    const newB = { id:uid(), year:yr, type:newBudget.type, category:newBudget.category, amounts };
    await dbPut('budgets', newB);
    state.budgets.push(newB);
    budgetsState.budgetId = newB.id;
    Object.assign(newBudget, { type:'Expense', category:'', amount:'' });
    openBudgetsSheet();
    toast('Budget added');
  });
}

/* ─── NEW(v2.0): copy-forward helpers ─────────────────────────── */
function missingFromPrevYear(yr){
  const prev = state.budgets.filter(b => b.year === yr - 1);
  const cur = state.budgets.filter(b => b.year === yr);
  return prev.filter(p => !cur.find(b => b.type === p.type && b.category === p.category));
}

function renderCopyForward(yr, yearBudgets){
  const missing = missingFromPrevYear(yr);
  if (!missing.length) return '';
  const verb = yearBudgets.length === 0 ? 'Start the year fast —' : `${missing.length} budget${missing.length===1?' is':'s are'} not set up for ${yr} yet —`;
  return `
    <div class="card" style="margin-bottom:14px;padding:14px;">
      <div class="muted small" style="margin-bottom:10px;line-height:1.5;">${verb} copy from ${yr-1} with monthly amounts intact.</div>
      <button class="btn secondary" id="b-copy-fwd" style="font-size:13px;padding:10px;">Copy ${missing.length} budget${missing.length===1?'':'s'} from ${yr-1}</button>
    </div>
  `;
}
