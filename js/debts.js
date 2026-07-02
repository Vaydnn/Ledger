/* ============================================================
   debts.js — Debts & Loans view + debt plan editor sheet.
   ============================================================ */

import { $, $$, fmt, fmtShort, monthName, today, parseLocalDate, daysBetween, clamp, uid, toast, toastAction, esc, toCents, fromCents, round2, parseAmount } from './util.js';
import { state, dbPut, dbDel, saveFlags } from './db.js';
import { balanceAt, balanceLatest } from './effects.js';
import { openSheet, closeSheet, openPicker } from './sheet.js';

/* ─── NEW(v2.0): amortization engine ─────────────────────────────
   Months-to-payoff + total interest for a fixed monthly payment.
   Interest compounds monthly at apr/12; a future promo end date means
   0% until that month. Results are estimates — real CC interest uses
   daily balances and grace periods — and are labeled as such in the UI. */
function amortize(balance, apr, payment, promoEndDate){
  let bal = toCents(balance);
  if (bal <= 0) return { months:0, interest:0, payoffDate:null, series:[0] };
  const r = (apr || 0) / 100 / 12;
  const payC = toCents(payment);
  if (payC <= 0) return { never:true };
  const promo = promoEndDate ? parseLocalDate(promoEndDate) : null;
  let d = new Date(); d = new Date(d.getFullYear(), d.getMonth(), 1);
  let interest = 0, months = 0;
  const series = [fromCents(bal)];
  while (bal > 0 && months < 600){
    months++;
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const inPromo = promo && d <= promo;
    const i = inPromo ? 0 : Math.round(bal * r);
    if (payC <= i) return { never:true };
    interest += i;
    bal = Math.max(0, bal + i - payC);
    series.push(fromCents(bal));
  }
  if (bal > 0) return { never:true };
  return { months, interest: fromCents(interest), payoffDate: d, series };
}

const fmtMonth = (d) => d ? `${monthName(d.getMonth()+1, true)} ${d.getFullYear()}` : '—';

/* Avalanche vs snowball: pay minimums on everything, throw the extra at one
   target (highest APR first vs smallest balance first); a cleared debt's
   minimum rolls into the extra. Returns months + total interest. */
function simulateStrategy(debts, extra, order){
  // debts: [{balance(cents), apr, min(cents), promoEnd(Date|null)}]
  const ds = debts.map(d => ({ ...d, bal: d.balance })).filter(d => d.bal > 0);
  if (!ds.length) return { months:0, interest:0 };
  let months = 0, interest = 0;
  let d = new Date(); d = new Date(d.getFullYear(), d.getMonth(), 1);
  while (ds.some(x => x.bal > 0) && months < 600){
    months++;
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    // Accrue interest
    for (const x of ds){
      if (x.bal <= 0) continue;
      const inPromo = x.promoEnd && d <= x.promoEnd;
      const i = inPromo ? 0 : Math.round(x.bal * (x.apr || 0) / 100 / 12);
      x.bal += i; interest += i;
    }
    // Budget = all minimums + extra; freed minimums roll over automatically
    let budget = ds.reduce((s,x) => s + x.min, 0) + extra;
    // Minimums first
    for (const x of ds){
      if (x.bal <= 0) continue;
      const pay = Math.min(x.min, x.bal, budget);
      x.bal -= pay; budget -= pay;
    }
    // Extra at the strategy target
    const open = ds.filter(x => x.bal > 0).sort(order);
    for (const x of open){
      if (budget <= 0) break;
      const pay = Math.min(budget, x.bal);
      x.bal -= pay; budget -= pay;
    }
    // If total payments can't outrun interest, bail
    if (months > 1 && ds.every(x => x.bal > 0) && budget === 0 && interest > 0){
      const totalBal = ds.reduce((s,x) => s + x.bal, 0);
      if (totalBal > debts.reduce((s,x) => s + x.balance, 0) * 2) return { never:true };
    }
  }
  if (ds.some(x => x.bal > 0)) return { never:true };
  return { months, interest: fromCents(interest), payoffDate: d };
}

/* SVG payoff curve in the year-view/forecast house style. */
function payoffCurveSVG(series){
  if (!series || series.length < 2) return '';
  const w = 600, h = 90, pad = 8;
  const max = Math.max(...series, 1);
  const sx = (i) => pad + (i / (series.length - 1)) * (w - pad*2);
  const sy = (v) => pad + (1 - v / max) * (h - pad*2);
  const path = series.map((v,i) => `${i===0?'M':'L'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join('');
  const area = `${path} L${sx(series.length-1)},${h-pad} L${sx(0)},${h-pad} Z`;
  return `
    <svg class="nw-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:90px;margin-top:10px;">
      <defs>
        <linearGradient id="dpgrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(224,181,78,.30)"/>
          <stop offset="100%" stop-color="rgba(224,181,78,0)"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#dpgrad)"/>
      <path d="${path}" fill="none" stroke="var(--amber)" stroke-width="2"/>
    </svg>
  `;
}

export function renderDebts(){
  const v = $('#view-debts');
  const { year, month } = state.selected;
  const debts = state.accounts.filter(a => a.active && (a.type === 'Credit Card' || a.type === 'Loan'));
  const ccs = debts.filter(a => a.type === 'Credit Card');
  const loans = debts.filter(a => a.type === 'Loan');
  const total = debts.reduce((s,a) => s + balanceAt(a.name, year, month), 0);

  v.innerHTML = `
    <div class="card" style="margin-bottom:14px;">
      <h3 class="card-title">Total Debt</h3>
      <div style="font-family:'Instrument Serif',serif;font-size:42px;color:var(--amber);line-height:1;">${fmtShort(total)}</div>
      <div class="muted small" style="margin-top:6px;">${ccs.length} card${ccs.length!==1?'s':''} · ${loans.length} loan${loans.length!==1?'':''} · as of ${monthName(month,true)} ${year}</div>
    </div>

    ${renderStrategyCard(debts)}

    ${ccs.length ? `<div class="muted small" style="text-transform:uppercase;letter-spacing:.14em;margin:18px 0 8px;">Credit Cards</div>` : ''}
    ${ccs.map(a => renderDebtCard(a, year, month)).join('')}

    ${loans.length ? `<div class="muted small" style="text-transform:uppercase;letter-spacing:.14em;margin:18px 0 8px;">Loans</div>` : ''}
    ${loans.map(a => renderDebtCard(a, year, month)).join('')}

    <button class="btn ghost" id="add-plan" style="margin-top:6px;">+ Add Debt Plan</button>
  `;

  $$('.dp-edit', v).forEach(b => b.addEventListener('click', () => openPlanSheet(b.dataset.acct)));
  $('#add-plan', v).addEventListener('click', () => openPlanSheet(null));

  // NEW(v2.0): extra-payment input on the strategy card (persisted in flags)
  const extraInp = $('#dst-extra', v);
  if (extraInp){
    extraInp.addEventListener('change', async () => {
      const val = parseAmount(extraInp.value);
      state.flags.debtExtra = isNaN(val) || val < 0 ? 0 : val;
      await saveFlags();
      renderDebts();
    });
    extraInp.addEventListener('focus', () => extraInp.select());
  }
}

/* ─── NEW(v2.0): avalanche vs snowball comparison ───────────────────
   Uses every debt that has a plan with an APR (or active promo) and a
   minimum payment. Debts without plans are listed as excluded so it's
   obvious why the numbers don't cover everything. */
function renderStrategyCard(debts){
  const todayD = new Date();
  const sims = [];
  const excluded = [];
  for (const a of debts){
    const bal = balanceLatest(a.name);
    if (bal <= 0) continue;
    const plan = state.debtPlans.find(d => d.account === a.name);
    const promoEnd = plan?.promoEndDate ? parseLocalDate(plan.promoEndDate) : null;
    const promoActive = promoEnd && promoEnd > todayD;
    if (!plan || (plan.apr == null && !promoActive) || !(plan.minPayment > 0)){
      excluded.push(a.name);
      continue;
    }
    sims.push({
      name: a.name,
      balance: toCents(bal),
      apr: plan.apr || 0,
      min: toCents(plan.minPayment),
      promoEnd
    });
  }
  if (sims.length < 1) return '';

  const extra = state.flags.debtExtra || 0;
  const extraC = toCents(extra);
  const ava = simulateStrategy(sims, extraC, (a,b) => b.apr - a.apr);
  const sno = simulateStrategy(sims, extraC, (a,b) => a.bal - b.bal);
  const minTotal = fromCents(sims.reduce((s,x) => s + x.min, 0));
  const fmtSim = (s) => s.never
    ? `<span style="color:var(--red);">never at this budget</span>`
    : `${fmtMonth(s.payoffDate)} · ~${fmt(s.interest)} interest`;
  const saved = (!ava.never && !sno.never) ? round2(sno.interest - ava.interest) : null;

  return `
    <div class="card" style="margin-bottom:14px;">
      <h3 class="card-title">Payoff Strategy <span class="pill">${sims.length} debt${sims.length===1?'':'s'}</span></h3>
      <div class="muted small" style="margin-bottom:10px;line-height:1.5;">
        Minimums total ${fmt(minTotal)}/mo. Estimates assume monthly compounding — real card interest accrues daily.
      </div>
      <div class="field" style="margin-bottom:10px;">
        <label>Extra toward debt each month ($)</label>
        <input class="input" id="dst-extra" type="text" inputmode="decimal" value="${extra ? extra.toFixed(2) : ''}" placeholder="0" />
      </div>
      <div class="ds-row"><span>Avalanche <span class="muted small">(highest APR first)</span></span><span class="mono" style="text-align:right;">${fmtSim(ava)}</span></div>
      <div class="ds-row"><span>Snowball <span class="muted small">(smallest balance first)</span></span><span class="mono" style="text-align:right;">${fmtSim(sno)}</span></div>
      ${saved != null && saved > 0.01 ? `<div class="debt-good" style="margin-top:10px;">Avalanche saves ~${fmt(saved)} in interest vs snowball.</div>` : ''}
      ${excluded.length ? `<div class="muted small" style="margin-top:10px;">Not included (no APR/min payment in plan): ${excluded.map(esc).join(', ')}</div>` : ''}
    </div>
  `;
}

function renderDebtCard(acct, year, month){
  const bal = balanceAt(acct.name, year, month);
  const plan = state.debtPlans.find(d => d.account === acct.name);
  if (!plan){
    return `
      <div class="debt-card">
        <div class="debt-head">
          <div>
            <div class="debt-name">${esc(acct.name)}</div>
            <div class="debt-bal">${fmt(bal)}</div>
            <div class="debt-meta">No payoff plan</div>
          </div>
        </div>
        <div class="debt-actions">
          <button class="btn secondary dp-edit" data-acct="${acct.name}">Add Plan</button>
        </div>
      </div>
    `;
  }
  const todayD = new Date();
  const rawTarget = plan.targetPayoffDate || plan.promoEndDate || null;
  const targetD = rawTarget ? parseLocalDate(rawTarget) : null;
  const hasTarget = !!(targetD && !isNaN(targetD.getTime()));
  const monthsLeft = hasTarget ? Math.max(1, Math.ceil((targetD - todayD) / (1000*60*60*24*30.44))) : null;
  const suggested = hasTarget ? bal / monthsLeft : null;
  const original = plan.originalBalance || bal;
  const paid = Math.max(0, original - bal);
  const progress = original > 0 ? clamp(paid / original, 0, 1) : 0;

  const isPromo = plan.promoEndDate && parseLocalDate(plan.promoEndDate) > todayD;
  const promoDaysLeft = plan.promoEndDate ? daysBetween(today(), plan.promoEndDate) : null;
  const promoRisk = isPromo && hasTarget && (suggested > (plan.minPayment || 0) * 1.5);

  return `
    <div class="debt-card">
      <div class="debt-head">
        <div>
          <div class="debt-name">${esc(acct.name)}</div>
          <div class="debt-bal">${fmt(bal)}</div>
          <div class="debt-meta">
            ${isPromo ? `0% APR · ends ${plan.promoEndDate}` : (plan.apr != null ? `${plan.apr}% APR` : 'No APR set')}
          </div>
        </div>
        <button class="btn ghost dp-edit" data-acct="${acct.name}" style="width:auto;padding:8px 14px;font-size:12px;">Edit</button>
      </div>

      <div class="debt-progress">
        <div class="muted small" style="display:flex;justify-content:space-between;">
          <span>Paid down</span>
          <span style="font-family:'JetBrains Mono',monospace;">${fmtShort(paid)} of ${fmtShort(original)}</span>
        </div>
        <div class="debt-bar"><i style="width:${progress*100}%"></i></div>
      </div>

      <div class="debt-stats">
        <div class="debt-stat"><div class="v">${hasTarget ? `${monthsLeft} mo` : '—'}</div><div class="l">Until target</div></div>
        <div class="debt-stat"><div class="v">${hasTarget ? fmt(suggested) : '—'}</div><div class="l">/ month needed</div></div>
        <div class="debt-stat"><div class="v">${fmt(plan.minPayment || 0)}</div><div class="l">Min payment</div></div>
      </div>

      ${!hasTarget ? `<div class="muted small" style="margin-top:10px;">Set a target payoff or promo end date to see a suggested monthly payment.</div>` : ''}
      ${renderCardProjection(plan, bal, isPromo)}
      ${promoRisk ? `
        <div class="debt-warn">
          ⚠ At minimum payments you'll owe interest after the promo ends in ${promoDaysLeft} days.
          Pay <b>${fmt(suggested)}/mo</b> to clear before then.
        </div>
      ` : ''}
      ${!isPromo && plan.promoEndDate ? `<div class="debt-warn">Promo period ended ${plan.promoEndDate}. Standard APR now applies.</div>` : ''}
      ${hasTarget && monthsLeft <= 3 && bal > 0 ? `<div class="debt-good">Almost there — only ${monthsLeft} month${monthsLeft===1?'':'s'} to target.</div>` : ''}
    </div>
  `;
}

/* NEW(v2.0): per-card amortization projection — payoff date + total interest
   at the minimum payment, with a balance curve. Needs an APR (or active
   promo) and a min payment on the plan. */
function renderCardProjection(plan, bal, isPromo){
  if (bal <= 0) return '';
  if ((plan.apr == null && !isPromo) || !(plan.minPayment > 0)) return '';
  const proj = amortize(bal, plan.apr || 0, plan.minPayment, isPromo ? plan.promoEndDate : null);
  if (proj.never){
    return `<div class="debt-warn" style="margin-top:10px;">⚠ ${fmt(plan.minPayment)}/mo doesn't cover the interest — this balance never pays off at minimums.</div>`;
  }
  if (proj.months === 0) return '';
  const yrs = proj.months >= 12 ? `${Math.floor(proj.months/12)}y ${proj.months%12}m` : `${proj.months} mo`;
  return `
    <div style="margin-top:12px;">
      <div class="muted small" style="display:flex;justify-content:space-between;">
        <span>At ${fmt(plan.minPayment)}/mo <span style="opacity:.7;">(est.)</span></span>
        <span class="mono">${fmtMonth(proj.payoffDate)} · ${yrs} · ~${fmt(proj.interest)} interest</span>
      </div>
      ${payoffCurveSVG(proj.series)}
    </div>
  `;
}

/* FIX(v1.2): the debt-plan Account field was a native <select> — replaced with
   the bottom-sheet picker (no-native-select rule). The form re-renders on
   account change so the prefilled Original Balance follows the chosen account. */
function openPlanSheet(acctName){
  const debts = state.accounts.filter(a => a.active && (a.type === 'Credit Card' || a.type === 'Loan'));
  if (!debts.length && !acctName) { toast('No credit cards or loans to plan against'); return; }

  const f = { account: acctName || debts[0]?.name };
  const existing = acctName ? state.debtPlans.find(d => d.account === acctName) : null;
  // Field values survive an account re-pick (text inputs persist into v on input)
  const v = {
    orig: existing?.originalBalance != null ? String(existing.originalBalance) : null, // null → prefill from balance
    apr: existing?.apr ?? '',
    min: existing?.minPayment ?? '',
    promo: existing?.promoEndDate || '',
    target: existing?.targetPayoffDate || '',
    notes: existing?.notes || ''
  };

  function render(){
    const bal = f.account ? balanceAt(f.account, state.selected.year, state.selected.month) : 0;
    const origVal = v.orig != null ? v.orig : bal.toFixed(2);
    $('#sheetBody').innerHTML = `
      <h2>${existing ? 'Edit' : 'Add'} Debt Plan</h2>
      <div class="field">
        <label>Account</label>
        <button class="input picker-btn" id="dp-acct" type="button" ${existing ? 'disabled style="opacity:.6;"' : ''}>
          <span class="picker-val">${esc(f.account || '—')}</span>
          <span class="picker-chev">▾</span>
        </button>
      </div>
      <div class="field">
        <label>Original Balance <span class="muted small">(starting amount you're paying off)</span></label>
        <input class="input" id="dp-orig" type="number" step="0.01" inputmode="decimal" value="${origVal}" />
      </div>
      <div class="row-2">
        <div class="field"><label>Standard APR (%)</label><input class="input" id="dp-apr" type="number" step="0.01" inputmode="decimal" value="${v.apr}" placeholder="29.99" /></div>
        <div class="field"><label>Min Payment ($)</label><input class="input" id="dp-min" type="number" step="0.01" inputmode="decimal" value="${v.min}" placeholder="35" /></div>
      </div>
      <div class="row-2">
        <div class="field"><label>Promo APR End Date</label><input class="input" id="dp-promo" type="date" value="${v.promo}" /></div>
        <div class="field"><label>Target Payoff Date</label><input class="input" id="dp-target" type="date" value="${v.target}" /></div>
      </div>
      <div class="field"><label>Notes</label><input class="input" id="dp-notes" value="${esc(v.notes)}" placeholder="e.g. balance transfer from Citi" /></div>
      <button class="btn" id="dp-save">Save Plan</button>
      ${existing ? '<button class="btn danger" id="dp-del" style="margin-top:10px;">Delete Plan</button>' : ''}
    `;

    $('#dp-orig').addEventListener('input', e => v.orig = e.target.value);
    $('#dp-apr').addEventListener('input', e => v.apr = e.target.value);
    $('#dp-min').addEventListener('input', e => v.min = e.target.value);
    $('#dp-promo').addEventListener('input', e => v.promo = e.target.value);
    $('#dp-target').addEventListener('input', e => v.target = e.target.value);
    $('#dp-notes').addEventListener('input', e => v.notes = e.target.value);

    if (!existing){
      $('#dp-acct').addEventListener('click', () => {
        openPicker('Account', debts.map(c => c.name), f.account, (val) => {
          f.account = val;
          v.orig = null; // re-prefill from the newly selected account's balance
          render();
        });
      });
    }

    $('#dp-save').addEventListener('click', async () => {
      // FIX(v2.9.1): parseAmount, not parseFloat ('1,234.56' → 1 silently).
      const num = (s, fallback) => { const n = parseAmount($(s).value); return isNaN(n) ? fallback : n; };
      const plan = {
        id: existing?.id || uid(),
        account: f.account,
        originalBalance: num('#dp-orig', 0),
        apr: num('#dp-apr', null) || null,
        minPayment: num('#dp-min', 0),
        promoEndDate: $('#dp-promo').value || null,
        targetPayoffDate: $('#dp-target').value || null,
        notes: $('#dp-notes').value.trim()
      };
      if (!plan.account){ toast('Pick an account'); return; }
      if (!plan.targetPayoffDate && plan.promoEndDate) plan.targetPayoffDate = plan.promoEndDate;
      await dbPut('debtPlans', plan);
      const i = state.debtPlans.findIndex(d => d.id === plan.id);
      if (i >= 0) state.debtPlans[i] = plan; else state.debtPlans.push(plan);
      closeSheet(); renderDebts(); toast('Plan saved');
    });
    if (existing){
      $('#dp-del').addEventListener('click', async () => {
        // FIX(v2.9.2): immediate delete + Undo toast instead of confirm().
        const removed = { ...existing };
        await dbDel('debtPlans', existing.id);
        state.debtPlans = state.debtPlans.filter(d => d.id !== existing.id);
        closeSheet(); renderDebts();
        toastAction(`Deleted plan for ${removed.account}`, 'Undo', async () => {
          await dbPut('debtPlans', removed);
          state.debtPlans.push(removed);
          renderDebts();
          toast('Plan restored');
        });
      });
    }
  }

  render();
  openSheet();
}
