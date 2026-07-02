/* ============================================================
   bills.js — Bills tab view + bill edit sheet + pay/unpay actions.

   v1.1.2 addition: bills can now be one-time (recurrence: 'once')
   in addition to recurring monthly. A one-time bill has a full
   `dueDate` (YYYY-MM-DD) and only shows up in views for its target
   month — it doesn't leak forward to subsequent months. dueDay is
   still maintained on both kinds for sorting and status display.

   v1.1.3 addition: a third recurrence type, 'auto-cc', for
   pay-in-full credit cards. The bill's amount is *live* — it reads
   balanceLatest() of a linked Credit Card account on every render —
   and its due day is computed from a configurable statement close
   day + grace period. This makes "Real available" reflect rolling
   CC charges in real time. See getBillAmount / getBillDueDay below.
   ============================================================ */

import { $, $$, fmt, fmtShort, monthName, today, uid, clamp, toast, toastAction, sumMoney, round2, parseAmount, toCents, fromCents, haptic, esc } from './util.js';
import { state, dbPut, dbDel } from './db.js';
import { balanceAt, balanceLatest } from './effects.js';
import { openSheet, closeSheet, openPicker } from './sheet.js';
import { renderCurrent } from './app.js';
import { cascadeForChange } from './balances.js';
import { trashTxn, restoreTxn } from './trash.js';

// True if this bill should appear in the views for the given (year, month).
// - Monthly bills always apply (recurring).
// - One-time bills only apply if their dueDate falls in (year, month).
// - Auto-cc bills always apply (the linked card has a balance every month).
// Used by bills tab, home tab, and any total/preview that needs to
// answer "is this bill relevant right now?" Treats missing recurrence
// as 'monthly' for back-compat with pre-1.1.2 data.
export function billAppliesToMonth(bill, year, month){
  const rec = bill.recurrence || 'monthly';
  if (rec === 'monthly' || rec === 'auto-cc') return true;
  if (rec === 'once'){
    if (!bill.dueDate) return false;
    const ym = `${year}-${String(month).padStart(2,'0')}`;
    return bill.dueDate.slice(0,7) === ym;
  }
  return true;
}

// Effective amount owed for a bill — live for auto-cc, stored otherwise.
// Auto-cc reads the linked account's current running balance and clamps
// to >= 0 (a CC with a credit balance owes nothing). Returns 0 if the
// linked account no longer exists, so renamed/deleted accounts degrade
// gracefully rather than throwing.
// FIX(v2.9.1): optional (year, month) context. Without it, browsing a past
// month showed TODAY'S card balance against that month's cash — a "Real
// available" figure that never existed. Non-live months now read the card's
// balance as of that month; the live month (or no context) stays live.
export function getBillAmount(bill, year, month){
  if (bill.recurrence !== 'auto-cc') return bill.amount || 0;
  if (!bill.linkedAccount) return 0;
  const now = new Date();
  const isLive = year == null || (year === now.getFullYear() && month === now.getMonth() + 1);
  const bal = isLive ? balanceLatest(bill.linkedAccount) : balanceAt(bill.linkedAccount, year, month);
  return Math.max(0, Math.round(bal * 100) / 100);
}

/* ── NEW(v2.9.1): the single source of truth for "Real available" ──────
   Home and Bills used to compute this independently — Home subtracted the
   configured realAvailCards balances (with the auto-cc double-count guard),
   Bills ignored the setting entirely, so two screens showed two different
   numbers under the same label. Both views now render from this. */
export function computeRealAvailable(year, month){
  const ym = `${year}-${String(month).padStart(2,'0')}`;
  const billsThisMonth = state.bills.filter(b => b.active !== false && billAppliesToMonth(b, year, month));
  const stdUnpaid = billsThisMonth.filter(b => b.recurrence !== 'auto-cc' && !(b.paidMonths || {})[ym]);
  const autoCcAll = billsThisMonth.filter(b => b.recurrence === 'auto-cc');

  // Configured card deduction (⚙ on the Home card, flags.realAvailCards).
  const raCards = (state.flags.realAvailCards || [])
    .filter(n => state.accounts.find(a => a.name === n && a.active));
  let cardDeductC = 0;
  const cardLines = raCards.map(n => {
    const bal = balanceAt(n, year, month);
    cardDeductC += toCents(bal);
    return { name: n, bal };
  });

  // Double-count guard: an auto-cc bill tracking a SELECTED card is the
  // same money as the card's balance — exclude it from the bills side.
  const autoCcCounted = autoCcAll.filter(b => !raCards.includes(b.linkedAccount));
  const upcomingTotal = round2(
    sumMoney(stdUnpaid, b => b.amount || 0) +
    sumMoney(autoCcCounted, b => getBillAmount(b, year, month)));

  const cash = sumMoney(
    state.accounts.filter(a => a.active && a.type === 'Checking'),
    a => balanceAt(a.name, year, month));

  // Visible "unpaid" list: unpaid standard bills + auto-cc bills that still
  // carry a balance (a fully-paid card stays out of your face).
  const unpaidBills = [
    ...stdUnpaid,
    ...autoCcAll.filter(b => getBillAmount(b, year, month) > 0 && !(b.paidMonths || {})[ym])
  ];

  const cardDeduct = fromCents(cardDeductC);
  return {
    cash, upcomingTotal, cardLines, cardDeduct,
    stdUnpaid, autoCcAll, unpaidBills,
    realAvailable: round2(cash - upcomingTotal - cardDeduct)
  };
}

// Effective dueDay for status display + sorting. For auto-cc, this is
// (closeDay + graceDays) wrapped into 1..30 — an approximate calendar
// day that lines up with "real" payment due timing for typical cards
// (e.g. close=15 + grace=21 → due day 6 of the following month).
export function getBillDueDay(bill){
  if (bill.recurrence !== 'auto-cc') return bill.dueDay || 1;
  const close = bill.closeDay || 1;
  const grace = bill.graceDays != null ? bill.graceDays : 21;
  const sum = close + grace;
  return ((sum - 1) % 30) + 1;
}

export function billStatus(b, ym, isCurrentMonth, todayDay){
  const paid = (b.paidMonths || {})[ym];
  if (paid) return { kind:'paid', label:'Paid' };
  if (!isCurrentMonth) return { kind:'future', label:'' };
  const due = getBillDueDay(b);
  const days = due - todayDay;
  if (days < 0) return { kind:'overdue', label:`${-days}d overdue` };
  if (days === 0) return { kind:'today', label:'Due today' };
  if (days <= 3) return { kind:'soon', label:`Due in ${days}d` };
  return { kind:'future', label:`Due in ${days}d` };
}

export function billRowHTML(b, ym, isCurrentMonth, todayDay){
  const st = billStatus(b, ym, isCurrentMonth, todayDay);
  const isPaid = st.kind === 'paid';
  const isOnce = b.recurrence === 'once';
  const isAuto = b.recurrence === 'auto-cc';
  const acctMeta = isAuto
    ? `Tracks ${esc(b.linkedAccount)} · pay from ${esc(b.fromAccount || '—')}`
    : (b.fromAccount ? `${esc(b.fromAccount)} → ${esc(b.account)}` : esc(b.account));
  const dueDay = getBillDueDay(b);
  const liveAmount = getBillAmount(b, Number(ym.slice(0, 4)), Number(ym.slice(5, 7)));
  const tag = isOnce ? ' <span class="bill-once-tag">Once</span>'
           : isAuto ? ' <span class="bill-auto-tag">Auto</span>'
           : '';
  return `
    <div class="bill-row ${isPaid ? 'is-paid' : ''}" data-bill-id="${b.id}">
      <button class="bill-check ${isPaid ? 'checked' : ''}" data-id="${b.id}" aria-label="Toggle paid">
        ${isPaid ? '<svg viewBox="0 0 14 14" width="14" height="14"><path d="M2 7l3.5 3.5L12 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
      </button>
      <div class="bill-body">
        <div class="bill-name">${esc(b.name)}${tag}</div>
        <div class="bill-meta">
          <span class="bill-status ${st.kind}">${st.label || `Day ${dueDay}`}</span>
          <span class="bill-acct">· ${acctMeta}</span>
        </div>
      </div>
      <div class="bill-amt mono">${fmtShort(liveAmount)}</div>
    </div>
  `;
}

export function renderBills(){
  const v = $('#view-bills');
  const { year, month } = state.selected;
  const ym = `${year}-${String(month).padStart(2,'0')}`;
  const isCurrentMonth = (year === new Date().getFullYear() && month === new Date().getMonth() + 1);
  const todayDay = new Date().getDate();

  const bills = state.bills.filter(b => b.active !== false && billAppliesToMonth(b, year, month));

  // Total/Paid/Unpaid math is split because auto-cc bills work differently:
  //   - Standard bills: a static amount; once paid this month, it doesn't
  //     contribute to "unpaid" anymore.
  //   - Auto-cc bills: amount is the LIVE running balance. Even after you
  //     "pay" this month, new charges immediately re-accrue, and that new
  //     balance still needs to come out of real-available cash. So auto-cc
  //     bills always contribute their live amount to unpaid total — the
  //     "Paid" status badge is informational only ("you paid this month").
  const standardBills = bills.filter(b => b.recurrence !== 'auto-cc');
  const autoCcBills   = bills.filter(b => b.recurrence === 'auto-cc');

  // FIX(v1.2): bill totals + cash now sum in cents — float drift over many
  // bills/accounts could flip the pos/neg coloring on "Real available".
  const stdTotal = sumMoney(standardBills, b => b.amount || 0);
  const stdPaid  = sumMoney(standardBills.filter(b => (b.paidMonths || {})[ym]), b => b.amount || 0);
  const autoCcLive = sumMoney(autoCcBills, b => getBillAmount(b, year, month));

  const totalDue    = round2(stdTotal + autoCcLive);
  const paidTotal   = stdPaid;        // shown in the Paid tile (standard bills only)
  const unpaidTotal = round2((stdTotal - stdPaid) + autoCcLive);

  // FIX(v2.9.1): same math as Home — this view used to ignore the
  // realAvailCards setting, so Home and Bills disagreed on the number.
  const ra = computeRealAvailable(year, month);

  // Group bills by status
  const groups = { overdue:[], today:[], soon:[], future:[], paid:[] };
  bills.forEach(b => {
    const st = billStatus(b, ym, isCurrentMonth, todayDay);
    groups[st.kind].push(b);
  });
  Object.values(groups).forEach(g => g.sort((a,b) => getBillDueDay(a) - getBillDueDay(b)));

  const sectionHTML = (title, list) => list.length ? `
    <div class="bill-section">
      <div class="bill-section-head">${title} <span class="muted small">${list.length}</span></div>
      ${list.map(b => billRowHTML(b, ym, isCurrentMonth, todayDay)).join('')}
    </div>
  ` : '';

  v.innerHTML = `
    <div class="real-card" style="margin-top:0;">
      <div class="real-head">
        <div>
          <div class="l">Real available</div>
          <div class="v ${ra.realAvailable >= 0 ? 'pos' : 'neg'}">${fmt(ra.realAvailable)}</div>
          <div class="sub">${monthName(month, true)} ${year}</div>
        </div>
      </div>
      <div class="real-breakdown">
        <div class="rb-row"><span>Cash</span><span class="mono">${fmt(ra.cash)}</span></div>
        <div class="rb-row"><span>− Bills due</span><span class="mono amber">${fmt(ra.upcomingTotal)}</span></div>
        ${ra.cardLines.map(c => `<div class="rb-row"><span>− ${esc(c.name)}</span><span class="mono amber">${fmt(c.bal)}</span></div>`).join('')}
        <div class="rb-row total"><span>= Available</span><span class="mono ${ra.realAvailable>=0?'pos':'neg'}">${fmt(ra.realAvailable)}</span></div>
      </div>
    </div>

    <div class="bill-summary">
      <div class="bs-tile"><div class="l">Bills total</div><div class="v">${fmt(totalDue)}</div></div>
      <div class="bs-tile"><div class="l">Paid</div><div class="v" style="color:var(--green);">${fmt(paidTotal)}</div></div>
      <div class="bs-tile"><div class="l">Remaining</div><div class="v" style="color:var(--amber);">${fmt(unpaidTotal)}</div></div>
    </div>

    ${bills.length === 0 ? `
      <div class="empty">
        <div class="big">No bills yet.</div>
        Add your recurring bills to see what's coming due.
      </div>
    ` : `
      ${sectionHTML('Overdue', groups.overdue)}
      ${sectionHTML('Due today', groups.today)}
      ${sectionHTML('Due soon', groups.soon)}
      ${sectionHTML('Later this month', groups.future)}
      ${sectionHTML('Paid', groups.paid)}
    `}

    <button class="btn" id="add-bill" style="margin-top:18px;">+ Add Bill</button>
  `;

  $$('.bill-check', v).forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const bill = state.bills.find(x => x.id === b.dataset.id);
    if (!bill) return;
    if ((bill.paidMonths || {})[ym]) unpayBill(bill.id);
    else payBill(bill.id);
  }));
  $$('.bill-row[data-bill-id]', v).forEach(el => el.addEventListener('click', () => openBillSheet(el.dataset.billId)));
  $('#add-bill', v).addEventListener('click', () => openBillSheet(null));
}

export async function payBill(billId){
  const bill = state.bills.find(b => b.id === billId);
  if (!bill) return;
  const { year, month } = state.selected;
  const ym = `${year}-${String(month).padStart(2,'0')}`;
  if ((bill.paidMonths || {})[ym]) { toast('Already paid'); return; }

  // For auto-cc bills, use the LIVE balance of the linked card. If the
  // balance is zero (already paid down some other way), there's nothing
  // to pay — bail out cleanly rather than logging a $0 transaction.
  const isAuto = bill.recurrence === 'auto-cc';
  const payAmount = round2(isAuto ? getBillAmount(bill) : bill.amount);
  if (isAuto && payAmount <= 0){
    toast('Nothing to pay — balance is $0');
    return;
  }

  const now = new Date();
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
  // Pick the txn date: today if you're paying in the current month
  // (matches reality), otherwise use the bill's actual dueDate (for
  // one-time) or fabricate one from the month + dueDay (for monthly/auto).
  let dateIso;
  if (isCurrent){
    dateIso = today();
  } else if (bill.recurrence === 'once' && bill.dueDate){
    dateIso = bill.dueDate;
  } else {
    const dueDay = getBillDueDay(bill);
    dateIso = `${year}-${String(month).padStart(2,'0')}-${String(Math.min(dueDay, 28)).padStart(2,'0')}`;
  }

  // For auto-cc, the txn must target the linked CC account (so the
  // payment actually pays it down). For standard bills, use bill.account.
  const txnAccount = isAuto ? bill.linkedAccount : bill.account;

  const txn = {
    id: uid(),
    date: dateIso,
    type: bill.type || 'Expense',
    account: txnAccount,
    category: bill.category || bill.name,
    description: bill.name + ' (auto)',
    amount: payAmount,
    fromAccount: bill.fromAccount || null
  };
  await dbPut('transactions', txn);
  state.transactions.unshift(txn);
  state.transactions.sort((a,b) => b.date.localeCompare(a.date));
  await cascadeForChange(null, txn);

  bill.paidMonths = bill.paidMonths || {};
  bill.paidMonths[ym] = txn.id;
  await dbPut('bills', bill);

  haptic(15); /* NEW(v2.2) */
  toast('Marked paid · transaction logged');
  renderCurrent();
}

export async function unpayBill(billId){
  const bill = state.bills.find(b => b.id === billId);
  if (!bill) return;
  const { year, month } = state.selected;
  const ym = `${year}-${String(month).padStart(2,'0')}`;
  const txnId = (bill.paidMonths || {})[ym];
  if (!txnId) return;
  const removedTxn = state.transactions.find(t => t.id === txnId);
  // FIX(v2.9.1): soft delete + Undo, like every other delete path. This was
  // a hard dbDel — and for an auto-cc bill the destroyed payment recorded
  // the balance AT PAY TIME, so a mistap couldn't be recreated by re-paying
  // (that logs today's live balance, a different number).
  if (removedTxn) await trashTxn(removedTxn);
  await dbDel('transactions', txnId);
  state.transactions = state.transactions.filter(t => t.id !== txnId);
  if (removedTxn) await cascadeForChange(removedTxn, null);
  delete bill.paidMonths[ym];
  await dbPut('bills', bill);
  renderCurrent();
  if (removedTxn){
    toastAction('Unpaid · payment moved to trash', 'Undo', async () => {
      await restoreTxn({ ...removedTxn, deletedAt: Date.now() });
      bill.paidMonths = bill.paidMonths || {};
      bill.paidMonths[ym] = removedTxn.id;
      await dbPut('bills', bill);
      renderCurrent();
      toast('Payment restored');
    });
  } else {
    toast('Unpaid');
  }
}

/* FIX(v1.2): the bill editor used six native <select> elements (type, account,
   from, active, linked card, auto pay-from). Native select popups misbehave in
   standalone PWA mode on Samsung Internet on foldables — the exact reason the
   openPicker() bottom-sheet system exists — and the project rule is "no native
   <select>, ever". The editor is now driven by a form-state object: text/number
   inputs persist on input, pickers update state, and the sheet re-renders in
   place (openPicker leaves the sheet open per the v1.1 contract). */
export function openBillSheet(billId){
  const accts = state.accounts.filter(a => a.active);
  const checking = accts.filter(a => a.type === 'Checking');
  const ccAccts = accts.filter(a => a.type === 'Credit Card');
  const existing = billId ? state.bills.find(b => b.id === billId) : null;
  const todayIso = today();

  // Mutable form state — survives re-renders triggered by pickers.
  const f = {
    name: existing?.name || '',
    recurrence: existing?.recurrence || 'monthly',
    amount: existing ? String(existing.amount ?? '') : '',
    dueDay: existing?.dueDay || 1,
    dueDate: existing?.dueDate || todayIso,
    type: existing?.type || 'Expense',
    account: existing?.account || checking[0]?.name || accts[0]?.name || '',
    fromAccount: existing?.fromAccount || checking[0]?.name || '',
    category: existing?.category || '',
    active: existing ? existing.active !== false : true,
    linkedAccount: existing?.linkedAccount || ccAccts[0]?.name || '',
    closeDay: existing?.closeDay || 15,
    graceDays: existing?.graceDays != null ? existing.graceDays : 21
  };

  const acctOptionsForType = () => {
    if (f.type === 'CC Payment')   return accts.filter(a => a.type === 'Credit Card');
    if (f.type === 'Loan Payment') return accts.filter(a => a.type === 'Loan');
    return accts;
  };
  const acctLabelForType = () => {
    if (f.type === 'CC Payment')   return 'Card to pay';
    if (f.type === 'Loan Payment') return 'Loan to pay';
    return 'Account';
  };
  const needsFrom = () => f.type === 'CC Payment' || f.type === 'Loan Payment';

  const pickerBtn = (id, label, value) => `
    <div class="field">
      <label>${label}</label>
      <button class="input picker-btn" id="${id}" type="button">
        <span class="picker-val">${esc(value || '—')}</span>
        <span class="picker-chev">▾</span>
      </button>
    </div>
  `;

  function render(){
    const isAuto = f.recurrence === 'auto-cc';
    const isOnce = f.recurrence === 'once';

    // Keep account valid for the chosen type
    const acctOpts = acctOptionsForType();
    if (!acctOpts.find(a => a.name === f.account)) f.account = acctOpts[0]?.name || '';
    if (needsFrom() && !checking.find(a => a.name === f.fromAccount)) f.fromAccount = checking[0]?.name || '';

    $('#sheetBody').innerHTML = `
      <h2>${existing ? 'Edit' : 'New'} Bill</h2>
      <div class="field"><label>Name</label><input class="input" id="bf-name" value="${esc(f.name)}" placeholder="e.g. Rent, Streaming, Card Payment" /></div>
      <div class="field">
        <label>Recurrence</label>
        <div class="seg seg-3" id="bf-recur" role="tablist">
          <button type="button" class="seg-btn ${f.recurrence==='monthly'?'active':''}" data-rec="monthly">Monthly</button>
          <button type="button" class="seg-btn ${f.recurrence==='once'?'active':''}" data-rec="once">One-time</button>
          <button type="button" class="seg-btn ${f.recurrence==='auto-cc'?'active':''}" data-rec="auto-cc">Auto (CC)</button>
        </div>
      </div>

      ${isAuto ? `
        ${ccAccts.length === 0 ? `
          <div class="muted small" style="padding:14px;background:var(--bg-2);border:1px solid var(--line);border-radius:var(--r-sm);line-height:1.55;">
            You don't have any active Credit Card accounts yet. Add one in More → Accounts first, then come back to set up an auto-tracked bill.
          </div>
        ` : `
          ${pickerBtn('bf-linked', 'Track Credit Card', f.linkedAccount)}
          ${pickerBtn('bf-auto-from', 'Pay From (Checking)', f.fromAccount)}
          <div class="row-2">
            <div class="field"><label>Statement Closes (day)</label><input class="input" id="bf-close" type="number" min="1" max="31" inputmode="numeric" value="${f.closeDay}" /></div>
            <div class="field"><label>Grace Days</label><input class="input" id="bf-grace" type="number" min="0" max="60" inputmode="numeric" value="${f.graceDays}" /></div>
          </div>
          <div class="muted small" style="margin:-4px 0 14px;line-height:1.5;">
            Amount auto-tracks the live running balance of the linked card.
            Due day is computed from close + grace (e.g. close 15, grace 21 → due day 6 of next month).
            When you mark it paid, a CC Payment is logged for the current balance.
          </div>
        `}
      ` : `
        <div class="row-2">
          <div class="field"><label>Amount</label><input class="input" id="bf-amt" type="text" inputmode="decimal" placeholder="0.00" value="${esc(f.amount)}" /></div>
          ${isOnce
            ? `<div class="field"><label>Due Date</label><input class="input" id="bf-date" type="date" value="${f.dueDate}" /></div>`
            : `<div class="field"><label>Due Day (1–31)</label><input class="input" id="bf-day" type="number" min="1" max="31" inputmode="numeric" value="${f.dueDay}" /></div>`}
        </div>
        ${pickerBtn('bf-type', 'Type', f.type)}
        ${pickerBtn('bf-acct', acctLabelForType(), f.account)}
        ${needsFrom() ? pickerBtn('bf-from', 'From (Checking)', f.fromAccount) : ''}
        <div class="field"><label>Category <span class="muted small">(optional)</span></label><input class="input" id="bf-cat" value="${esc(f.category)}" placeholder="e.g. Subscriptions" /></div>
      `}

      <div class="field">
        <label>Active?</label>
        <div class="seg" id="bf-active" role="tablist">
          <button type="button" class="seg-btn ${f.active?'active':''}" data-active="true">Yes</button>
          <button type="button" class="seg-btn ${!f.active?'active':''}" data-active="false">No (paused)</button>
        </div>
      </div>
      <button class="btn" id="bf-save">Save Bill</button>
      ${existing ? '<button class="btn danger" id="bf-del" style="margin-top:10px;">Delete Bill</button>' : ''}
    `;
    wire();
  }

  function wire(){
    const isAuto = f.recurrence === 'auto-cc';
    const isOnce = f.recurrence === 'once';

    $$('.seg-btn', $('#bf-recur')).forEach(btn => btn.addEventListener('click', () => {
      const target = btn.dataset.rec;
      if (target === 'auto-cc' && ccAccts.length === 0){
        toast('Add a Credit Card account first');
        return;
      }
      f.recurrence = target;
      render();
    }));
    $$('.seg-btn', $('#bf-active')).forEach(btn => btn.addEventListener('click', () => {
      f.active = btn.dataset.active === 'true';
      $$('.seg-btn', $('#bf-active')).forEach(x => x.classList.toggle('active', x === btn));
    }));

    $('#bf-name').addEventListener('input', e => f.name = e.target.value);

    if (isAuto && ccAccts.length){
      $('#bf-linked').addEventListener('click', () => {
        openPicker('Track Credit Card', ccAccts.map(a => a.name), f.linkedAccount, (val) => {
          f.linkedAccount = val;
          render();
        });
      });
      $('#bf-auto-from').addEventListener('click', () => {
        openPicker('Pay From (Checking)', checking.map(a => a.name), f.fromAccount, (val) => {
          f.fromAccount = val;
          render();
        });
      });
      $('#bf-close').addEventListener('input', e => f.closeDay = clamp(parseInt(e.target.value)||1, 1, 31));
      $('#bf-grace').addEventListener('input', e => f.graceDays = clamp(parseInt(e.target.value)||0, 0, 60));
    } else if (!isAuto){
      $('#bf-amt').addEventListener('input', e => f.amount = e.target.value);
      if (isOnce) $('#bf-date').addEventListener('input', e => f.dueDate = e.target.value);
      else $('#bf-day').addEventListener('input', e => f.dueDay = clamp(parseInt(e.target.value)||1, 1, 31));
      $('#bf-cat').addEventListener('input', e => f.category = e.target.value);

      $('#bf-type').addEventListener('click', () => {
        openPicker('Bill Type', ['Expense','CC Payment','Loan Payment'], f.type, (val) => {
          f.type = val;
          render();
        });
      });
      $('#bf-acct').addEventListener('click', () => {
        const opts = acctOptionsForType().map(a => a.name);
        openPicker(acctLabelForType(), opts, f.account, (val) => {
          f.account = val;
          render();
        });
      });
      if (needsFrom()){
        $('#bf-from').addEventListener('click', () => {
          openPicker('From (Checking)', checking.map(a => a.name), f.fromAccount, (val) => {
            f.fromAccount = val;
            render();
          });
        });
      }
    }

    $('#bf-save').addEventListener('click', save);
    if (existing){
      $('#bf-del').addEventListener('click', async () => {
        // FIX(v2.9.2): immediate delete + Undo toast instead of confirm().
        // Past payment transactions are preserved either way.
        const removed = { ...existing, paidMonths: { ...(existing.paidMonths || {}) } };
        await dbDel('bills', existing.id);
        state.bills = state.bills.filter(b => b.id !== existing.id);
        closeSheet(); renderCurrent();
        toastAction(`Deleted "${removed.name}"`, 'Undo', async () => {
          await dbPut('bills', removed);
          state.bills.push(removed);
          state.bills.sort((a,b) => (a.dueDay||0) - (b.dueDay||0));
          renderCurrent();
          toast('Bill restored');
        });
      });
    }
  }

  async function save(){
    const isOnce = f.recurrence === 'once';
    const isAuto = f.recurrence === 'auto-cc';

    const obj = {
      id: existing?.id || uid(),
      name: f.name.trim(),
      recurrence: f.recurrence,
      active: f.active,
      paidMonths: existing?.paidMonths || {},
      notes: existing?.notes || ''
    };
    if (!obj.name) { toast('Name required'); return; }

    if (isAuto){
      if (!f.linkedAccount){ toast('Pick a credit card to track'); return; }
      if (!f.fromAccount){ toast('Pick a checking account to pay from'); return; }
      const closeDay = clamp(f.closeDay||1, 1, 31);
      const graceDays = clamp(f.graceDays||0, 0, 60);
      Object.assign(obj, {
        // amount is irrelevant for auto-cc (always re-read live via
        // getBillAmount) but stored as 0 for backward compat.
        amount: 0,
        dueDay: ((closeDay + graceDays - 1) % 30) + 1,
        dueDate: '',
        type: 'CC Payment',
        account: f.linkedAccount,   // existing CC Payment txn flow expects this
        fromAccount: f.fromAccount,
        category: 'CC Payment',
        linkedAccount: f.linkedAccount,
        closeDay,
        graceDays
      });
    } else {
      let dueDay, dueDate;
      if (isOnce){
        dueDate = f.dueDate;
        if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)){
          toast('Pick a valid due date'); return;
        }
        dueDay = parseInt(dueDate.slice(8,10), 10);
      } else {
        dueDay = clamp(f.dueDay||1, 1, 31);
        dueDate = '';
      }
      // FIX(v1.2): bill amounts go through parseAmount (same comma/$ safety
      // and cent-rounding as the Add form).
      const amount = parseAmount(f.amount);
      if (isNaN(amount) || amount <= 0){ toast('Enter a valid amount'); return; }
      if (!f.account){ toast('Pick an account'); return; }
      Object.assign(obj, {
        amount, dueDay, dueDate,
        type: f.type,
        account: f.account,
        fromAccount: needsFrom() ? f.fromAccount : null,
        category: f.category.trim(),
        // Clear auto-cc fields if switching back from auto-cc
        linkedAccount: '',
        closeDay: 0,
        graceDays: 0
      });
    }

    await dbPut('bills', obj);
    const i = state.bills.findIndex(x => x.id === obj.id);
    if (i >= 0) state.bills[i] = obj; else state.bills.push(obj);
    state.bills.sort((a,b) => (a.dueDay||0) - (b.dueDay||0));
    closeSheet();
    renderCurrent();

    // If this is a one-time bill landing in a different month than the
    // one currently being viewed, tell the user where it went so they
    // don't think the save silently failed.
    if (isOnce){
      const sel = state.selected;
      const billMonth = obj.dueDate.slice(0,7);
      const selMonth = `${sel.year}-${String(sel.month).padStart(2,'0')}`;
      if (billMonth !== selMonth){
        const [yr, mo] = billMonth.split('-').map(Number);
        toast(`Saved · shows in ${monthName(mo, true)} ${yr}`);
        return;
      }
    }
    toast('Saved');
  }

  render();
  openSheet();
}
