/* ============================================================
   manage.js — misc management sheets bundled together because each
   is small CRUD/utility: accounts, categories, import/export,
   backup-as-JSON, reset, about.
   ============================================================ */

import { $, $$, APP_VERSION, DEFAULT_CATEGORIES, monthAbbr, alphaSort, alphaSortBy, today, toLocalISO, uid, toast, esc, round2 } from './util.js';
import { state, STORES, DATA_STORES, dbPut, dbDel, dbClear, dbBulkPut, seedFromJSON, loadState } from './db.js';
import { invalidateMerchantCache } from './merchants.js';
import { openSheet, closeSheet, openPicker } from './sheet.js';
import { cascadeBalances } from './balances.js';

/* ─── Accounts ─────────────────────────── */
export function openAccountsSheet(){
  $('#sheetBody').innerHTML = `
    <h2>Accounts</h2>
    <div id="acct-list">
      ${state.accounts.map(a => {
        const bulletCls = a.type==='Credit Card'?'cc':(a.type==='Loan'?'loan':'checking');
        return `
        <div class="menu-item" style="padding:14px;margin-bottom:6px;">
          <span class="l">
            <span class="acct-bullet ${bulletCls}" style="margin-right:4px;"></span>
            <div>
              <div style="font-size:14px;font-weight:500;">${esc(a.name)}</div>
              <div class="muted small">${a.type}${a.active?'':' · inactive'}</div>
            </div>
          </span>
          <button class="btn ghost a-edit" data-id="${a.id}" style="width:auto;padding:7px 12px;font-size:12px;">Edit</button>
        </div>
      `;
      }).join('')}
    </div>
    <button class="btn" id="a-add">+ Add Account</button>
  `;
  openSheet();
  $$('.a-edit').forEach(b => b.addEventListener('click', () => editAccount(b.dataset.id)));
  $('#a-add').addEventListener('click', () => editAccount(null));
}
/* FIX(v1.2): renaming an account used to silently orphan every reference to
   the old name — transactions, starting balances, bills (account / fromAccount
   / linkedAccount), and debt plans all key on the name string, so a rename
   broke balances with no warning. Renames now cascade through all stores.
   FIX(v1.2): the Type and Active native <select>s are replaced with the
   bottom-sheet picker / segmented control (no-native-select rule, Samsung
   Internet standalone reliability). */
function editAccount(id){
  const existing = id ? state.accounts.find(x => x.id === id) : null;
  const f = {
    name: existing?.name || '',
    type: existing?.type || 'Checking',
    active: existing ? !!existing.active : true,
    notes: existing?.notes || ''
  };

  function render(){
    $('#sheetBody').innerHTML = `
      <h2>${id ? 'Edit' : 'New'} Account</h2>
      <div class="field"><label>Name</label><input class="input" id="ae-name" value="${esc(f.name)}" /></div>
      <div class="field">
        <label>Type</label>
        <button class="input picker-btn" id="ae-type" type="button">
          <span class="picker-val">${esc(f.type)}</span>
          <span class="picker-chev">▾</span>
        </button>
      </div>
      <div class="field">
        <label>Active?</label>
        <div class="seg" id="ae-active" role="tablist">
          <button type="button" class="seg-btn ${f.active?'active':''}" data-active="true">Yes</button>
          <button type="button" class="seg-btn ${!f.active?'active':''}" data-active="false">No</button>
        </div>
      </div>
      <div class="field"><label>Notes</label><input class="input" id="ae-notes" value="${esc(f.notes)}" /></div>
      <button class="btn" id="ae-save">Save</button>
      ${id ? '<button class="btn danger" id="ae-del" style="margin-top:10px;">Delete</button>' : ''}
      <button class="btn ghost" id="ae-back" style="margin-top:10px;">Back</button>
    `;
    $('#ae-name').addEventListener('input', e => f.name = e.target.value);
    $('#ae-notes').addEventListener('input', e => f.notes = e.target.value);
    $('#ae-type').addEventListener('click', () => {
      openPicker('Account Type', ['Checking','Savings','Credit Card','Loan'], f.type, (val) => {
        f.type = val;
        render();
      });
    });
    $$('.seg-btn', $('#ae-active')).forEach(btn => btn.addEventListener('click', () => {
      f.active = btn.dataset.active === 'true';
      $$('.seg-btn', $('#ae-active')).forEach(x => x.classList.toggle('active', x === btn));
    }));
    $('#ae-save').addEventListener('click', save);
    if (id){
      $('#ae-del').addEventListener('click', async () => {
        if (!confirm('Delete this account? Transactions referencing it will keep the name.')) return;
        await dbDel('accounts', id);
        state.accounts = state.accounts.filter(x => x.id !== id);
        openAccountsSheet(); toast('Deleted');
      });
    }
    $('#ae-back').addEventListener('click', openAccountsSheet);
  }

  async function save(){
    const newName = f.name.trim();
    if (!newName) { toast('Name required'); return; }
    const oldName = existing?.name || null;
    const clash = state.accounts.find(x => x.name === newName && x.id !== (id || ''));
    if (clash){ toast('An account with that name already exists'); return; }

    const obj = {
      id: id || uid(),
      name: newName,
      type: f.type,
      active: f.active,
      notes: f.notes.trim(),
      order: existing?.order ?? state.accounts.length
    };
    await dbPut('accounts', obj);
    const i = state.accounts.findIndex(x => x.id === obj.id);
    if (i >= 0) state.accounts[i] = obj; else state.accounts.push(obj);
    state.accounts.sort(alphaSortBy('name'));

    // Cascade a rename through every store that references the name.
    if (oldName && oldName !== newName){
      let touched = 0;
      for (const t of state.transactions){
        let changed = false;
        if (t.account === oldName){ t.account = newName; changed = true; }
        if (t.fromAccount === oldName){ t.fromAccount = newName; changed = true; }
        if (changed){ await dbPut('transactions', t); touched++; }
      }
      for (const sb of state.startingBalances){
        if (sb.account === oldName){ sb.account = newName; await dbPut('startingBalances', sb); touched++; }
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
      // NEW(v2.0): goals can be linked to an account by name.
      for (const g of state.goals){
        if (g.account === oldName){ g.account = newName; await dbPut('goals', g); touched++; }
      }
      invalidateMerchantCache();
      toast(touched ? `Saved · updated ${touched} linked record${touched===1?'':'s'}` : 'Saved');
      openAccountsSheet();
      return;
    }
    openAccountsSheet(); toast('Saved');
  }

  render();
}

/* ─── Categories ─────────────────────────── */
export function openCategoriesSheet(){
  const types = [
    ['Expense','Expense'],
    ['Income','Income'],
    ['Refund','Refund'],
    ['Investment','Investment'],
    ['CCPayment','CC Payment'],
    ['LoanPayment','Loan Payment'],
    ['Transfer','Transfer'],
    ['BalanceTransfer','Balance Transfer']
  ];
  $('#sheetBody').innerHTML = `
    <h2>Categories</h2>
    <div class="muted small" style="margin-bottom:14px;">Categories are shown alphabetically throughout the app.</div>
    ${types.map(([k, label]) => {
      const list = (state.categories[k]||[]).slice().sort(alphaSort);
      const defaults = DEFAULT_CATEGORIES[k] || [];
      const isEmpty = list.length === 0;
      return `
      <div class="card" style="margin-bottom:10px;">
        <h3 class="card-title">${label}${isEmpty && defaults.length ? ` <button class="c-restore-one" data-type="${k}" style="background:none;border:1px solid var(--ember);color:var(--ember);padding:3px 8px;border-radius:999px;font-size:10px;letter-spacing:.08em;cursor:pointer;">Restore ${defaults.length}</button>` : ''}</h3>
        <div id="cat-${k}">
          ${list.map(c => `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 0;">
              <input class="input" data-cat-type="${k}" data-cat-old="${esc(c)}" value="${esc(c)}" style="flex:1;padding:8px 10px;font-size:13px;" />
              <button class="btn danger c-del" data-type="${k}" data-cat="${esc(c)}" style="width:auto;padding:6px 10px;font-size:12px;">×</button>
            </div>
          `).join('')}
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
  $$('.c-add').forEach(b => b.addEventListener('click', async () => {
    const t = b.dataset.type;
    const inp = b.parentElement.querySelector('.c-new');
    const v = inp.value.trim();
    if (!v) return;
    const list = [...(state.categories[t]||[]), v].sort(alphaSort);
    state.categories[t] = list;
    await dbPut('categories', { id:t, list });
    openCategoriesSheet();
  }));
  $$('.c-del').forEach(b => b.addEventListener('click', async () => {
    const t = b.dataset.type, c = b.dataset.cat;
    // NEW(v2.0): delete-with-reassignment. Deleting a category that's in use
    // used to orphan its transactions (they kept the label but fell out of
    // budgets/breakdown grouping). Now: if the category has transactions,
    // pick a replacement and everything — txns + budgets — moves over.
    const typeMap = { Expense:'Expense', Income:'Income', Refund:'Refund', Investment:'Investment',
                      CCPayment:'CC Payment', LoanPayment:'Loan Payment', Transfer:'Transfer', BalanceTransfer:'Balance Transfer' };
    const txnType = typeMap[t];
    const used = state.transactions.filter(x => x.type === txnType && x.category === c);
    if (used.length === 0){
      if (!confirm(`Delete "${c}"?`)) return;
      state.categories[t] = state.categories[t].filter(x => x !== c);
      await dbPut('categories', { id:t, list:state.categories[t] });
      openCategoriesSheet();
      return;
    }
    const others = (state.categories[t] || []).filter(x => x !== c);
    if (!others.length){
      toast(`"${c}" has ${used.length} transactions and there's no other ${txnType} category to move them to`);
      return;
    }
    if (!confirm(`"${c}" is used by ${used.length} transaction${used.length===1?'':'s'}.\n\nPick a category to move them to — this also merges any budget. Cancel to keep "${c}".`)) return;
    openPicker(`Move "${c}" transactions to…`, others, null, async (target) => {
      // Transactions
      for (const x of used){
        x.category = target;
        await dbPut('transactions', x);
      }
      // Budgets: merge month-by-month if the target already has one,
      // otherwise the old budget is just relabeled.
      const oldB = state.budgets.find(bb => bb.type === t && bb.category === c);
      if (oldB){
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
      // Category list
      state.categories[t] = state.categories[t].filter(x => x !== c);
      await dbPut('categories', { id:t, list:state.categories[t] });
      invalidateMerchantCache();
      toast(`Moved ${used.length} to "${target}" · "${c}" deleted`);
      openCategoriesSheet();
    });
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
  // FIX(v1.2): renaming a category only updated the category list — existing
  // transactions and budgets kept the old label, so budget tracking and the
  // breakdown silently lost them. The data-cat-old attribute (already stored,
  // never used) now drives a rename cascade through transactions + budgets.
  $('#c-save-all').addEventListener('click', async () => {
    let cascaded = 0;
    for (const [k] of types){
      const inputs = $$(`input[data-cat-type="${k}"]`);
      const renames = [];
      const list = [];
      for (const inp of inputs){
        const nv = inp.value.trim();
        if (!nv) continue;
        list.push(nv);
        const old = inp.dataset.catOld;
        if (old && old !== nv) renames.push([old, nv]);
      }
      state.categories[k] = list.sort(alphaSort);
      await dbPut('categories', { id:k, list: state.categories[k] });

      if (renames.length){
        // Category type keys map to transaction type strings
        const typeMap = { Expense:'Expense', Income:'Income', Refund:'Refund', Investment:'Investment',
                          CCPayment:'CC Payment', LoanPayment:'Loan Payment', Transfer:'Transfer', BalanceTransfer:'Balance Transfer' };
        const txnType = typeMap[k];
        for (const [oldC, newC] of renames){
          for (const t of state.transactions){
            if (t.type === txnType && t.category === oldC){
              t.category = newC;
              await dbPut('transactions', t);
              cascaded++;
            }
          }
          for (const b of state.budgets){
            // Budget types are only ever Expense / Income / Investment, which
            // match their category-list keys directly.
            if (b.type === k && b.category === oldC){
              b.category = newC;
              await dbPut('budgets', b);
              cascaded++;
            }
          }
        }
      }
    }
    invalidateMerchantCache();
    toast(cascaded ? `Saved · updated ${cascaded} record${cascaded===1?'':'s'}` : 'Saved');
    openCategoriesSheet();
  });
}

/* ─── XLSX Export ─────────────────────────── */
export async function exportXLSX(){
  if (typeof XLSX === 'undefined') { toast('Excel library not loaded'); return; }
  const wb = XLSX.utils.book_new();
  const txnRows = [['Date','Type','Account','Category','Description','Amount','From Account']];
  state.transactions.forEach(t => txnRows.push([t.date, t.type, t.account, t.category||'', t.description||'', t.amount, t.fromAccount||'']));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(txnRows), 'Transactions');
  const acctRows = [['Name','Type','Active','Notes']];
  state.accounts.forEach(a => acctRows.push([a.name, a.type, a.active?'Yes':'No', a.notes||'']));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(acctRows), 'Accounts');
  const bRows = [['Type','Category', ...monthAbbr.map(m => m.toUpperCase())]];
  state.budgets.forEach(b => bRows.push([b.type, b.category, ...monthAbbr.map(m => b.amounts[m]||0)]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(bRows), 'Budgets');
  const sbRows = [['Account', ...monthAbbr.map(m => m.toUpperCase())]];
  state.startingBalances.forEach(s => sbRows.push([s.account, ...monthAbbr.map(m => s[m]||0)]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sbRows), 'Balances');
  const nwRows = [['Date','Checking','Savings','Investments','CC Debt','Other Debt','Notes']];
  state.netWorth.forEach(n => nwRows.push([n.date, n.checking, n.savings, n.investments, n.ccDebt, n.otherDebt, n.notes||'']));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(nwRows), 'Net Worth');
  const dpRows = [['Account','Original','APR','Min Payment','Promo Ends','Target Payoff','Notes']];
  state.debtPlans.forEach(d => dpRows.push([d.account, d.originalBalance, d.apr, d.minPayment, d.promoEndDate||'', d.targetPayoffDate||'', d.notes||'']));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dpRows), 'Debt Plans');
  const blRows = [['Name','Amount','Due Day','Recurrence','Due Date','Linked Account','Close Day','Grace Days','Type','Account','From Account','Category','Active']];
  state.bills.forEach(b => blRows.push([
    b.name, b.amount, b.dueDay,
    b.recurrence||'monthly', b.dueDate||'',
    b.linkedAccount||'', b.closeDay||'', b.graceDays!=null?b.graceDays:'',
    b.type, b.account, b.fromAccount||'', b.category||'',
    b.active!==false?'Yes':'No'
  ]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(blRows), 'Bills');
  // NEW(v2.0): goals round-trip through export/import like everything else.
  const gRows = [['Name','Target','Account','Saved','Target Date','Archived']];
  state.goals.forEach(g => gRows.push([g.name, g.target, g.account||'', g.saved||0, g.targetDate||'', g.archived?'Yes':'No']));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(gRows), 'Goals');
  const catRows = [['Type','Category']];
  for (const [typ, list] of Object.entries(state.categories || {})){
    (list || []).forEach(c => catRows.push([typ, c]));
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(catRows), 'Categories');

  const date = today();
  XLSX.writeFile(wb, `ledger-export-${date}.xlsx`);
  toast('Exported');
}

export async function importXLSX(onImported){
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.xlsx,.xls';
  input.onchange = async () => {
    const file = input.files[0]; if (!file) return;
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type:'array', cellDates:true });
    if (!confirm('This replaces ALL current data. Continue?')) return;
    const seed = parseWorkbookToSeed(wb);
    await seedFromJSON(seed);
    await loadState();
    invalidateMerchantCache();
    if (typeof onImported === 'function') onImported();
    toast('Imported');
  };
  input.click();
}

function parseWorkbookToSeed(wb){
  const seed = { accounts:[], categories:{Expense:[],Income:[],Refund:[],Investment:[],CCPayment:[],Transfer:[],BalanceTransfer:[],LoanPayment:[]}, budgets:[], startingBalances:{}, transactions:[], netWorth:[], debtPlans:[], bills:[], goals:[], meta:{trackingYear:state.selected.year} };
  const sheets = wb.SheetNames;
  if (sheets.includes('Accounts') && sheets.includes('Transactions')){
    const a = XLSX.utils.sheet_to_json(wb.Sheets['Accounts']);
    a.forEach(r => seed.accounts.push({ name:r.Name, type:r.Type, active:r.Active==='Yes', notes:r.Notes||'' }));
    const t = XLSX.utils.sheet_to_json(wb.Sheets['Transactions']);
    t.forEach(r => {
      const d = r.Date instanceof Date ? toLocalISO(r.Date) : String(r.Date).slice(0,10);
      seed.transactions.push({ date:d, type:r.Type, account:r.Account, category:r.Category||'', description:r.Description||'', amount:Number(r.Amount), fromAccount:r['From Account']||null });
    });
    if (sheets.includes('Budgets')){
      const b = XLSX.utils.sheet_to_json(wb.Sheets['Budgets']);
      b.forEach(r => {
        const amounts = {}; monthAbbr.forEach(m => amounts[m] = Number(r[m.toUpperCase()])||0);
        seed.budgets.push({ type:r.Type, category:r.Category, amounts });
      });
    }
    if (sheets.includes('Balances')){
      const b = XLSX.utils.sheet_to_json(wb.Sheets['Balances']);
      b.forEach(r => {
        const obj = {}; monthAbbr.forEach(m => obj[m] = Number(r[m.toUpperCase()])||0);
        seed.startingBalances[r.Account] = obj;
      });
    }
    if (sheets.includes('Categories')){
      const c = XLSX.utils.sheet_to_json(wb.Sheets['Categories']);
      c.forEach(r => {
        if (r.Type && r.Category && seed.categories[r.Type] !== undefined){
          seed.categories[r.Type].push(r.Category);
        }
      });
    }
    // FIX(v1.2): the exporter wrote Bills, Net Worth, and Debt Plans sheets,
    // but the importer never read them — a full export → import round-trip
    // silently dropped all three. They're now parsed back in.
    if (sheets.includes('Bills')){
      const b = XLSX.utils.sheet_to_json(wb.Sheets['Bills']);
      b.forEach(r => {
        if (!r.Name) return;
        seed.bills.push({
          name: r.Name,
          amount: Number(r.Amount) || 0,
          dueDay: Number(r['Due Day']) || 1,
          recurrence: r.Recurrence || 'monthly',
          dueDate: r['Due Date'] ? String(r['Due Date']).slice(0,10) : '',
          linkedAccount: r['Linked Account'] || '',
          closeDay: Number(r['Close Day']) || 0,
          graceDays: r['Grace Days'] === '' || r['Grace Days'] == null ? 0 : Number(r['Grace Days']),
          type: r.Type || 'Expense',
          account: r.Account || '',
          fromAccount: r['From Account'] || null,
          category: r.Category || '',
          active: r.Active !== 'No'
        });
      });
    }
    if (sheets.includes('Net Worth')){
      const n = XLSX.utils.sheet_to_json(wb.Sheets['Net Worth']);
      n.forEach(r => {
        if (!r.Date) return;
        seed.netWorth.push({
          date: r.Date instanceof Date ? toLocalISO(r.Date) : String(r.Date).slice(0,10),
          checking: Number(r.Checking) || 0,
          savings: Number(r.Savings) || 0,
          investments: Number(r.Investments) || 0,
          ccDebt: Number(r['CC Debt']) || 0,
          otherDebt: Number(r['Other Debt']) || 0,
          notes: r.Notes || ''
        });
      });
    }
    if (sheets.includes('Debt Plans')){
      const dpl = XLSX.utils.sheet_to_json(wb.Sheets['Debt Plans']);
      dpl.forEach(r => {
        if (!r.Account) return;
        seed.debtPlans.push({
          account: r.Account,
          originalBalance: Number(r.Original) || 0,
          apr: r.APR === '' || r.APR == null ? null : Number(r.APR),
          minPayment: Number(r['Min Payment']) || 0,
          promoEndDate: r['Promo Ends'] ? String(r['Promo Ends']).slice(0,10) : null,
          targetPayoffDate: r['Target Payoff'] ? String(r['Target Payoff']).slice(0,10) : null,
          notes: r.Notes || ''
        });
      });
    }
    // NEW(v2.0): Goals sheet round-trips too.
    if (sheets.includes('Goals')){
      const gl = XLSX.utils.sheet_to_json(wb.Sheets['Goals']);
      gl.forEach(r => {
        if (!r.Name) return;
        seed.goals.push({
          name: r.Name,
          target: Number(r.Target) || 0,
          account: r.Account || null,
          saved: Number(r.Saved) || 0,
          targetDate: r['Target Date'] ? String(r['Target Date']).slice(0,10) : null,
          archived: r.Archived === 'Yes'
        });
      });
    }
    for (const [k, defaults] of Object.entries(DEFAULT_CATEGORIES)){
      if (!seed.categories[k] || seed.categories[k].length === 0){
        seed.categories[k] = [...defaults];
      }
    }
  } else {
    if (sheets.includes('Account Registry')){
      const ws = wb.Sheets['Account Registry'];
      const rows = XLSX.utils.sheet_to_json(ws, { header:1 });
      for (let i = 3; i < rows.length; i++){
        const r = rows[i]; if (!r[0]) continue;
        seed.accounts.push({ name:r[0], type:r[1], active:(r[3]||'').toLowerCase()==='yes', notes:r[4]||'' });
      }
    }
    if (sheets.includes('Transactions')){
      const ws = wb.Sheets['Transactions'];
      const rows = XLSX.utils.sheet_to_json(ws, { header:1, raw:false, dateNF:'yyyy-mm-dd' });
      for (let i = 3; i < rows.length; i++){
        const r = rows[i]; if (!r[0]) continue;
        seed.transactions.push({
          date: typeof r[0] === 'string' ? r[0].slice(0,10) : toLocalISO(new Date(r[0])),
          type: r[1], account:r[2], category:r[3], description:r[4]||'', amount:Number(r[5]), fromAccount:r[6]||null
        });
      }
    }
  }
  return seed;
}

/* ─── Recompute Balances ───────────────────────
   One-shot repair for stale starting balances. Mostly useful for users
   upgrading from <= v1.1.0, where transaction edits didn't auto-cascade
   to subsequent months. Going forward, cascadeForChange() handles this
   automatically on every txn mutation, so this is rarely needed.
   ──────────────────────────────────────────────── */
export async function recomputeAllBalances(){
  if (!state.transactions.length){
    toast('No transactions to recompute');
    return;
  }
  if (!confirm(
    'Recompute every starting balance from your transaction history?\n\n' +
    'For each account, the earliest month with a transaction stays put — ' +
    'all later months are recalculated. This is safe; opening balances ' +
    'set before an account had any activity are preserved.'
  )) return;

  // For each (account, year), find earliest month containing a txn.
  const earliest = new Map();
  for (const t of state.transactions){
    if (!t.date) continue;
    const yr = parseInt(t.date.slice(0,4), 10);
    const mo = parseInt(t.date.slice(5,7), 10);
    if (!yr || !mo) continue;
    for (const acct of [t.account, t.fromAccount]){
      if (!acct) continue;
      const key = `${acct}|${yr}`;
      if (!earliest.has(key) || earliest.get(key) > mo) earliest.set(key, mo);
    }
  }

  for (const [key, mo] of earliest){
    const [acct, yrStr] = key.split('|');
    await cascadeBalances(acct, parseInt(yrStr, 10), mo);
  }
  toast(`Recomputed ${earliest.size} account-year(s)`);
}

/* ─── Backup / Reset ─────────────────────────── */
export async function backupJSON(){
  const data = {
    version:2, // NEW(v2.0): adds goals; older restores ignore unknown keys
    accounts: state.accounts,
    categories: state.categories,
    budgets: state.budgets,
    startingBalances: state.startingBalances,
    transactions: state.transactions,
    netWorth: state.netWorth,
    debtPlans: state.debtPlans,
    bills: state.bills,
    goals: state.goals
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `ledger-backup-${today()}.json`; a.click();
  URL.revokeObjectURL(url);
  toast('Backup downloaded');
}

/* ─── Restore from JSON ────────────────────────
   Counterpart to backupJSON. Reads a backup file produced by this app and
   replaces ALL current data with its contents. The backup stores each store
   as an array of records (with their ids), except `categories`, which is an
   object keyed by type — so that one is rehydrated into per-type records.
   ──────────────────────────────────────────────── */
export async function restoreJSON(onRestored){
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast('Not a valid JSON file');
      return;
    }
    // Light validation: a real backup has at least these two arrays.
    if (!data || !Array.isArray(data.accounts) || !Array.isArray(data.transactions)){
      toast("Doesn't look like a Ledger backup");
      return;
    }
    if (!confirm('Restore from this backup?\n\nThis REPLACES all current data on this device. Consider downloading a fresh backup first if you\'re unsure.')) return;

    // Defensive: every record needs an id (IndexedDB keyPath). App backups
    // always include ids, but assign one if a hand-edited file is missing them.
    const withIds = (arr) => (arr || []).map(r => (r && r.id) ? r : { ...r, id: uid() });

    try {
      // FIX(v2.9.1): clear DATA stores only. Restoring a backup used to wipe
      // meta too — device settings (realAvailCards, auto-snapshot toggle,
      // dismissed banners) that backups don't even contain, so they were
      // simply lost. Trash and tombstones survive for the same reason.
      for (const s of DATA_STORES) await dbClear(s);
      await dbBulkPut('accounts',         withIds(data.accounts));
      await dbBulkPut('budgets',          withIds(data.budgets));
      await dbBulkPut('startingBalances', withIds(data.startingBalances));
      await dbBulkPut('transactions',     withIds(data.transactions));
      await dbBulkPut('networth',         withIds(data.netWorth));
      await dbBulkPut('debtPlans',        withIds(data.debtPlans));
      await dbBulkPut('bills',            withIds(data.bills));
      await dbBulkPut('goals',            withIds(data.goals)); // NEW(v2.0): absent in v1 backups → empty
      // categories: object { Expense:[...], Income:[...], ... } → one record per type
      const cats = data.categories || {};
      for (const k of Object.keys(cats)){
        await dbPut('categories', { id:k, list: Array.isArray(cats[k]) ? cats[k] : [] });
      }
      await loadState();
      invalidateMerchantCache();
      if (typeof onRestored === 'function') onRestored();
      toast('Backup restored');
    } catch (e){
      console.error(e);
      toast('Restore failed: ' + (e.message || 'unknown error'));
    }
  };
  input.click();
}
export async function resetData(){
  if (!confirm('Erase ALL data and start fresh? This cannot be undone.')) return;
  if (!confirm('Really? All transactions, accounts, and settings will be deleted.')) return;
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
        Everything stays on this device in IndexedDB. Nothing is sent anywhere. Your data is safe across app updates — use Backup as JSON in More if you want an extra copy.
      </div>
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
