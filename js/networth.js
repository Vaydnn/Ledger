/* ============================================================
   networth.js — net worth chart + snapshot editor.
   ============================================================ */

import { $, $$, fmt, fmtShort, today, uid, toast, toCents, fromCents, parseAmount } from './util.js';
import { state, dbPut, saveFlags } from './db.js';
import { balanceAt, balanceLatest } from './effects.js';
import { openSheet, closeSheet } from './sheet.js';

/* ─── NEW(v2.0): automatic monthly snapshots ─────────────────────
   Fires on the first app open of each calendar month (PWAs can't run
   in the background, so "scheduled" means opportunistic). Skipped when:
   - the user turned it off (flags.autoNWOff)
   - any snapshot (manual or auto) already exists this month
   - there's no data yet
   Investments carry forward from the latest snapshot since the app
   doesn't track brokerage balances. */
export async function maybeAutoSnapshot(){
  if (state.flags.autoNWOff) return;
  if (!state.transactions.length || !state.accounts.length) return;
  const ym = today().slice(0,7);
  if (state.flags.lastAutoNW === ym) return;
  if (state.netWorth.some(n => (n.date || '').startsWith(ym))) return;

  let checking = 0, savings = 0, ccDebt = 0, otherDebt = 0; // cents
  state.accounts.filter(a => a.active).forEach(a => {
    const b = toCents(balanceLatest(a.name));
    if (a.type === 'Checking') checking += b;
    else if (a.type === 'Savings') savings += b;
    else if (a.type === 'Credit Card') ccDebt += b;
    else if (a.type === 'Loan') otherDebt += b;
  });
  const last = state.netWorth[state.netWorth.length - 1];
  const snap = {
    id: uid(),
    date: today(),
    checking: fromCents(checking),
    savings: fromCents(savings),
    investments: last?.investments || 0,
    ccDebt: fromCents(ccDebt),
    otherDebt: fromCents(otherDebt),
    notes: 'Auto snapshot'
  };
  await dbPut('networth', snap);
  state.netWorth.push(snap);
  state.netWorth.sort((a,b) => (a.date||'').localeCompare(b.date||''));
  state.flags.lastAutoNW = ym;
  await saveFlags();
  setTimeout(() => toast('Monthly net worth snapshot saved'), 900);
}

export function renderNetWorthChart(){
  const data = state.netWorth.slice(-12);
  if (!data.length) return '<div class="muted small">No snapshots yet. Add one to track over time.</div>';
  const w = 600, h = 160, pad = 12;
  const xs = data.map((_,i) => i);
  const nw = data.map(d => (d.checking||0) + (d.savings||0) + (d.investments||0) - (d.ccDebt||0) - (d.otherDebt||0));
  const min = Math.min(...nw), max = Math.max(...nw);
  const span = Math.max(1, max - min);
  const sx = (i) => pad + (i / Math.max(1, xs.length - 1)) * (w - pad*2);
  const sy = (v) => pad + (1 - (v - min) / span) * (h - pad*2);
  const path = nw.map((v,i) => `${i===0?'M':'L'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join('');
  const area = `${path} L${sx(xs.length-1)},${h-pad} L${sx(0)},${h-pad} Z`;
  const latest = nw[nw.length-1];
  const first = nw[0];
  const change = latest - first;
  return `
    <div style="font-family:'Instrument Serif',serif;font-size:34px;line-height:1;color:${latest >= 0 ? 'var(--text)' : 'var(--red)'};margin-top:6px;">
      ${fmt(latest)}
    </div>
    <div class="muted small" style="margin-top:4px;">
      ${change >= 0 ? '+' : '−'}${fmt(Math.abs(change))} since ${data[0].date}
    </div>
    <svg class="nw-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="nwgrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(232,153,84,.35)"/>
          <stop offset="100%" stop-color="rgba(232,153,84,0)"/>
        </linearGradient>
      </defs>
      <path class="area" d="${area}"/>
      <path class="line" d="${path}"/>
      ${data.map((_,i) => `<circle class="dot" cx="${sx(i).toFixed(1)}" cy="${sy(nw[i]).toFixed(1)}" r="2.5"/>`).join('')}
    </svg>
    <div class="nw-stats">
      <div class="nw-stat"><div class="l">Assets</div><div class="v">${fmtShort((data[data.length-1].checking||0)+(data[data.length-1].savings||0)+(data[data.length-1].investments||0))}</div></div>
      <div class="nw-stat"><div class="l">Debt</div><div class="v" style="color:var(--amber);">${fmtShort((data[data.length-1].ccDebt||0)+(data[data.length-1].otherDebt||0))}</div></div>
      <div class="nw-stat"><div class="l">Snapshots</div><div class="v">${state.netWorth.length}</div></div>
    </div>
  `;
}

export function openNetWorthSheet(onSaved){
  const yr = state.selected.year, mo = state.selected.month;
  // FIX(v1.2): the snapshot prefill ignored Savings accounts (always 0) and
  // Loan accounts entirely — loans were correctly excluded from the cash
  // buckets but never landed in "Other Debt", so an unedited snapshot
  // overstated net worth by the full loan total. All four buckets prefill
  // now, summed in cents.
  let checking = 0, savings = 0, ccDebt = 0, otherDebt = 0; // cents
  state.accounts.filter(a => a.active).forEach(a => {
    const b = toCents(balanceAt(a.name, yr, mo));
    if (a.type === 'Checking') checking += b;
    else if (a.type === 'Savings') savings += b;
    else if (a.type === 'Credit Card') ccDebt += b;
    else if (a.type === 'Loan') otherDebt += b;
  });
  checking = fromCents(checking); savings = fromCents(savings);
  ccDebt = fromCents(ccDebt); otherDebt = fromCents(otherDebt);
  // NEW(v2.0): investments prefill carries forward from the latest snapshot
  // (it was a hardcoded 0, which made every unedited snapshot drop the
  // brokerage value).
  const lastInv = state.netWorth[state.netWorth.length - 1]?.investments || 0;
  const autoOn = !state.flags.autoNWOff;
  $('#sheetBody').innerHTML = `
    <h2>Net Worth Snapshot</h2>
    <div class="field"><label>Date</label><input class="input" id="nw-date" type="date" value="${today()}" /></div>
    <div class="row-2">
      <div class="field"><label>Checking</label><input class="input" id="nw-chk" type="number" step="0.01" value="${checking.toFixed(2)}" /></div>
      <div class="field"><label>Savings</label><input class="input" id="nw-sav" type="number" step="0.01" value="${savings.toFixed(2)}" /></div>
    </div>
    <div class="field"><label>Investments</label><input class="input" id="nw-inv" type="number" step="0.01" value="${lastInv.toFixed(2)}" /></div>
    <div class="row-2">
      <div class="field"><label>CC Debt</label><input class="input" id="nw-cc" type="number" step="0.01" value="${ccDebt.toFixed(2)}" /></div>
      <div class="field"><label>Other Debt</label><input class="input" id="nw-od" type="number" step="0.01" value="${otherDebt.toFixed(2)}" /></div>
    </div>
    <div class="field"><label>Notes</label><input class="input" id="nw-notes" /></div>
    <div class="field">
      <label>Auto monthly snapshot <span class="muted small">(first open of each month)</span></label>
      <div class="seg" id="nw-auto" role="tablist">
        <button type="button" class="seg-btn ${autoOn?'active':''}" data-on="true">On</button>
        <button type="button" class="seg-btn ${!autoOn?'active':''}" data-on="false">Off</button>
      </div>
    </div>
    <button class="btn" id="nw-save">Save Snapshot</button>
  `;
  openSheet();
  // NEW(v2.0): auto-snapshot toggle persists immediately.
  $$('.seg-btn', $('#nw-auto')).forEach(btn => btn.addEventListener('click', async () => {
    state.flags.autoNWOff = btn.dataset.on !== 'true';
    await saveFlags();
    $$('.seg-btn', $('#nw-auto')).forEach(x => x.classList.toggle('active', x === btn));
  }));
  $('#nw-save').addEventListener('click', async () => {
    // FIX(v2.9.1): parseAmount, not parseFloat ('1,234.56' → 1 silently).
    const num = (s) => { const n = parseAmount($(s).value); return isNaN(n) ? 0 : n; };
    const snap = {
      id: uid(),
      date: $('#nw-date').value,
      checking: num('#nw-chk'),
      savings: num('#nw-sav'),
      investments: num('#nw-inv'),
      ccDebt: num('#nw-cc'),
      otherDebt: num('#nw-od'),
      notes: $('#nw-notes').value
    };
    await dbPut('networth', snap);
    state.netWorth.push(snap);
    state.netWorth.sort((a,b) => a.date.localeCompare(b.date));
    closeSheet();
    if (typeof onSaved === 'function') onSaved();
    toast('Snapshot saved');
  });
}
