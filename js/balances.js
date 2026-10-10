/* ============================================================
   balances.js — Balances sheet (pinned openings) + the v3.0 migration.

   NEW(v3.0): there is no cascade any more. Balances are derived on the fly
   (effects.js) from transactions plus a few ANCHORS — "account X started
   month M with $Y". Typing a month's starting balance here pins it; every
   later month follows from it automatically, and editing any transaction
   anywhere is reflected immediately with nothing to keep in sync.

   History of the problem this replaces: stored month-by-month balances
   needed a cascade after every add/edit/delete, and that cascade was the
   source of the v1.1.1 (stale months), v1.1.4 (no Dec→Jan carry), v2.9.1
   (new year opened at $0) and v2.10.2 (dormant accounts at $0) bugs.
   ============================================================ */

import { $, $$, fmt, monthAbbr, monthName, uid, toast, toastAction, round2, parseAmount, esc, ymOf, busyGuard } from './util.js';
import { state, dbPut, dbDel, dbClear, dbBulkPut, saveFlags } from './db.js';
import { monthNetForAccount, getStartingBalance, anchorAt, anchorsFromLegacy } from './effects.js';
import { openSheet, openPicker } from './sheet.js';

const balancesState = { accountName: null };

/* ── Migration: legacy startingBalances → anchors ──────────────────── */
// Runs once per device on upgrade (app.js), and again whenever a pre-v3
// backup is restored (manage.js). Returns the number of anchors created.
export async function migrateLegacyBalances(rows = state.startingBalances){
  const anchors = anchorsFromLegacy(rows).map(a => ({ id: uid(), ...a }));
  await dbClear('balanceAnchors');
  if (anchors.length) await dbBulkPut('balanceAnchors', anchors);
  state.balanceAnchors = anchors;
  state.flags.anchorsV3 = true;
  await saveFlags();
  if (anchors.length) console.info(`[Ledger] v3.0 migration: ${anchors.length} pinned opening balance(s)`, anchors);
  return anchors.length;
}

export async function ensureAnchorsMigrated(){
  if (state.flags.anchorsV3) return 0;
  if (state.balanceAnchors.length || !state.startingBalances.length){
    state.flags.anchorsV3 = true;
    await saveFlags();
    return 0;
  }
  return migrateLegacyBalances();
}

/* ── Anchor CRUD ───────────────────────────────────────────────────── */
export async function setAnchor(account, month, amount){
  let a = state.balanceAnchors.find(x => x.account === account && x.month === month);
  if (a) a.amount = round2(amount);
  else {
    a = { id: uid(), account, month, amount: round2(amount) };
    state.balanceAnchors.push(a);
  }
  await dbPut('balanceAnchors', a);
  return a;
}
export async function clearAnchor(account, month){
  const a = state.balanceAnchors.find(x => x.account === account && x.month === month);
  if (!a) return null;
  await dbDel('balanceAnchors', a.id);
  state.balanceAnchors = state.balanceAnchors.filter(x => x.id !== a.id);
  return a;
}

/* ── Sheet ─────────────────────────────────────────────────────────── */
export function openBalancesSheet(account){
  const accounts = sheetAccounts();
  if (accounts.length === 0){
    $('#sheetBody').innerHTML = `<h2>Balances · ${state.selected.year}</h2><div class="muted small">No accounts yet. Add one in More → Accounts.</div>`;
    openSheet();
    return;
  }
  if (account) balancesState.accountName = account;
  if (!balancesState.accountName || !accounts.find(a => a.name === balancesState.accountName)){
    balancesState.accountName = accounts[0].name;
  }
  renderBalancesSheet();
  openSheet();
}

// Open accounts first, then closed ones (their history still needs openings).
function sheetAccounts(){
  return [...state.accounts.filter(a => a.active), ...state.accounts.filter(a => !a.active)];
}

function renderBalancesSheet(){
  const yr = state.selected.year;
  const accounts = sheetAccounts();
  const name = balancesState.accountName;
  const acct = state.accounts.find(a => a.name === name);
  const isDebt = acct && (acct.type === 'Credit Card' || acct.type === 'Loan');
  const pins = state.balanceAnchors.filter(a => a.account === name).sort((a, b) => a.month.localeCompare(b.month));

  const rows = monthAbbr.map((m, i) => {
    const ym = ymOf(yr, i + 1);
    const start = getStartingBalance(name, yr, i + 1);
    const net = monthNetForAccount(name, yr, i + 1);
    return { monthIdx: i + 1, ym, start, net, end: round2(start + net), pinned: !!anchorAt(name, ym) };
  });

  $('#sheetBody').innerHTML = `
    <h2>Balances · ${yr}</h2>
    <div class="muted small" style="margin-bottom:12px;line-height:1.5;">
      Balances are calculated from your transactions. <b>Pin</b> a month's starting balance when an account opens
      (or to match your bank) by typing it below — every later month follows automatically.
      ${isDebt ? ' For cards and loans, the number is the amount owed.' : ''}
    </div>

    <div class="field">
      <label>Account</label>
      <button class="input picker-btn" id="sb-acct-pick" type="button">
        <span class="picker-val">${esc(name)}${acct ? ' · ' + esc(acct.type) + (acct.active ? '' : ' · closed') : ''}</span>
        <span class="picker-chev">▾</span>
      </button>
    </div>

    ${pins.length ? `
      <div class="muted small" style="margin-bottom:10px;line-height:1.5;">
        Pinned: ${pins.map(p => `${monthName(Number(p.month.slice(5)), true)} ${p.month.slice(0,4)} = ${fmt(p.amount)}`).join(' · ')}
        ${pins.length > 1 ? '<br>With more than one pin, transactions before a later pin no longer affect the months after it.' : ''}
      </div>` : ''}

    <div class="sb-list">
      ${rows.map(r => `
        <div class="sb-row${r.pinned ? ' is-pinned' : ''}">
          <div class="sb-month">${monthName(r.monthIdx, true)}${r.pinned ? '<div class="sb-pin">📌 pinned</div>' : ''}</div>
          <div class="sb-field">
            <label>Starting</label>
            <input class="sb-input" data-ym="${r.ym}" data-midx="${r.monthIdx}" type="text" inputmode="decimal" value="${r.start.toFixed(2)}" />
            ${r.pinned ? `<button type="button" class="sb-unpin" data-ym="${r.ym}">Unpin</button>` : ''}
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
      <b style="color:var(--text-2);">Tip:</b> for an account that opened mid-year (like a loan starting in April),
      type its opening balance into April's Starting box. Months before it stay at $0.
    </div>
  `;

  $('#sb-acct-pick').addEventListener('click', () => {
    openPicker('Account', accounts.map(a => a.name), name, (val) => {
      balancesState.accountName = val;
      renderBalancesSheet();
    });
  });

  $$('.sb-input').forEach(inp => {
    inp.addEventListener('change', busyGuard(async () => {
      const ym = inp.dataset.ym;
      const mIdx = Number(inp.dataset.midx);
      const val = parseAmount(inp.value);
      const current = getStartingBalance(name, yr, mIdx);
      if (isNaN(val)){ inp.value = current.toFixed(2); return; }
      if (Math.abs(val - current) < 0.005 && !anchorAt(name, ym)) return; // unchanged, nothing to pin
      await setAnchor(name, ym, val);
      toast(`Pinned ${monthName(mIdx, true)} start at ${fmt(val)}`);
      renderBalancesSheet();
    }));
    inp.addEventListener('focus', () => inp.select());
  });

  $$('.sb-unpin').forEach(b => b.addEventListener('click', busyGuard(async () => {
    const removed = await clearAnchor(name, b.dataset.ym);
    renderBalancesSheet();
    if (removed) toastAction('Unpinned — balance now follows transactions', 'Undo', async () => {
      await setAnchor(removed.account, removed.month, removed.amount);
      if ($('#sb-acct-pick')) renderBalancesSheet(); // only if the sheet is still showing
    });
  })));
}
