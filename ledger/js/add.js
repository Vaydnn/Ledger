/* ============================================================
   add.js — Add / Edit transaction form.

   v1.1.0 addition: merchant memory — as you type the description,
   we surface up to 5 matching past merchants. Tapping a suggestion
   fills the description AND auto-sets the best category + account
   based on historical usage.
   ============================================================ */

import { $, $$, today, uid, toast, parseAmount, esc, haptic } from './util.js';
import { state, dbPut } from './db.js';
import { openPicker, closeSheet } from './sheet.js';
import { navigate } from './app.js';
import { getMerchantSuggestions, lookupMerchant, invalidateMerchantCache } from './merchants.js';
import { cascadeForChange } from './balances.js';

// FIX(v2.9.1): the pre-selected account used to be a hardcoded personal
// account name in this public repo. It's now the account you've actually
// used most (among valid options for the current type) — same behavior on
// a live device, zero personal data in the code.
function mostUsedAccount(options){
  if (!options.length) return null;
  const usage = {};
  for (const t of state.transactions){
    if (t.account) usage[t.account] = (usage[t.account] || 0) + 1;
  }
  let best = options[0], max = -1;
  for (const o of options){
    const n = usage[o.name] || 0;
    if (n > max){ max = n; best = o; }
  }
  return best;
}

export const addForm = {
  type: 'Expense',
  date: today(),
  account: null,
  category: null,
  description: '',
  amount: '',
  fromAccount: null,
  editingId: null
};

export function renderAdd(){
  const v = $('#view-add');
  const types = ['Expense','Income','Refund','Investment','Transfer','CC Payment','Loan Payment','Balance Transfer'];
  const accts = state.accounts.filter(a => a.active);
  const checking = accts.filter(a => a.type === 'Checking' || a.type === 'Savings');
  const ccs = accts.filter(a => a.type === 'Credit Card');
  const loans = accts.filter(a => a.type === 'Loan');
  const cashOrDebt = accts.filter(a => a.type === 'Checking' || a.type === 'Savings' || a.type === 'Credit Card' || a.type === 'Loan');

  const catList = (() => {
    if (addForm.type === 'Expense') return state.categories.Expense;
    if (addForm.type === 'Income') return state.categories.Income;
    if (addForm.type === 'Refund') return state.categories.Refund || ['Purchase Refund','Return','Credit','Reimbursement','Cashback','Other Refund'];
    if (addForm.type === 'Investment') return state.categories.Investment;
    if (addForm.type === 'CC Payment') return state.categories.CCPayment;
    if (addForm.type === 'Loan Payment') return state.categories.LoanPayment || ['Loan Payment'];
    if (addForm.type === 'Transfer') return state.categories.Transfer;
    if (addForm.type === 'Balance Transfer') return state.categories.BalanceTransfer || ['Balance Transfer'];
    return [];
  })();

  let acctOptions = accts;
  if (addForm.type === 'Investment') acctOptions = checking;
  if (addForm.type === 'CC Payment') acctOptions = ccs;
  if (addForm.type === 'Loan Payment') acctOptions = loans;
  if (addForm.type === 'Transfer') acctOptions = checking;
  if (addForm.type === 'Balance Transfer') acctOptions = ccs;
  if (addForm.type === 'Refund') acctOptions = cashOrDebt;

  let fromOptions = [];
  if (addForm.type === 'Transfer') fromOptions = checking.filter(a => a.name !== addForm.account);
  if (addForm.type === 'CC Payment') fromOptions = checking;
  if (addForm.type === 'Loan Payment') fromOptions = checking;
  if (addForm.type === 'Balance Transfer') fromOptions = ccs.filter(a => a.name !== addForm.account);

  if (!addForm.account || !acctOptions.find(a => a.name === addForm.account)){
    addForm.account = mostUsedAccount(acctOptions)?.name || null;
  }
  if (!addForm.category || !catList.includes(addForm.category)){
    addForm.category = catList[0] || null;
  }
  if (fromOptions.length && (!addForm.fromAccount || !fromOptions.find(a => a.name === addForm.fromAccount))){
    addForm.fromAccount = fromOptions[0]?.name || null;
  }

  const accountLabel = (() => {
    if (addForm.type === 'Transfer') return 'To Account';
    if (addForm.type === 'CC Payment') return 'Card to Pay';
    if (addForm.type === 'Loan Payment') return 'Loan to Pay';
    if (addForm.type === 'Balance Transfer') return 'Destination Card';
    if (addForm.type === 'Refund') return 'Refund To';
    return 'Account';
  })();
  const fromLabel = (() => {
    if (addForm.type === 'Transfer') return 'From Account';
    if (addForm.type === 'CC Payment') return 'Pay From';
    if (addForm.type === 'Loan Payment') return 'Pay From';
    if (addForm.type === 'Balance Transfer') return 'Source Card';
    return 'From';
  })();

  // NEW(v2.9.2): one-tap category chips — your most-used categories for the
  // current type, so the highest-frequency action in the app skips the
  // picker sheet entirely. The picker stays for the long tail.
  const topCats = (() => {
    const counts = {};
    for (const t of state.transactions){
      if (t.type !== addForm.type || !t.category) continue;
      counts[t.category] = (counts[t.category] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([c]) => c)
      .filter(c => catList.includes(c))
      .slice(0, 6);
  })();

  v.innerHTML = `
    <div class="type-pills">
      ${types.map(t => `<button class="type-pill" data-type="${t}" aria-pressed="${addForm.type===t}">${t}</button>`).join('')}
    </div>

    <div class="field">
      <label>Amount</label>
      <input class="input amount" id="f-amount" type="text" inputmode="decimal" placeholder="0.00" value="${addForm.amount}" />
    </div>

    <div class="row-2">
      <div class="field">
        <label>Date</label>
        <input class="input" id="f-date" type="date" value="${addForm.date}" />
      </div>
      <div class="field">
        <label>Category</label>
        <button class="input picker-btn" id="f-cat" type="button">
          <span class="picker-val">${addForm.category || '—'}</span>
          <span class="picker-chev">▾</span>
        </button>
      </div>
    </div>

    ${topCats.length > 1 ? `
      <div class="cat-chips">
        ${topCats.map(c => `<button type="button" class="chip cat-chip" data-cat="${esc(c)}" aria-pressed="${addForm.category === c}">${esc(c)}</button>`).join('')}
      </div>
    ` : ''}

    <div class="field">
      <label>${accountLabel}</label>
      <button class="input picker-btn" id="f-acct" type="button">
        <span class="picker-val">${addForm.account || '—'}</span>
        <span class="picker-chev">▾</span>
      </button>
    </div>

    ${fromOptions.length ? `
      <div class="field">
        <label>${fromLabel}</label>
        <button class="input picker-btn" id="f-from" type="button">
          <span class="picker-val">${addForm.fromAccount || '—'}</span>
          <span class="picker-chev">▾</span>
        </button>
      </div>
    ` : ''}

    <div class="field" style="position:relative;">
      <label>Description <span class="muted small">(optional)</span></label>
      <input class="input" id="f-desc" type="text" autocomplete="off" placeholder="e.g. wingstop lunch" value="${esc(addForm.description)}" />
      <div id="f-suggest" class="suggest" aria-hidden="true"></div>
    </div>

    <button class="btn" id="f-save">${addForm.editingId ? 'Update' : 'Save'} Transaction</button>
    ${addForm.editingId ? '<button class="btn ghost" id="f-cancel" style="margin-top:10px;">Cancel Edit</button>' : ''}
  `;

  // Type pills
  $$('.type-pill', v).forEach(p => p.addEventListener('click', () => {
    addForm.type = p.dataset.type;
    addForm.category = null; addForm.fromAccount = null;
    renderAdd();
  }));
  $('#f-amount', v).addEventListener('input', e => addForm.amount = e.target.value);
  $('#f-date', v).addEventListener('input', e => addForm.date = e.target.value);

  // NEW(v2.9.2): category chips — set and re-render (state in addForm
  // survives the re-render, same as the pickers).
  $$('.cat-chip', v).forEach(ch => ch.addEventListener('click', () => {
    addForm.category = ch.dataset.cat;
    renderAdd();
  }));

  // Pickers — CLOSE the sheet explicitly because these are opened from a
  // view (not from inside a sheet), so the sheet backdrop must go away
  // after selection. (See sheet.js header for the full rationale.)
  $('#f-cat', v).addEventListener('click', () => openPicker('Category', catList, addForm.category, (val) => {
    closeSheet();
    addForm.category = val;
    renderAdd();
  }));
  $('#f-acct', v).addEventListener('click', () => openPicker(accountLabel, acctOptions.map(a => a.name), addForm.account, (val) => {
    closeSheet();
    addForm.account = val;
    renderAdd();
  }));
  if ($('#f-from', v)) $('#f-from', v).addEventListener('click', () => openPicker(fromLabel, fromOptions.map(a => a.name), addForm.fromAccount, (val) => {
    closeSheet();
    addForm.fromAccount = val;
    renderAdd();
  }));

  // Description + merchant autocomplete
  const descInput = $('#f-desc', v);
  const suggest = $('#f-suggest', v);
  const updateSuggestions = () => {
    const q = descInput.value;
    const hits = getMerchantSuggestions(q, 5);
    if (hits.length === 0){ suggest.innerHTML = ''; suggest.classList.remove('open'); return; }
    suggest.innerHTML = hits.map(h => {
      const meta = [h.category, h.account].filter(Boolean).join(' · ');
      // FIX(v1.2): merchant display/meta are user-entered strings — escape before innerHTML.
      return `
        <button class="suggest-row" type="button" data-desc="${esc(h.display)}">
          <span class="suggest-name">${esc(h.display)}</span>
          <span class="suggest-meta">${esc(meta)}</span>
          <span class="suggest-count">×${h.count}</span>
        </button>
      `;
    }).join('');
    suggest.classList.add('open');
    $$('.suggest-row', suggest).forEach(r => r.addEventListener('mousedown', (e) => {
      // mousedown (not click) so the input blur doesn't race with the selection
      e.preventDefault();
      const picked = r.dataset.desc;
      const m = lookupMerchant(picked);
      addForm.description = picked;
      descInput.value = picked;
      if (m){
        // Only auto-fill category if it's valid for the current type
        if (m.category && catList.includes(m.category)) addForm.category = m.category;
        // Only auto-fill account if it's a valid option for the current type
        if (m.account && acctOptions.find(a => a.name === m.account)) addForm.account = m.account;
      }
      suggest.classList.remove('open');
      renderAdd();
    }));
  };
  descInput.addEventListener('input', e => {
    addForm.description = e.target.value;
    updateSuggestions();
  });
  descInput.addEventListener('blur', () => {
    // Delay hide so a click on a suggestion registers
    setTimeout(() => suggest.classList.remove('open'), 150);
  });
  descInput.addEventListener('focus', updateSuggestions);

  $('#f-save', v).addEventListener('click', saveTransaction);
  if ($('#f-cancel', v)) $('#f-cancel', v).addEventListener('click', cancelEdit);
}

async function saveTransaction(){
  // FIX(v1.2): parseFloat silently mangled formatted input ('1,234.56' → 1,
  // '$12.50' → NaN) and stored sub-cent amounts (the live backup contained
  // 15.876). parseAmount strips $/commas/spaces, rounds to cents, and rejects
  // anything that still isn't a number.
  const amt = parseAmount(addForm.amount);
  if (isNaN(amt) || amt <= 0) { toast('Enter a valid amount'); return; }
  if (!addForm.account) { toast('Pick an account'); return; }
  const needsFrom = ['Transfer','CC Payment','Loan Payment','Balance Transfer'].includes(addForm.type);
  if (needsFrom && !addForm.fromAccount) { toast('Pick a source account'); return; }

  const txn = {
    id: addForm.editingId || uid(),
    date: addForm.date,
    type: addForm.type,
    account: addForm.account,
    category: addForm.category,
    description: addForm.description.trim(),
    amount: amt,
    fromAccount: needsFrom ? addForm.fromAccount : null
  };
  // Snapshot the pre-edit state BEFORE we overwrite state.transactions —
  // cascadeForChange needs both old and new to handle date/account moves.
  const existing = addForm.editingId ? state.transactions.find(t => t.id === txn.id) : null;
  const oldSnapshot = existing ? { ...existing } : null;
  await dbPut('transactions', txn);
  const idx = state.transactions.findIndex(t => t.id === txn.id);
  if (idx >= 0) state.transactions[idx] = txn;
  else state.transactions.push(txn);
  state.transactions.sort((a,b) => b.date.localeCompare(a.date));
  await cascadeForChange(oldSnapshot, txn);
  invalidateMerchantCache();

  const wasEdit = !!addForm.editingId;
  haptic(15); /* NEW(v2.2) */
  toast(wasEdit ? 'Transaction updated' : 'Transaction saved');

  // Keep type + date for fast repeat entry, reset the rest
  const lastType = addForm.type;
  const lastDate = addForm.date;
  Object.assign(addForm, { type:lastType, date:lastDate, account:null, category:null, description:'', amount:'', fromAccount:null, editingId:null });

  // FIX(v1.2): finishing an edit (started from Activity) bounced to Home,
  // losing the user's place. Edits now return to Activity; fresh adds go Home.
  navigate(wasEdit ? 'txns' : 'home');
}

function cancelEdit(){
  Object.assign(addForm, { type:'Expense', date:today(), account:null, category:null, description:'', amount:'', fromAccount:null, editingId:null });
  navigate('txns');
}

export function startEdit(txn){
  Object.assign(addForm, {
    type: txn.type, date: txn.date, account: txn.account, category: txn.category,
    description: String(txn.description ?? ''), /* FIX(v2.1): non-string descriptions */ amount: String(txn.amount), fromAccount: txn.fromAccount,
    editingId: txn.id
  });
  navigate('add');
}
