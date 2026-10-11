/* ============================================================
   manage.js — management sheets: accounts, categories, backup &
   restore, reset, about.

   v3.0:
   - Accounts can be CLOSED (kept for history, hidden from pickers and
     Home), MERGED into another account, or deleted only when nothing uses
     them. Deleting an in-use account used to silently drop its transactions
     from every balance. Names that transactions still reference but no
     account has ("missing" — e.g. a deleted card) can be recovered as
     closed accounts.
   - Closing an account whose history doesn't end at $0 offers to set the
     opening balance that makes it end at $0 (tracking usually began after
     the account already had money in it).
   - Per-category default accounts (Restaurants → your card) are managed in
     the Categories sheet.
   - Excel import/export removed — JSON backups are the one format.
   - Backup & Restore: save or share (Drive etc.) a JSON file; restore is
     all-or-nothing and takes an automatic snapshot first, so any restore
     can be rolled back.
   ============================================================ */

import { $, $$, APP_VERSION, DEFAULT_CATEGORIES, monthAbbr, alphaSort, alphaSortBy, today, uid, toast, esc, round2, fmt, busyGuard, downloadBlob, currentYm, JSON_ACCEPT } from './util.js';
import { state, STORES, dbPut, dbDel, dbClear, replaceAllData, loadState, saveFlags, exportData, saveSnapshot, listSnapshots } from './db.js';
import { invalidateMerchantCache, categoryRuleKey } from './merchants.js';
import { openSheet, closeSheet, openPicker } from './sheet.js';
import { balanceLatest, firstActivityMonth } from './effects.js';
import { migrateLegacyBalances, setAnchor, openBalancesSheet } from './balances.js';
import { screenInfo, WIDE_MIN } from './layout.js';      // NEW(v3.1)

const ACCOUNT_TYPES = ['Checking','Savings','Credit Card','Loan'];
const bulletCls = (type) => type === 'Credit Card' ? 'cc' : (type === 'Loan' ? 'loan' : 'checking');

/* ─── Account references ─────────────────────────── */
function accountRefs(name){
  return {
    txns: state.transactions.filter(t => t.account === name || t.fromAccount === name).length,
    bills: state.bills.filter(b => b.account === name || b.fromAccount === name || b.linkedAccount === name).length,
    plans: state.debtPlans.filter(d => d.account === name).length,
    goals: state.goals.filter(g => g.account === name).length,
    anchors: state.balanceAnchors.filter(a => a.account === name).length
  };
}
function refsText(r){
  const parts = [];
  if (r.txns) parts.push(`${r.txns} transaction${r.txns === 1 ? '' : 's'}`);
  if (r.bills) parts.push(`${r.bills} bill${r.bills === 1 ? '' : 's'}`);
  if (r.plans) parts.push(`a debt plan`);
  if (r.goals) parts.push(`${r.goals} goal${r.goals === 1 ? '' : 's'}`);
  return parts.join(', ') || 'nothing';
}

// Names referenced anywhere that have no account record — a deleted
// account's history (balances can't count it without a type).
export function missingAccounts(){
  const known = new Set(state.accounts.map(a => a.name));
  const counts = {};
  const note = (n) => { if (n && !known.has(n)) counts[n] = (counts[n] || 0) + 1; };
  for (const t of state.transactions){ note(t.account); note(t.fromAccount); }
  for (const b of state.bills){ note(b.account); note(b.fromAccount); note(b.linkedAccount); }
  for (const d of state.debtPlans) note(d.account);
  for (const g of state.goals) note(g.account);
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
}

// Best guess at a missing account's type, from how its transactions use it.
function inferAccountType(name){
  const score = { Checking:0, 'Credit Card':0, Loan:0 };
  for (const t of state.transactions){
    if (t.fromAccount === name && ['Transfer','CC Payment','Loan Payment'].includes(t.type)) score.Checking += 2;
    if (t.account === name && t.type === 'Transfer') score.Checking += 2;
    if (t.account === name && t.type === 'CC Payment') score['Credit Card'] += 3;
    if ((t.account === name || t.fromAccount === name) && t.type === 'Balance Transfer') score['Credit Card'] += 3;
    if (t.account === name && t.type === 'Loan Payment') score.Loan += 3;
    if (t.account === name && t.type === 'Income') score.Checking += 1;
  }
  const [best, pts] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return pts > 0 ? best : 'Checking';
}

// Point every reference at a different account name — shared by rename and
// merge. Returns the number of records touched.
async function repointAccount(oldName, newName, { moveAnchors = true } = {}){
  let touched = 0;
  for (const t of state.transactions){
    let changed = false;
    if (t.account === oldName){ t.account = newName; changed = true; }
    if (t.fromAccount === oldName){ t.fromAccount = newName; changed = true; }
    if (changed){ await dbPut('transactions', t); touched++; }
  }
  for (const b of state.bills){
    let changed = false;
    if (b.account === oldName){ b.account = newName; changed = true; }
    if (b.fromAccount === oldName){ b.fromAccount = newName; changed = true; }
    if (b.linkedAccount === oldName){ b.linkedAccount = newName; changed = true; }
    if (changed){ await dbPut('bills', b); touched++; }
  }
  for (const dp of state.debtPlans){
    if (dp.account === oldName){ dp.account = newName; await dbPut('debtPlans', dp); touched++; }
  }
  for (const g of state.goals){
    if (g.account === oldName){ g.account = newName; await dbPut('goals', g); touched++; }
  }
  for (const a of [...state.balanceAnchors]){
    if (a.account !== oldName) continue;
    if (moveAnchors){ a.account = newName; await dbPut('balanceAnchors', a); }
    else { await dbDel('balanceAnchors', a.id); state.balanceAnchors = state.balanceAnchors.filter(x => x.id !== a.id); }
    touched++;
  }
  // FIX(v2.10.2): Real Available config keys on names too.
  const ra = state.flags.realAvailCards || [];
  let flagsChanged = false;
  if (ra.includes(oldName)){
    state.flags.realAvailCards = [...new Set(ra.map(n => n === oldName ? newName : n))];
    flagsChanged = true; touched++;
  }
  // NEW(v3.0): category default accounts too.
  const rules = state.flags.categoryAccounts || {};
  for (const k of Object.keys(rules)) if (rules[k] === oldName){ rules[k] = newName; flagsChanged = true; touched++; }
  if (flagsChanged) await saveFlags();
  invalidateMerchantCache();
  return touched;
}

/* ─── Accounts ─────────────────────────── */
export function openAccountsSheet(){
  const open = state.accounts.filter(a => a.active);
  const closed = state.accounts.filter(a => !a.active);
  const missing = missingAccounts();
  const row = (a) => `
    <div class="menu-item" style="padding:14px;margin-bottom:6px;">
      <span class="l">
        <span class="acct-bullet ${bulletCls(a.type)}" style="margin-right:4px;"></span>
        <div>
          <div style="font-size:14px;font-weight:500;">${esc(a.name)}</div>
          <div class="muted small">${esc(a.type)}${a.active ? '' : ' · closed' + (a.closedAt ? ' ' + esc(a.closedAt) : '')}</div>
        </div>
      </span>
      <button class="btn ghost a-edit" data-id="${esc(a.id)}" style="width:auto;padding:7px 12px;font-size:12px;">Edit</button>
    </div>`;
  $('#sheetBody').innerHTML = `
    <h2>Accounts</h2>
    ${open.map(row).join('') || '<div class="muted small" style="margin-bottom:10px;">No open accounts.</div>'}
    <button class="btn" id="a-add" style="margin-top:6px;">+ Add Account</button>
    ${closed.length ? `
      <div class="section-label">Closed · kept for history</div>
      ${closed.map(row).join('')}` : ''}
    ${missing.length ? `
      <div class="section-label">Missing · deleted but still in your history</div>
      <div class="muted small" style="margin-bottom:8px;line-height:1.5;">These names appear on transactions or bills but have no account, so balances can't count them. Recover one as a closed account to put its history back.</div>
      ${missing.map(m => `
        <div class="menu-item" style="padding:14px;margin-bottom:6px;">
          <span class="l"><div>
            <div style="font-size:14px;font-weight:500;">${esc(m.name)}</div>
            <div class="muted small">${m.n} reference${m.n === 1 ? '' : 's'}</div>
          </div></span>
          <button class="btn secondary a-recover" data-name="${esc(m.name)}" style="width:auto;padding:7px 12px;font-size:12px;">Recover</button>
        </div>`).join('')}` : ''}
  `;
  openSheet();
  $$('.a-edit').forEach(b => b.addEventListener('click', () => editAccount(b.dataset.id)));
  $('#a-add').addEventListener('click', () => editAccount(null));
  $$('.a-recover').forEach(b => b.addEventListener('click', () => recoverAccount(b.dataset.name)));
}

/* FIX(v1.2): renames cascade through every store that keys on the name.
   NEW(v3.0): Close / Reopen / Merge, and delete only when unused. */
function editAccount(id){
  const existing = id ? state.accounts.find(x => x.id === id) : null;
  const f = {
    name: existing?.name || '',
    type: existing?.type || 'Checking',
    notes: existing?.notes || ''
  };

  function render(){
    $('#sheetBody').innerHTML = `
      <h2>${id ? 'Edit' : 'New'} Account</h2>
      ${existing && !existing.active ? `<div class="muted small" style="margin-bottom:12px;">Closed${existing.closedAt ? ' ' + esc(existing.closedAt) : ''} — kept for history, hidden from pickers and Home.</div>` : ''}
      <div class="field"><label>Name</label><input class="input" id="ae-name" value="${esc(f.name)}" /></div>
      <div class="field">
        <label>Type</label>
        <button class="input picker-btn" id="ae-type" type="button">
          <span class="picker-val">${esc(f.type)}</span>
          <span class="picker-chev">▾</span>
        </button>
      </div>
      <div class="field"><label>Notes</label><input class="input" id="ae-notes" value="${esc(f.notes)}" /></div>
      <button class="btn" id="ae-save">Save</button>
      ${existing ? `
        ${existing.active
          ? '<button class="btn secondary" id="ae-close" style="margin-top:10px;">Close account…</button>'
          : '<button class="btn secondary" id="ae-reopen" style="margin-top:10px;">Reopen account</button>'}
        <button class="btn ghost" id="ae-balances" style="margin-top:10px;">Opening balance…</button>
        <button class="btn danger" id="ae-del" style="margin-top:10px;">Delete…</button>` : ''}
      <button class="btn ghost" id="ae-back" style="margin-top:10px;">Back</button>
    `;
    $('#ae-name').addEventListener('input', e => f.name = e.target.value);
    $('#ae-notes').addEventListener('input', e => f.notes = e.target.value);
    $('#ae-type').addEventListener('click', () => {
      openPicker('Account Type', ACCOUNT_TYPES, f.type, (val) => {
        f.type = val;
        render();
      });
    });
    $('#ae-save').addEventListener('click', save);
    $('#ae-close')?.addEventListener('click', () => openCloseAccountSheet(existing));
    $('#ae-reopen')?.addEventListener('click', busyGuard(async () => {
      existing.active = true;
      delete existing.closedAt;
      await dbPut('accounts', existing);
      toast(`${existing.name} reopened`);
      openAccountsSheet();
    }));
    $('#ae-balances')?.addEventListener('click', () => openBalancesSheet(existing.name));
    $('#ae-del')?.addEventListener('click', () => openDeleteAccountSheet(existing));
    $('#ae-back').addEventListener('click', openAccountsSheet);
  }

  const save = busyGuard(async () => {
    const newName = f.name.trim();
    if (!newName) { toast('Name required'); return; }
    const oldName = existing?.name || null;
    const clash = state.accounts.find(x => x.name === newName && x.id !== (id || ''));
    if (clash){ toast('An account with that name already exists'); return; }
    if (existing && existing.type !== f.type && accountRefs(existing.name).txns){
      if (!confirm(`Change ${existing.name} from ${existing.type} to ${f.type}?\n\nIts transactions will count the other way — e.g. an expense lowers a checking balance but raises a card's balance owed.`)) return;
    }

    const obj = {
      ...(existing || {}),
      id: id || uid(),
      name: newName,
      type: f.type,
      active: existing ? existing.active : true,
      notes: f.notes.trim(),
      order: existing?.order ?? state.accounts.length
    };
    await dbPut('accounts', obj);
    const i = state.accounts.findIndex(x => x.id === obj.id);
    if (i >= 0) state.accounts[i] = obj; else state.accounts.push(obj);
    state.accounts.sort(alphaSortBy('name'));

    if (oldName && oldName !== newName){
      const touched = await repointAccount(oldName, newName);
      toast(touched ? `Saved · updated ${touched} linked record${touched===1?'':'s'}` : 'Saved');
    } else toast('Saved');
    openAccountsSheet();
  });

  render();
}

/* ── NEW(v3.0): close an account ───────────────────────────────────── */
function openCloseAccountSheet(acct){
  const bal = balanceLatest(acct.name);
  const zero = Math.abs(bal) < 0.005;
  const isDebt = acct.type === 'Credit Card' || acct.type === 'Loan';
  $('#sheetBody').innerHTML = `
    <h2>Close ${esc(acct.name)}</h2>
    <div class="muted small" style="margin-bottom:14px;line-height:1.55;">
      A closed account keeps all of its history (reports, past months, search) but disappears from pickers, Home, and Real Available.
    </div>
    ${zero ? `
      <div class="debt-good" style="margin-bottom:14px;">Balance is $0.00 — ready to close.</div>
      <button class="btn" id="cl-close">Close account</button>
    ` : `
      <div class="card" style="margin-bottom:14px;">
        <div class="muted small">Its history currently ends at</div>
        <div class="mono" style="font-size:22px;margin-top:4px;">${fmt(bal)}${isDebt ? ' owed' : ''}</div>
        <div class="muted small" style="margin-top:8px;line-height:1.5;">
          A closed account should end at $0. If it already had ${isDebt ? 'a balance' : 'money in it'} when you started tracking, the missing piece is its <b>opening balance</b>.
        </div>
      </div>
      <button class="btn" id="cl-fix">Set opening balance so it ends at $0</button>
      <button class="btn secondary" id="cl-close" style="margin-top:10px;">Close anyway (keep ${fmt(bal)})</button>
    `}
    <button class="btn ghost" id="cl-back" style="margin-top:10px;">Back</button>
  `;
  openSheet();
  const doClose = async () => {
    acct.active = false;
    acct.closedAt = today();
    await dbPut('accounts', acct);
    // A closed card can't stay in the Real Available deduction.
    if ((state.flags.realAvailCards || []).includes(acct.name)){
      state.flags.realAvailCards = state.flags.realAvailCards.filter(n => n !== acct.name);
      await saveFlags();
    }
  };
  $('#cl-close').addEventListener('click', busyGuard(async () => {
    await doClose();
    toast(`${acct.name} closed`);
    openAccountsSheet();
  }));
  $('#cl-fix')?.addEventListener('click', busyGuard(async () => {
    await zeroOutWithOpening(acct.name);
    await doClose();
    toast(`Opening balance set · ${acct.name} closed at $0.00`);
    openAccountsSheet();
  }));
  $('#cl-back').addEventListener('click', () => editAccount(acct.id));
}

// Adjust (or create) the account's EARLIEST pinned opening so its history
// ends at exactly $0.
async function zeroOutWithOpening(name){
  const bal = balanceLatest(name);
  const pins = state.balanceAnchors.filter(a => a.account === name).sort((a, b) => a.month.localeCompare(b.month));
  const first = pins[0];
  const month = first ? first.month : (firstActivityMonth(name) || currentYm());
  await setAnchor(name, month, round2((first ? first.amount : 0) - bal));
}

/* ── NEW(v3.0): delete — only when unused; otherwise close or merge ──── */
function openDeleteAccountSheet(acct){
  const refs = accountRefs(acct.name);
  if (!refs.txns && !refs.bills && !refs.plans && !refs.goals){
    if (!confirm(`Delete ${acct.name}? Nothing uses it.`)) return;
    (async () => {
      for (const a of state.balanceAnchors.filter(x => x.account === acct.name)) await dbDel('balanceAnchors', a.id);
      state.balanceAnchors = state.balanceAnchors.filter(x => x.account !== acct.name);
      await dbDel('accounts', acct.id);
      state.accounts = state.accounts.filter(x => x.id !== acct.id);
      toast('Deleted');
      openAccountsSheet();
    })();
    return;
  }
  const others = state.accounts.filter(a => a.id !== acct.id);
  $('#sheetBody').innerHTML = `
    <h2>Delete ${esc(acct.name)}?</h2>
    <div class="card" style="margin-bottom:14px;line-height:1.55;">
      ${esc(acct.name)} is used by <b>${refsText(refs)}</b>. Deleting it outright would drop all of that from every balance.
    </div>
    <button class="btn" id="dl-close">${acct.active ? 'Close it instead (keeps history)' : 'Keep it closed'}</button>
    ${others.length ? `<button class="btn secondary" id="dl-merge" style="margin-top:10px;">Move everything to another account…</button>
    <div class="muted small" style="margin:8px 2px 0;line-height:1.5;">Merge when these transactions really belong to another account (e.g. a duplicate). The other account's balance will include them.</div>` : ''}
    <button class="btn ghost" id="dl-back" style="margin-top:12px;">Back</button>
  `;
  openSheet();
  $('#dl-close').addEventListener('click', () => acct.active ? openCloseAccountSheet(acct) : openAccountsSheet());
  $('#dl-merge')?.addEventListener('click', () => {
    openPicker(`Move ${acct.name}'s history to…`, others.map(a => a.name), null, busyGuard(async (target) => {
      if (!confirm(`Move ${refsText(refs)} from ${acct.name} to ${target}, then delete ${acct.name}?`)) { openDeleteAccountSheet(acct); return; }
      const touched = await repointAccount(acct.name, target, { moveAnchors: false });
      await dbDel('accounts', acct.id);
      state.accounts = state.accounts.filter(x => x.id !== acct.id);
      toast(`Moved ${touched} record${touched === 1 ? '' : 's'} to ${target} · ${acct.name} deleted`);
      openAccountsSheet();
    }));
  });
  $('#dl-back').addEventListener('click', () => editAccount(acct.id));
}

/* ── NEW(v3.0): recover a missing (deleted-but-referenced) account ───── */
function recoverAccount(name){
  const f = { type: inferAccountType(name) };
  const render = () => {
    $('#sheetBody').innerHTML = `
      <h2>Recover ${esc(name)}</h2>
      <div class="muted small" style="margin-bottom:14px;line-height:1.55;">
        Re-creates the account as <b>closed</b>, so its transactions count toward balances again (and transfers into or out of it balance on both sides).
      </div>
      <div class="field">
        <label>Account type <span class="muted small">(guessed from its transactions)</span></label>
        <button class="input picker-btn" id="rv-type" type="button">
          <span class="picker-val">${esc(f.type)}</span><span class="picker-chev">▾</span>
        </button>
      </div>
      <button class="btn" id="rv-go">Recover as closed account</button>
      <button class="btn ghost" id="rv-back" style="margin-top:10px;">Back</button>
    `;
    $('#rv-type').addEventListener('click', () => openPicker('Account Type', ACCOUNT_TYPES, f.type, (v) => { f.type = v; render(); }));
    $('#rv-go').addEventListener('click', busyGuard(async () => {
      const acct = { id: uid(), name, type: f.type, active: true, notes: 'Recovered in v3.0', order: state.accounts.length };
      await dbPut('accounts', acct);
      state.accounts.push(acct);
      state.accounts.sort(alphaSortBy('name'));
      openCloseAccountSheet(acct);   // same balance check as any close
    }));
    $('#rv-back').addEventListener('click', openAccountsSheet);
  };
  render();
  openSheet();
}

/* ─── Categories ─────────────────────────── */
const CAT_TYPES = [
  ['Expense','Expense'], ['Income','Income'], ['Refund','Refund'], ['Investment','Investment'],
  ['CCPayment','CC Payment'], ['LoanPayment','Loan Payment'], ['Transfer','Transfer'], ['BalanceTransfer','Balance Transfer']
];
const typeOfKey = Object.fromEntries(CAT_TYPES);
// Category lists whose transactions pick an account freely — the ones a
// default account makes sense for.
const RULE_KEYS = new Set(['Expense','Income','Refund']);

export function openCategoriesSheet(){
  const rules = state.flags.categoryAccounts || {};
  $('#sheetBody').innerHTML = `
    <h2>Categories</h2>
    <div class="muted small" style="margin-bottom:14px;line-height:1.5;">
      Shown alphabetically everywhere. <b>→ account</b> sets a default: picking that category on the Add form switches to that account.
    </div>
    ${CAT_TYPES.map(([k, label]) => {
      const list = (state.categories[k]||[]).slice().sort(alphaSort);
      const defaults = DEFAULT_CATEGORIES[k] || [];
      const isEmpty = list.length === 0;
      return `
      <div class="card" style="margin-bottom:10px;">
        <h3 class="card-title">${label}${isEmpty && defaults.length ? ` <button class="c-restore-one" data-type="${k}" style="background:none;border:1px solid var(--ember);color:var(--ember);padding:3px 8px;border-radius:999px;font-size:10px;letter-spacing:.08em;cursor:pointer;">Restore ${defaults.length}</button>` : ''}</h3>
        <div id="cat-${k}">
          ${list.map(c => {
            const rule = RULE_KEYS.has(k) ? rules[categoryRuleKey(typeOfKey[k], c)] : null;
            return `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 0;">
              <input class="input" data-cat-type="${k}" data-cat-old="${esc(c)}" value="${esc(c)}" style="flex:1;min-width:0;padding:8px 10px;font-size:13px;" />
              ${RULE_KEYS.has(k) ? `<button class="cat-rule ${rule ? 'on' : ''}" data-type="${k}" data-cat="${esc(c)}" type="button">${rule ? '→ ' + esc(rule) : '→ account'}</button>` : ''}
              <button class="btn danger c-del" data-type="${k}" data-cat="${esc(c)}" style="width:auto;padding:6px 10px;font-size:12px;">×</button>
            </div>`;
          }).join('')}
          ${isEmpty ? `<div class="muted small" style="padding:8px 0;font-style:italic;">No categories. Add one below or tap Restore ${defaults.length}.</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <input class="input c-new" data-type="${k}" placeholder="New category" style="flex:1;padding:8px 10px;font-size:13px;" />
          <button class="btn c-add" data-type="${k}" style="width:auto;padding:8px 14px;font-size:12.5px;">Add</button>
        </div>
      </div>
    `;
    }).join('')}
    <button class="btn ghost" id="c-save-all">Save Renames</button>
    <button class="btn ghost" id="c-restore-all" style="margin-top:8px;">Restore ALL defaults (merges missing)</button>
  `;
  openSheet();

  // NEW(v3.0): per-category default account.
  $$('.cat-rule').forEach(b => b.addEventListener('click', () => {
    const type = typeOfKey[b.dataset.type], cat = b.dataset.cat;
    const NONE = 'No default (use history)';
    const opts = [NONE, ...state.accounts.filter(a => a.active).map(a => a.name)];
    const key = categoryRuleKey(type, cat);
    openPicker(`${cat} → default account`, opts, (state.flags.categoryAccounts || {})[key] || NONE, async (val) => {
      const next = { ...(state.flags.categoryAccounts || {}) };
      if (val === NONE) delete next[key]; else next[key] = val;
      state.flags.categoryAccounts = next;
      await saveFlags();
      toast(val === NONE ? `${cat}: no default account` : `${cat} → ${val}`);
      openCategoriesSheet();
    });
  }));

  $$('.c-add').forEach(b => b.addEventListener('click', async () => {
    const t = b.dataset.type;
    const inp = b.parentElement.querySelector('.c-new');
    const v = inp.value.trim();
    if (!v) return;
    if ((state.categories[t] || []).includes(v)){ toast(`"${v}" already exists`); return; }
    const list = [...(state.categories[t]||[]), v].sort(alphaSort);
    state.categories[t] = list;
    await dbPut('categories', { id:t, list });
    openCategoriesSheet();
  }));
  $$('.c-del').forEach(b => b.addEventListener('click', async () => {
    const t = b.dataset.type, c = b.dataset.cat;
    const txnType = typeOfKey[t];
    const used = state.transactions.filter(x => x.type === txnType && x.category === c);
    if (used.length === 0){
      if (!confirm(`Delete "${c}"?`)) return;
      state.categories[t] = state.categories[t].filter(x => x !== c);
      await dbPut('categories', { id:t, list:state.categories[t] });
      await renameCategoryRefs(t, c, null);
      openCategoriesSheet();
      return;
    }
    const others = (state.categories[t] || []).filter(x => x !== c);
    if (!others.length){
      toast(`"${c}" has ${used.length} transactions and there's no other ${txnType} category to move them to`);
      return;
    }
    if (!confirm(`"${c}" is used by ${used.length} transaction${used.length===1?'':'s'}.\n\nPick a category to move them to — this also merges any budget. Cancel to keep "${c}".`)) return;
    openPicker(`Move "${c}" transactions to…`, others, null, busyGuard(async (target) => {
      for (const x of used){
        x.category = target;
        await dbPut('transactions', x);
      }
      // Budgets: merge month-by-month into an existing target budget (same
      // year), otherwise relabel.
      for (const oldB of state.budgets.filter(bb => bb.type === t && bb.category === c)){
        const targetB = state.budgets.find(bb => bb.type === t && bb.category === target && bb.year === oldB.year);
        if (targetB){
          monthAbbr.forEach(m => targetB.amounts[m] = round2((targetB.amounts[m]||0) + (oldB.amounts[m]||0)));
          await dbPut('budgets', targetB);
          await dbDel('budgets', oldB.id);
          state.budgets = state.budgets.filter(bb => bb.id !== oldB.id);
        } else {
          oldB.category = target;
          await dbPut('budgets', oldB);
        }
      }
      state.categories[t] = state.categories[t].filter(x => x !== c);
      await dbPut('categories', { id:t, list:state.categories[t] });
      await renameCategoryRefs(t, c, target);
      invalidateMerchantCache();
      toast(`Moved ${used.length} to "${target}" · "${c}" deleted`);
      openCategoriesSheet();
    }));
  }));
  $$('.c-restore-one').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const t = b.dataset.type;
    const defaults = DEFAULT_CATEGORIES[t] || [];
    state.categories[t] = [...defaults].sort(alphaSort);
    await dbPut('categories', { id:t, list: state.categories[t] });
    toast(`Restored ${defaults.length} ${t} categories`);
    openCategoriesSheet();
  }));
  $('#c-restore-all').addEventListener('click', async () => {
    if (!confirm('Merge all default categories into the lists?\n\nExisting categories you\'ve customized will be kept. Missing defaults will be added.')) return;
    let added = 0;
    for (const [k, defaults] of Object.entries(DEFAULT_CATEGORIES)){
      const existing = new Set(state.categories[k] || []);
      const merged = [...existing];
      for (const d of defaults){
        if (!existing.has(d)){ merged.push(d); added++; }
      }
      state.categories[k] = merged.sort(alphaSort);
      await dbPut('categories', { id:k, list: state.categories[k] });
    }
    toast(added ? `Added ${added} missing categories` : 'Nothing to add — all defaults present');
    openCategoriesSheet();
  });
  // FIX(v1.2): renames cascade through transactions + budgets (+ v3.0:
  // default-account rules and refund budget links).
  $('#c-save-all').addEventListener('click', busyGuard(async () => {
    let cascaded = 0;
    for (const [k] of CAT_TYPES){
      const inputs = $$(`input[data-cat-type="${k}"]`);
      const renames = [];
      const list = [];
      for (const inp of inputs){
        const nv = inp.value.trim();
        if (!nv) continue;
        if (!list.includes(nv)) list.push(nv);   // FIX(v3.0): renaming onto an existing name merges, no duplicate
        const old = inp.dataset.catOld;
        if (old && old !== nv) renames.push([old, nv]);
      }
      state.categories[k] = list.sort(alphaSort);
      await dbPut('categories', { id:k, list: state.categories[k] });

      const txnType = typeOfKey[k];
      for (const [oldC, newC] of renames){
        for (const t of state.transactions){
          if (t.type === txnType && t.category === oldC){
            t.category = newC;
            await dbPut('transactions', t);
            cascaded++;
          }
        }
        for (const b of state.budgets){
          if (b.type === k && b.category === oldC){
            b.category = newC;
            await dbPut('budgets', b);
            cascaded++;
          }
        }
        cascaded += await renameCategoryRefs(k, oldC, newC);
      }
    }
    invalidateMerchantCache();
    toast(cascaded ? `Saved · updated ${cascaded} record${cascaded===1?'':'s'}` : 'Saved');
    openCategoriesSheet();
  }));
}

// NEW(v3.0): category names also live in default-account rules and in
// refunds' "gives back to budget" links. newName null = category deleted.
async function renameCategoryRefs(listKey, oldName, newName){
  let n = 0;
  const type = typeOfKey[listKey];
  const rules = { ...(state.flags.categoryAccounts || {}) };
  const oldKey = categoryRuleKey(type, oldName);
  if (rules[oldKey]){
    if (newName && !rules[categoryRuleKey(type, newName)]) rules[categoryRuleKey(type, newName)] = rules[oldKey];
    delete rules[oldKey];
    state.flags.categoryAccounts = rules;
    await saveFlags();
    n++;
  }
  if (listKey === 'Expense'){
    for (const t of state.transactions){
      if (t.type === 'Refund' && t.offsetCategory === oldName){
        if (newName) t.offsetCategory = newName; else delete t.offsetCategory;
        await dbPut('transactions', t);
        n++;
      }
    }
  }
  return n;
}

/* ─── Backup & Restore (JSON only) ─────────────────────────── */
/* NEW(v2.9.2): backup age tracking + nudge. */
export async function markBackedUp(){
  state.flags.lastBackupAt = Date.now();
  await saveFlags();
}

export function backupAgeLabel(){
  const last = state.flags.lastBackupAt;
  if (!last) return 'no backup yet';
  const days = Math.floor((Date.now() - last) / 86400000);
  if (days === 0) return 'backed up today';
  return `last backup ${days}d ago`;
}

export async function maybeBackupNudge(){
  if (!state.transactions.length) return;
  const last = state.flags.lastBackupAt || 0;
  const ageDays = (Date.now() - last) / 86400000;
  if (last && ageDays < 30) return;
  const lastNudge = state.flags.lastBackupNudge || 0;
  if (Date.now() - lastNudge < 7 * 86400000) return;
  state.flags.lastBackupNudge = Date.now();
  await saveFlags();
  setTimeout(() => toast(last
    ? `Backup is ${Math.floor(ageDays)} days old — More → Backup & Restore`
    : 'No backup yet — More → Backup & Restore'), 1400);
}

function backupFile(){
  const json = JSON.stringify(exportData(), null, 2);
  return { json, name: `ledger-backup-${today()}.json` };
}

export const backupJSON = busyGuard(async () => {
  const { json, name } = backupFile();
  downloadBlob(new Blob([json], { type:'application/json' }), name);
  await markBackedUp();
  toast('Backup saved');
});

// NEW(v3.0): hand the backup to the OS share sheet (Google Drive, email, …).
export function canShareBackup(){
  try {
    return typeof File !== 'undefined' && !!navigator.canShare &&
      navigator.canShare({ files: [new File(['{}'], 'x.json', { type:'application/json' })] });
  } catch(e){ return false; }
}
const shareBackup = busyGuard(async () => {
  const { json, name } = backupFile();
  try {
    await navigator.share({ files: [new File([json], name, { type:'application/json' })], title: name });
    await markBackedUp();
    toast('Backup shared');
  } catch(e){
    if (e && e.name === 'AbortError') return;     // user closed the share sheet
    console.warn('Share failed', e);
    toast('Sharing failed — saving the file instead');
    await backupJSON();
  }
});

// Validate + atomically replace everything with a backup's contents. A
// snapshot of the current data is taken first, so this can be undone.
async function applyBackup(data, reason){
  if (!data || !Array.isArray(data.accounts) || !Array.isArray(data.transactions)){
    throw new Error("That doesn't look like a Ledger backup");
  }
  await saveSnapshot(reason);
  const legacy = !Array.isArray(data.balanceAnchors);
  const cats = data.categories || {};
  await replaceAllData({
    accounts: data.accounts,
    categories: Object.keys(cats).map(k => ({ id:k, list: Array.isArray(cats[k]) ? cats[k] : [] })),
    budgets: data.budgets,
    transactions: data.transactions,
    networth: data.netWorth,
    debtPlans: data.debtPlans,
    bills: data.bills,
    goals: data.goals,                              // absent in v1 backups → empty
    balanceAnchors: legacy ? [] : data.balanceAnchors,
    startingBalances: legacy ? data.startingBalances : []
  });
  await loadState();
  // NEW(v2.10.2): backed-up flags ride along, merged over this device's.
  if (data.flags && typeof data.flags === 'object'){
    state.flags = { ...state.flags, ...data.flags, id:'flags' };
  }
  // Pre-v3 backups carry month-by-month starting balances — convert them
  // exactly the way a device upgrade does.
  if (legacy) await migrateLegacyBalances();
  else { state.flags.anchorsV3 = true; await saveFlags(); }
  invalidateMerchantCache();
}

export function restoreJSON(onRestored){
  const input = document.createElement('input');
  input.type = 'file';
  // Broad filter incl. octet-stream — Drive downloads and uppercase
  // extensions report unknown types (see util.js JSON_ACCEPT).
  input.accept = JSON_ACCEPT;
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); }
    catch { toast('Not a valid JSON file'); return; }
    if (!data || !Array.isArray(data.accounts) || !Array.isArray(data.transactions)){
      toast("Doesn't look like a Ledger backup");
      return;
    }
    const when = data.exportedAt ? ` from ${String(data.exportedAt).slice(0, 10)}` : '';
    if (!confirm(`Restore this backup${when}? (${data.transactions.length.toLocaleString()} transactions)\n\nIt REPLACES all current data on this device. A snapshot of the current data is kept, so you can roll back from More → Backup & Restore.`)) return;
    try {
      await applyBackup(data, 'Before restoring ' + file.name);
      if (typeof onRestored === 'function') onRestored();
      toast('Backup restored');
    } catch (e){
      console.error(e);
      toast('Restore failed — nothing was changed. ' + (e.message || ''));
    }
  };
  input.click();
}

export async function openBackupSheet(onChanged){
  const snaps = await listSnapshots();
  const share = canShareBackup();
  $('#sheetBody').innerHTML = `
    <h2>Backup &amp; Restore</h2>
    <div class="muted small" style="margin-bottom:14px;line-height:1.55;">
      Your ledger lives only on this device. A backup is one JSON file with everything in it — keep a recent one somewhere safe.
      <b>${esc(backupAgeLabel().replace(/^./, c => c.toUpperCase()))}.</b>
    </div>
    ${share ? `<button class="btn" id="bk-share">Share backup… <span class="muted small" style="font-weight:400;">(Drive, email)</span></button>` : ''}
    <button class="btn ${share ? 'secondary' : ''}" id="bk-save" style="${share ? 'margin-top:10px;' : ''}">Save backup file</button>
    <button class="btn ghost" id="bk-restore" style="margin-top:10px;">Restore from a backup file…</button>

    <div class="section-label">Automatic snapshots</div>
    <div class="muted small" style="margin-bottom:8px;line-height:1.5;">Taken on this device right before anything replaces your data. The newest 3 are kept.</div>
    ${snaps.length ? snaps.map(s => `
      <div class="rec-row">
        <div style="min-width:0;flex:1;">
          <div style="font-size:13.5px;font-weight:500;">${esc(s.reason || 'Snapshot')}</div>
          <div class="muted small">${esc(new Date(s.createdAt).toLocaleString())} · ${(s.txnCount || 0).toLocaleString()} transactions</div>
        </div>
        <button class="btn secondary bk-roll" data-id="${esc(s.id)}" style="width:auto;padding:8px 12px;font-size:12px;flex-shrink:0;">Roll back</button>
      </div>`).join('') : '<div class="muted small" style="font-style:italic;">None yet.</div>'}
  `;
  openSheet();
  const refresh = () => { if (typeof onChanged === 'function') onChanged(); };
  $('#bk-share')?.addEventListener('click', async () => { await shareBackup(); openBackupSheet(onChanged); });
  $('#bk-save').addEventListener('click', async () => { await backupJSON(); openBackupSheet(onChanged); });
  $('#bk-restore').addEventListener('click', () => restoreJSON(() => { closeSheet(); refresh(); }));
  $$('.bk-roll').forEach(b => b.addEventListener('click', busyGuard(async () => {
    const snap = snaps.find(s => s.id === b.dataset.id);
    if (!snap) return;
    if (!confirm(`Roll back to "${snap.reason}" (${new Date(snap.createdAt).toLocaleString()})?\n\nYour current data is snapshotted first, so this can be undone too.`)) return;
    try {
      await applyBackup(snap.data, 'Before rollback');
      closeSheet(); refresh();
      toast('Rolled back');
    } catch(e){
      console.error(e);
      toast('Rollback failed — nothing was changed');
    }
  })));
}

export async function resetData(){
  if (!confirm('Erase ALL data and start fresh? This cannot be undone.')) return;
  if (!confirm('Really? All transactions, accounts, settings, and snapshots will be deleted.')) return;
  for (const s of STORES) await dbClear(s);
  location.reload();
}

/* ─── About sheet ─────────────────────────── */
export function openAboutSheet(){
  const txns = state.transactions.length;
  const accts = state.accounts.length;
  const bills = state.bills.length;

  $('#sheetBody').innerHTML = `
    <h2>About</h2>

    <div class="about-brand">
      <div class="about-mark">Ledger<span style="color:var(--ember);">.</span></div>
      <div class="about-version">v${APP_VERSION}</div>
    </div>

    <div class="card" style="margin-bottom:14px;">
      <h3 class="card-title">Your data</h3>
      <div class="about-stats">
        <div class="about-stat"><div class="v">${txns.toLocaleString()}</div><div class="l">Transactions</div></div>
        <div class="about-stat"><div class="v">${accts}</div><div class="l">Accounts</div></div>
        <div class="about-stat"><div class="v">${bills}</div><div class="l">Bills</div></div>
      </div>
      <div class="muted small" style="margin-top:14px;line-height:1.55;">
        Everything stays on this device in IndexedDB. Nothing is sent anywhere. Your data is safe across app updates — keep a recent backup from More → Backup &amp; Restore.
      </div>
    </div>

    <div class="card" style="margin-bottom:14px;">
      <h3 class="card-title">This screen <span class="pill">live</span></h3>
      <div id="about-display">${displayRows()}</div>
      <div class="muted small" style="margin-top:10px;line-height:1.5;">Fold or unfold with this open to see both screens. The layout switches at ${WIDE_MIN}px wide.</div>
    </div>

    <button class="btn" id="about-update">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M3 12a9 9 0 0 1 15.5-6.2M21 4v5h-5M21 12a9 9 0 0 1-15.5 6.2M3 20v-5h5"/></svg>
      Check for updates
    </button>
    <div class="muted small" style="margin-top:10px;text-align:center;line-height:1.5;">
      Pulls the latest version from the server. Will reload the app. Your transactions, accounts, and settings are preserved.
    </div>

    <div class="about-footer">
      <div>Personal finance tracker PWA</div>
      <div>Multi-file ES modules · offline-first · on-device</div>
    </div>
  `;
  openSheet();
  $('#about-update').addEventListener('click', checkForUpdates);
  // Live: folding / unfolding / rotating updates the readout in place.
  const refresh = () => { const el = $('#about-display'); if (el) el.innerHTML = displayRows(); else window.removeEventListener('resize', refresh); };
  window.addEventListener('resize', refresh);
}

// NEW(v3.1): what the device reports — confirms the real CSS size of each
// Fold screen (Samsung "Screen zoom" changes it) before tuning layouts.
function displayRows(){
  const s = screenInfo();
  const row = (k, v) => `<div class="ds-row"><span>${k}</span><span class="mono">${esc(v)}</span></div>`;
  return row('Viewport (CSS px)', s.css) + row('Pixel ratio', String(s.dpr)) + row('Physical px', s.physical)
    + row('Screen', s.screen) + row('Orientation', s.orientation) + row('Layout', s.mode)
    + row('Posture', s.posture) + row('Installed app', s.standalone ? 'yes' : 'no (browser tab)');
}

async function checkForUpdates(){
  if (!confirm('Fetch the latest version from the server?\n\nThe app will reload. Your data is NOT affected.')) return;
  const btn = $('#about-update');
  if (btn){ btn.textContent = 'Updating…'; btn.disabled = true; }
  try {
    if ('serviceWorker' in navigator){
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if ('caches' in window){
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    setTimeout(() => {
      const sep = location.href.includes('?') ? '&' : '?';
      location.replace(location.href.split('#')[0].split('?')[0] + sep + '_upd=' + Date.now());
    }, 120);
  } catch (e) {
    console.error(e);
    toast('Update failed: ' + (e.message || 'unknown error'));
    if (btn){ btn.textContent = 'Check for updates'; btn.disabled = false; }
  }
}
