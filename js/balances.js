/* ============================================================
   balances.js — Starting Balances editor sheet + cascade helpers.

   BUG FIX vs v1.0.5: the account picker inside this sheet used to
   close the sheet on selection (because openPicker auto-closed) and
   the caller never re-opened it. Now openPicker leaves the sheet
   open and we re-render content in place — which is what was intended.

   BUG FIX vs v1.1.0: stored starting balances would go stale when
   transactions were added/edited/deleted, because the cascade only
   ran when the user manually edited a row in this sheet. Symptom:
   end-of-month balance shown for May = (stale May start) + (May txns),
   which could differ from the actual end of April balance — i.e. the
   carry-over broke. Fix: cascadeForChange() now runs after every
   transaction mutation (see add.js, txns.js, bills.js, home.js).
   cascadeBalances() is also exported so manage.js can offer a one-shot
   "Recompute Balances" action for fixing pre-1.1.1 data.
   ============================================================ */

import { $, $$, fmt, monthAbbr, monthName, uid, toast, round2, parseAmount, esc } from './util.js';
import { state, dbPut } from './db.js';
import { monthNetForAccount } from './effects.js';
import { openSheet, openPicker } from './sheet.js';

const balancesState = { accountName: null };

export function openBalancesSheet(){
  const yr = state.selected.year;
  const activeAccounts = state.accounts.filter(a => a.active);
  if (activeAccounts.length === 0){
    $('#sheetBody').innerHTML = `<h2>Starting Balances · ${yr}</h2><div class="muted small">No active accounts yet. Add one in More → Accounts.</div>`;
    openSheet();
    return;
  }
  if (!balancesState.accountName || !activeAccounts.find(a => a.name === balancesState.accountName)){
    balancesState.accountName = activeAccounts[0].name;
  }
  renderBalancesSheet();
  openSheet();
}

function ensureBalRecord(accountName, year){
  let rec = state.startingBalances.find(b => b.account === accountName && b.year === year);
  if (!rec){
    rec = { id:uid(), account:accountName, year };
    monthAbbr.forEach(m => rec[m] = 0);
    // FIX(v2.9.1): year-boundary carryover on CREATION. The December→January
    // propagation below only fires when a prior-year cascade runs and the
    // next year's record already exists — so the first transaction of a new
    // year created this record with jan = 0, silently dropping every
    // account's carried balance until something happened to re-cascade the
    // old year. Seed January from the prior year's computed December ending.
    const prev = state.startingBalances.find(b => b.account === accountName && b.year === year - 1);
    if (prev){
      const decEnd = round2((prev[monthAbbr[11]] || 0) + monthNetForAccount(accountName, year - 1, 12));
      rec.jan = decEnd;
    }
    state.startingBalances.push(rec);
    dbPut('startingBalances', rec);
  }
  return rec;
}

async function cascadeBalances(accountName, year, fromMonthIdx){
  // A brand-new record needs the whole year filled from its (possibly
  // carried-over) January opening — cascading only from the transaction's
  // month would leave the months in between stuck at 0.
  const existed = state.startingBalances.some(b => b.account === accountName && b.year === year);
  const rec = ensureBalRecord(accountName, year);
  if (!existed) fromMonthIdx = 1;
  for (let m = fromMonthIdx; m < 12; m++){
    const thisStart = rec[monthAbbr[m-1]] || 0;
    const net = monthNetForAccount(accountName, year, m);
    rec[monthAbbr[m]] = Math.round((thisStart + net) * 100) / 100;
  }
  await dbPut('startingBalances', rec);

  // Cross-year carryover: December's ENDING balance becomes next January's
  // OPENING balance. Previously this never happened — the loop above stops
  // at December within the same year — so editing a December transaction
  // left the following January's starting balance stale.
  //
  // We only propagate when a starting-balance record for (account, year+1)
  // already exists. That keeps the mid-year-opening rule intact: a brand-new
  // account whose next year hasn't been touched won't get a fabricated record,
  // and a manually-set opening for a year with no prior-year activity is never
  // clobbered (we'd never be cascading the prior year in the first place).
  const decStart = rec[monthAbbr[11]] || 0;
  const decNet = monthNetForAccount(accountName, year, 12);
  const decEnd = Math.round((decStart + decNet) * 100) / 100;
  const nextRec = state.startingBalances.find(b => b.account === accountName && b.year === year + 1);
  if (nextRec && (nextRec.jan || 0) !== decEnd){
    nextRec.jan = decEnd;
    // Recurse from January of the next year. Terminates: years strictly
    // increase, records are finite, and we only recurse when jan changed.
    await cascadeBalances(accountName, year + 1, 1);
  }
}

// Exported wrapper so manage.js can do a one-shot "Recompute Balances"
// over every account-year pair without needing access to ensureBalRecord.
export { cascadeBalances };

// Called after any transaction mutation (add / edit / delete). Figures
// out which (account, year) pairs are affected by the change, then for
// each one cascades from the earliest affected month forward.
//
// Pass `oldTxn = null` for a fresh add, or `newTxn = null` for a delete.
// On an edit, pass both — we cascade across the union so date / account
// changes are handled correctly (e.g. moving a txn from March to July
// must refresh both March-onward AND July-onward).
//
// Cascading from earliest-affected-month (rather than January) preserves
// any manually-set opening balances for accounts that started mid-year
// — see the Affirm-loan tip in renderBalancesSheet.
export async function cascadeForChange(oldTxn, newTxn){
  const earliest = new Map();   // key: `${account}|${year}` → earliest month
  const consider = (t) => {
    if (!t || !t.date) return;
    const yr = parseInt(t.date.slice(0,4), 10);
    const mo = parseInt(t.date.slice(5,7), 10);
    if (!yr || !mo) return;
    for (const acct of [t.account, t.fromAccount]){
      if (!acct) continue;
      const key = `${acct}|${yr}`;
      if (!earliest.has(key) || earliest.get(key) > mo) earliest.set(key, mo);
    }
  };
  consider(oldTxn);
  consider(newTxn);
  for (const [key, mo] of earliest){
    const [acct, yrStr] = key.split('|');
    await cascadeBalances(acct, parseInt(yrStr, 10), mo);
  }
}

function renderBalancesSheet(){
  const yr = state.selected.year;
  const activeAccounts = state.accounts.filter(a => a.active);
  const acct = state.accounts.find(a => a.name === balancesState.accountName);
  const rec = ensureBalRecord(balancesState.accountName, yr);
  const isDebt = acct && (acct.type === 'Credit Card' || acct.type === 'Loan');

  const rows = monthAbbr.map((m, i) => {
    const start = rec[m] || 0;
    const net = monthNetForAccount(balancesState.accountName, yr, i+1);
    const end = round2(start + net); // FIX(v1.2): round display sum
    return { monthIdx: i+1, monthAbbr: m, start, net, end };
  });

  $('#sheetBody').innerHTML = `
    <h2>Starting Balances · ${yr}</h2>
    <div class="muted small" style="margin-bottom:12px;line-height:1.5;">
      Edit any month and later months auto-update based on recorded transactions.
      ${isDebt ? ' For cards/loans, the number is the amount owed.' : ''}
    </div>

    <div class="field">
      <label>Account</label>
      <button class="input picker-btn" id="sb-acct-pick" type="button">
        <span class="picker-val">${esc(balancesState.accountName)}${acct ? ' · ' + acct.type : ''}</span>
        <span class="picker-chev">▾</span>
      </button>
    </div>

    <div class="sb-list">
      ${rows.map(r => `
        <div class="sb-row">
          <div class="sb-month">${monthName(r.monthIdx, true)}</div>
          <div class="sb-field">
            <label>Starting</label>
            <input class="sb-input" data-m="${r.monthAbbr}" data-midx="${r.monthIdx}" type="text" inputmode="decimal" value="${r.start.toFixed(2)}" />
          </div>
          <div class="sb-calc">
            <div class="sb-calc-row">
              <span>Activity</span>
              <span class="mono ${r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}">${r.net === 0 ? '—' : (r.net > 0 ? '+' : '−') + '$' + Math.abs(r.net).toFixed(2)}</span>
            </div>
            <div class="sb-calc-row end">
              <span>Ending</span>
              <span class="mono">${fmt(r.end)}</span>
            </div>
          </div>
        </div>
      `).join('')}
    </div>

    <div class="muted small" style="margin-top:14px;padding:12px 14px;background:var(--bg-2);border:1px solid var(--line);border-radius:var(--r-sm);line-height:1.55;">
      <b style="color:var(--text-2);">Tip:</b> when adding an account mid-year (like an Affirm loan starting in April),
      set Jan–Mar to 0, then enter the April opening balance. All later months will auto-fill based on payments and charges.
    </div>
  `;

  // Account picker — the callback re-renders in the still-open sheet.
  // With the bug fix, openPicker no longer auto-closes the sheet.
  $('#sb-acct-pick').addEventListener('click', () => {
    openPicker('Account', activeAccounts.map(a => a.name), balancesState.accountName, (val) => {
      balancesState.accountName = val;
      renderBalancesSheet();
    });
  });

  // Starting-balance cell edits
  $$('.sb-input').forEach(inp => {
    inp.addEventListener('change', async () => {
      const m = inp.dataset.m;
      const mIdx = parseInt(inp.dataset.midx);
      // FIX(v2.9.1): parseAmount, not parseFloat — parseFloat('1,234.56')
      // returns 1 and a wrong opening cascades through every later month.
      const val = parseAmount(inp.value);
      if (isNaN(val)){ inp.value = (rec[m]||0).toFixed(2); return; }
      rec[m] = val;
      await dbPut('startingBalances', rec);
      await cascadeBalances(balancesState.accountName, yr, mIdx);
      toast('Cascaded from ' + monthName(mIdx, true));
      renderBalancesSheet();
    });
    inp.addEventListener('focus', () => inp.select());
  });
}
