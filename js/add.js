/* ============================================================
   add.js — Add / Edit transaction form.

   v1.1.0: merchant memory — as you type the description, up to 5 matching
   past merchants; tapping one fills the description AND the best category
   + account from history.

   v3.0:
   - Per-category default account: picking a category switches the account
     to your rule for it (Restaurants → your Citi card) or, failing a rule,
     to a clear recent habit — unless you already chose an account yourself.
     Picking a different account offers "Always use X for Restaurants?".
   - Save is double-tap safe and refuses a blank date.
   - Refunds carry an optional "counts against budget" category.
   - A saved transaction that looks like an unpaid bill offers to mark it paid
     (logging rent by hand used to leave the bill unpaid, so Real Available
     subtracted it twice).
   ============================================================ */

import { $, $$, today, uid, toast, toastAction, parseAmount, esc, haptic, busyGuard } from './util.js';
import { state, dbPut, saveFlags } from './db.js';
import { openPicker, closeSheet } from './sheet.js';
import { navigate } from './app.js';
import { getMerchantSuggestions, lookupMerchant, invalidateMerchantCache, preferredAccountFor, categoryRule, categoryRuleKey, refundBudgetCategory } from './merchants.js';
import { findMatchingBill, markBillPaidWith } from './bills.js';

// FIX(v2.9.1): the pre-selected account is the one you've actually used most
// (among valid options for the current type) — no personal names in code.
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

const BLANK = {
  type: 'Expense', date: '', account: null, category: null, description: '', amount: '',
  fromAccount: null, editingId: null,
  accountTouched: false,   // NEW(v3.0): the user picked the account themselves
  accountSource: null,     // NEW(v3.0): 'rule' | 'habit' when a category default chose it
  offsetCategory: null     // NEW(v3.0): Refund → budget category (null = auto, 'none' = opt out)
};
export const addForm = { ...BLANK, date: today() };

// NEW(v3.0): one place that resets the form (quick-log, reconcile prefill,
// cancel, after save). `over` sets fields; date defaults to today.
export function resetAddForm(over = {}){
  Object.assign(addForm, BLANK, { date: today() }, over);
}

// v3.1: closed / deleted accounts (offered only while editing their own
// transactions) are labeled so it's clear why they appear.
function acctStatus(name){
  if (!name) return '';
  const a = state.accounts.find(x => x.name === name);
  return !a ? 'deleted' : (a.active ? '' : 'closed');
}
const pickerOpt = (a) => { const s = acctStatus(a.name); return s ? { value: a.name, note: s } : a.name; };
const closedTag = (name) => { const s = acctStatus(name); return s ? ` <span class="picker-note">${s}</span>` : ''; };

// Apply the category's default account unless the user chose one already.
function applyCategoryDefault(acctOptions){
  if (addForm.accountTouched || !addForm.category) return;
  const pref = preferredAccountFor(addForm.type, addForm.category, acctOptions.map(a => a.name));
  if (pref){ addForm.account = pref.account; addForm.accountSource = pref.source; }
  else addForm.accountSource = null;
}

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

  // FIX(v3.1): editing a transaction on a CLOSED (or deleted) account. Only
  // open accounts are offered, so the form used to silently swap the
  // account for your most-used one — and Save wrote it. The record's own
  // accounts are always offered while editing it (same type).
  const original = addForm.editingId ? state.transactions.find(t => t.id === addForm.editingId) : null;
  if (original && original.type === addForm.type){
    const keep = (list, name) => {
      if (!name || list.find(a => a.name === name)) return list;
      return [...list, state.accounts.find(a => a.name === name) || { name, type: '', active: false, missing: true }];
    };
    acctOptions = keep(acctOptions, original.account);
    if (fromOptions.length || original.fromAccount) fromOptions = keep(fromOptions, original.fromAccount);
  }

  if (!addForm.category || !catList.includes(addForm.category)){
    addForm.category = catList[0] || null;
  }
  if (!addForm.account || !acctOptions.find(a => a.name === addForm.account)){
    addForm.accountTouched = false;
    addForm.account = mostUsedAccount(acctOptions)?.name || null;
    applyCategoryDefault(acctOptions);
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

  // NEW(v2.9.2): one-tap chips for your most-used categories of this type.
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

  // NEW(v3.0): why the account is what it is (only when a default chose it).
  const acctHint = addForm.accountSource && !addForm.accountTouched
    ? `<div class="field-hint">${addForm.accountSource === 'rule' ? 'Your default' : 'Your usual card'} for ${esc(addForm.category)}</div>`
    : '';

  // NEW(v3.0): refund → budget category.
  const refundOffset = (() => {
    if (addForm.type !== 'Refund') return '';
    let label;
    if (addForm.offsetCategory === 'none') label = "Doesn't count against a budget";
    else if (addForm.offsetCategory) label = addForm.offsetCategory;
    else {
      const guess = refundBudgetCategory({ type:'Refund', description: addForm.description });
      label = guess ? `${guess} (from merchant)` : 'Auto — from merchant';
    }
    return `
      <div class="field">
        <label>Gives back to budget <span class="muted small">(optional)</span></label>
        <button class="input picker-btn" id="f-offset" type="button">
          <span class="picker-val">${esc(label)}</span>
          <span class="picker-chev">▾</span>
        </button>
      </div>`;
  })();

  v.innerHTML = `
    <div class="type-pills">
      ${types.map(t => `<button class="type-pill" data-type="${t}" aria-pressed="${addForm.type===t}">${t}</button>`).join('')}
    </div>

    <div class="field">
      <label>Amount</label>
      <input class="input amount" id="f-amount" type="text" inputmode="decimal" placeholder="0.00" value="${esc(addForm.amount)}" />
    </div>

    <div class="row-2">
      <div class="field">
        <label>Date</label>
        <input class="input" id="f-date" type="date" value="${esc(addForm.date)}" />
      </div>
      <div class="field">
        <label>Category</label>
        <button class="input picker-btn" id="f-cat" type="button">
          <span class="picker-val">${esc(addForm.category || '—')}</span>
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
        <span class="picker-val">${esc(addForm.account || '—')}${closedTag(addForm.account)}</span>
        <span class="picker-chev">▾</span>
      </button>
      ${acctHint}
    </div>

    ${fromOptions.length ? `
      <div class="field">
        <label>${fromLabel}</label>
        <button class="input picker-btn" id="f-from" type="button">
          <span class="picker-val">${esc(addForm.fromAccount || '—')}${closedTag(addForm.fromAccount)}</span>
          <span class="picker-chev">▾</span>
        </button>
      </div>
    ` : ''}

    <div class="field" style="position:relative;">
      <label>Description <span class="muted small">(optional)</span></label>
      <input class="input" id="f-desc" type="text" autocomplete="off" placeholder="e.g. wingstop lunch" value="${esc(addForm.description)}" />
      <div id="f-suggest" class="suggest" aria-hidden="true"></div>
    </div>

    ${refundOffset}

    <button class="btn" id="f-save">${addForm.editingId ? 'Update' : 'Save'} Transaction</button>
    ${addForm.editingId ? '<button class="btn ghost" id="f-cancel" style="margin-top:10px;">Cancel Edit</button>' : ''}
  `;

  const setCategory = (cat) => {
    addForm.category = cat;
    applyCategoryDefault(acctOptions);
    renderAdd();
  };

  $$('.type-pill', v).forEach(p => p.addEventListener('click', () => {
    addForm.type = p.dataset.type;
    addForm.category = null; addForm.fromAccount = null;
    addForm.account = null; addForm.accountTouched = false; addForm.accountSource = null;
    addForm.offsetCategory = null;
    renderAdd();
  }));
  $('#f-amount', v).addEventListener('input', e => addForm.amount = e.target.value);
  $('#f-date', v).addEventListener('input', e => addForm.date = e.target.value);

  $$('.cat-chip', v).forEach(ch => ch.addEventListener('click', () => setCategory(ch.dataset.cat)));

  // Pickers — CLOSE the sheet explicitly: opened from a view, not a sheet.
  $('#f-cat', v).addEventListener('click', () => openPicker('Category', catList, addForm.category, (val) => {
    closeSheet();
    setCategory(val);
  }));
  $('#f-acct', v).addEventListener('click', () => openPicker(accountLabel, acctOptions.map(pickerOpt), addForm.account, (val) => {
    closeSheet();
    const auto = addForm.account;
    addForm.account = val;
    addForm.accountTouched = true;
    renderAdd();
    offerCategoryRule(val, auto);
  }));
  if ($('#f-from', v)) $('#f-from', v).addEventListener('click', () => openPicker(fromLabel, fromOptions.map(pickerOpt), addForm.fromAccount, (val) => {
    closeSheet();
    addForm.fromAccount = val;
    renderAdd();
  }));
  $('#f-offset', v)?.addEventListener('click', () => {
    const AUTO = 'Auto — from merchant', NONE = "Doesn't count against a budget";
    const cats = state.categories.Expense || [];
    const cur = addForm.offsetCategory === 'none' ? NONE : (addForm.offsetCategory || AUTO);
    openPicker('Gives back to budget', [AUTO, NONE, ...cats], cur, (val) => {
      closeSheet();
      addForm.offsetCategory = val === AUTO ? null : val === NONE ? 'none' : val;
      renderAdd();
    });
  });

  // Description + merchant autocomplete
  const descInput = $('#f-desc', v);
  const suggest = $('#f-suggest', v);
  const updateSuggestions = () => {
    const q = descInput.value;
    const hits = getMerchantSuggestions(q, 5);
    if (hits.length === 0){ suggest.innerHTML = ''; suggest.classList.remove('open'); return; }
    suggest.innerHTML = hits.map(h => {
      const meta = [h.category, h.account].filter(Boolean).join(' · ');
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
        if (m.category && catList.includes(m.category)) addForm.category = m.category;
        // The merchant's own usual account is more specific than the
        // category default — use it unless the user already chose one.
        if (!addForm.accountTouched && m.account && acctOptions.find(a => a.name === m.account)){
          addForm.account = m.account; addForm.accountSource = null;
        } else applyCategoryDefault(acctOptions);
      }
      suggest.classList.remove('open');
      renderAdd();
    }));
  };
  descInput.addEventListener('input', e => {
    addForm.description = e.target.value;
    updateSuggestions();
    // Refund budget guess follows the description live (updated in place —
    // re-rendering here would eat a tap on Save).
    const off = $('#f-offset .picker-val', v);
    if (off && !addForm.offsetCategory){
      const guess = refundBudgetCategory({ type:'Refund', description: addForm.description });
      off.textContent = guess ? `${guess} (from merchant)` : 'Auto — from merchant';
    }
  });
  descInput.addEventListener('blur', () => {
    // Delay hide so a click on a suggestion registers
    setTimeout(() => suggest.classList.remove('open'), 150);
  });
  descInput.addEventListener('focus', updateSuggestions);

  $('#f-save', v).addEventListener('click', saveTransaction);
  if ($('#f-cancel', v)) $('#f-cancel', v).addEventListener('click', cancelEdit);
}

// NEW(v3.0): the user overrode the account the form picked. If it's a
// category we can remember, offer to make it the rule.
// FIX(v3.1): asked at most ONCE per category, and never when a rule
// already exists (overriding a rule is a deliberate one-off). A category
// genuinely split between two cards used to get the prompt on every pick.
// Rules stay editable in More → Categories.
function offerCategoryRule(picked, previous){
  const { type, category } = addForm;
  if (!category || !['Expense','Income','Refund'].includes(type)) return;
  if (picked === previous || categoryRule(type, category)) return;
  const key = categoryRuleKey(type, category);
  const asked = state.flags.categoryRuleAsked || {};
  if (asked[key]) return;
  state.flags.categoryRuleAsked = { ...asked, [key]: Date.now() };
  saveFlags().catch(e => console.warn('saving prompt state failed', e));
  toastAction(`Always use ${picked} for ${category}?`, 'Always', async () => {
    state.flags.categoryAccounts = { ...(state.flags.categoryAccounts || {}), [categoryRuleKey(type, category)]: picked };
    await saveFlags();
    toast(`${category} → ${picked} saved (change it in More → Categories)`);
  }, 7000);
}

const saveTransaction = busyGuard(async () => {
  // FIX(v1.2): parseAmount — strips $/commas, rounds to cents, rejects junk.
  const amt = parseAmount(addForm.amount);
  if (isNaN(amt) || amt <= 0) { toast('Enter a valid amount'); return; }
  // FIX(v3.0): a cleared date input used to save a dateless transaction that
  // vanished from every month view and from all balances.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(addForm.date || '')) { toast('Pick a date'); return; }
  if (!addForm.account) { toast('Pick an account'); return; }
  const needsFrom = ['Transfer','CC Payment','Loan Payment','Balance Transfer'].includes(addForm.type);
  if (needsFrom && !addForm.fromAccount) { toast('Pick a source account'); return; }

  const existing = addForm.editingId ? state.transactions.find(t => t.id === addForm.editingId) : null;
  // FIX(v3.0): an edit keeps any fields this form doesn't manage.
  const txn = {
    ...(existing || {}),
    id: addForm.editingId || uid(),
    date: addForm.date,
    type: addForm.type,
    account: addForm.account,
    category: addForm.category,
    description: addForm.description.trim(),
    amount: amt,
    fromAccount: needsFrom ? addForm.fromAccount : null
  };
  if (addForm.type === 'Refund' && addForm.offsetCategory) txn.offsetCategory = addForm.offsetCategory;
  else delete txn.offsetCategory;

  await dbPut('transactions', txn);
  const idx = state.transactions.findIndex(t => t.id === txn.id);
  if (idx >= 0) state.transactions[idx] = txn;
  else state.transactions.push(txn);
  state.transactions.sort((a,b) => (b.date||'').localeCompare(a.date||''));
  invalidateMerchantCache();

  const wasEdit = !!addForm.editingId;
  haptic(15); /* NEW(v2.2) */

  // Keep type + date for fast repeat entry, reset the rest.
  resetAddForm({ type: addForm.type, date: addForm.date });

  // FIX(v1.2): edits return to Activity; fresh adds go Home.
  navigate(wasEdit ? 'txns' : 'home');

  // NEW(v3.0): logged a bill by hand? Offer to link it.
  const bill = findMatchingBill(txn);
  if (bill){
    toastAction(`${wasEdit ? 'Updated' : 'Saved'} · looks like "${bill.name}"`, 'Mark paid', async () => {
      await markBillPaidWith(bill, txn.date.slice(0, 7), txn.id);
    }, 8000);
  } else {
    toast(wasEdit ? 'Transaction updated' : 'Transaction saved');
  }
});

function cancelEdit(){
  resetAddForm();
  navigate('txns');
}

export function startEdit(txn){
  resetAddForm({
    type: txn.type, date: txn.date, account: txn.account, category: txn.category,
    description: String(txn.description ?? ''), /* FIX(v2.1): non-string descriptions */
    amount: String(txn.amount), fromAccount: txn.fromAccount,
    offsetCategory: txn.offsetCategory || null,
    editingId: txn.id,
    accountTouched: true   // editing: changing the category must not move the account
  });
  navigate('add');
}
