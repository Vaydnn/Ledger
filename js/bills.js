/* ============================================================
   bills.js — Bills tab view + bill edit sheet + pay/unpay actions.

   v1.1.2: bills can be one-time (recurrence: 'once') with a full dueDate.
   v1.1.3: 'auto-cc' bills track a linked card's live balance.
   v3.0:
   - An UNPAID one-time bill no longer vanishes when its month ends — it
     carries forward as overdue (and keeps counting against Real Available)
     until it's paid. A one-time bill is paid once, in whatever month.
   - "Looks paid": a transaction logged by hand that matches an unpaid bill
     (same account + type, amount within 10%, name/category agree) is offered
     as the payment — one tap links it instead of the bill sitting unpaid and
     being subtracted from Real Available a second time.
   - Pay / Unpay / Save are double-tap safe.
   ============================================================ */

import { $, $$, fmt, fmtShort, monthName, today, uid, clamp, toast, toastAction, sumMoney, round2, parseAmount, toCents, fromCents, haptic, esc, squash, ymOf, currentYm, daysBetween, busyGuard } from './util.js';
import { state, dbPut, dbDel } from './db.js';
import { balanceAt, balanceLatest } from './effects.js';
import { openSheet, closeSheet, openPicker } from './sheet.js';
import { renderCurrent } from './app.js';
import { trashTxn, restoreTxn } from './trash.js';

/* ── Paid state ─────────────────────────────────────────────────────── */
// paidMonths maps 'YYYY-MM' → id of the payment transaction. A monthly bill
// is paid per month; a one-time bill is paid once, whichever month that was.
export function isBillPaid(bill, ym){
  const pm = bill.paidMonths || {};
  if (bill.recurrence === 'once') return Object.values(pm).some(Boolean);
  return !!pm[ym];
}
function paidKey(bill, ym){
  const pm = bill.paidMonths || {};
  if (bill.recurrence === 'once') return Object.keys(pm).find(k => pm[k]) || null;
  return pm[ym] ? ym : null;
}
// Is this transaction already recorded as some bill's payment?
export function linkedBillFor(txnId){
  return state.bills.find(b => Object.values(b.paidMonths || {}).includes(txnId)) || null;
}

// True if this bill should appear in the views for the given (year, month).
// - Monthly and auto-cc bills always apply.
// - One-time bills apply in their due month; FIX(v3.0) — and, while unpaid,
//   in every later month up to the current one (they're still owed), plus
//   the month they were eventually paid in.
// Missing recurrence = 'monthly' (pre-1.1.2 data).
export function billAppliesToMonth(bill, year, month){
  const rec = bill.recurrence || 'monthly';
  if (rec === 'monthly' || rec === 'auto-cc') return true;
  if (rec === 'once'){
    if (!bill.dueDate) return false;
    const ym = ymOf(year, month);
    const due = bill.dueDate.slice(0, 7);
    if (due === ym) return true;
    if (due > ym) return false;
    if ((bill.paidMonths || {})[ym]) return true;          // paid late, in this month
    return !isBillPaid(bill, ym) && ym <= currentYm();      // still owed
  }
  return true;
}

// Effective amount owed for a bill — live for auto-cc, stored otherwise.
// FIX(v2.9.1): optional (year, month) context — past months read the card's
// balance as of that month instead of today's.
export function getBillAmount(bill, year, month){
  if (bill.recurrence !== 'auto-cc') return bill.amount || 0;
  if (!bill.linkedAccount) return 0;
  const now = new Date();
  const isLive = year == null || (year === now.getFullYear() && month === now.getMonth() + 1);
  const bal = isLive ? balanceLatest(bill.linkedAccount) : balanceAt(bill.linkedAccount, year, month);
  return Math.max(0, Math.round(bal * 100) / 100);
}

/* ── NEW(v2.9.1): the single source of truth for "Real available" ────── */
export function computeRealAvailable(year, month){
  const ym = ymOf(year, month);
  const billsThisMonth = state.bills.filter(b => b.active !== false && billAppliesToMonth(b, year, month));
  const stdUnpaid = billsThisMonth.filter(b => b.recurrence !== 'auto-cc' && !isBillPaid(b, ym));
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
    ...autoCcAll.filter(b => getBillAmount(b, year, month) > 0 && !isBillPaid(b, ym))
  ];

  const cardDeduct = fromCents(cardDeductC);
  return {
    cash, upcomingTotal, cardLines, cardDeduct,
    stdUnpaid, autoCcAll, unpaidBills,
    realAvailable: round2(cash - upcomingTotal - cardDeduct)
  };
}

// Effective dueDay for status display + sorting. For auto-cc, this is
// (closeDay + graceDays) wrapped into 1..30.
export function getBillDueDay(bill){
  if (bill.recurrence !== 'auto-cc') return bill.dueDay || 1;
  const close = bill.closeDay || 1;
  const grace = bill.graceDays != null ? bill.graceDays : 21;
  const sum = close + grace;
  return ((sum - 1) % 30) + 1;
}

export function billStatus(b, ym, isCurrentMonth, todayDay){
  if (isBillPaid(b, ym)) return { kind:'paid', label:'Paid' };
  // NEW(v3.0): a one-time bill carried past its due month.
  if (b.recurrence === 'once' && b.dueDate && b.dueDate.slice(0, 7) < ym){
    const days = daysBetween(b.dueDate, today());
    return { kind:'overdue', label: days > 0 ? `${days}d overdue` : 'Overdue' };
  }
  if (!isCurrentMonth) return { kind:'future', label:'' };
  const due = getBillDueDay(b);
  const days = due - todayDay;
  if (days < 0) return { kind:'overdue', label:`${-days}d overdue` };
  if (days === 0) return { kind:'today', label:'Due today' };
  if (days <= 3) return { kind:'soon', label:`Due in ${days}d` };
  return { kind:'future', label:`Due in ${days}d` };
}

/* ── NEW(v3.0): matching hand-logged transactions to bills ───────────── */
export function billMatchesTxn(b, t){
  if (!b || !t || b.active === false) return false;
  if (b.recurrence === 'auto-cc') return t.type === 'CC Payment' && t.account === b.linkedAccount;
  const type = b.type || 'Expense';
  if (t.type !== type || t.account !== b.account) return false;
  if (b.fromAccount && t.fromAccount && t.fromAccount !== b.fromAccount) return false;
  const amt = b.amount || 0;
  if (Math.abs((t.amount || 0) - amt) > Math.max(1, amt * 0.1)) return false;
  // A plain expense on a busy card needs more than the amount to agree —
  // the bill's name or category must show up on the transaction.
  if (type === 'Expense'){
    const name = squash(b.name);
    const hay = squash(`${t.description || ''} ${t.category || ''}`);
    const catHit = b.category && t.category === b.category;
    if (!catHit && !(name.length >= 3 && hay.includes(name))) return false;
  }
  return true;
}

// The unpaid bill (if any) a just-saved transaction most likely pays.
export function findMatchingBill(t){
  if (!t || !t.date || linkedBillFor(t.id)) return null;
  const ym = t.date.slice(0, 7);
  const [y, m] = ym.split('-').map(Number);
  const cands = state.bills.filter(b =>
    billAppliesToMonth(b, y, m) && !isBillPaid(b, ym) && billMatchesTxn(b, t));
  cands.sort((a, b) => Math.abs((a.amount || 0) - t.amount) - Math.abs((b.amount || 0) - t.amount));
  return cands[0] || null;
}

// The transaction (if any) in a month that looks like this bill's payment.
export function findPaymentForBill(b, ym){
  const linked = new Set();
  for (const bb of state.bills) for (const id of Object.values(bb.paidMonths || {})) linked.add(id);
  const hits = state.transactions.filter(t => t.date && t.date.slice(0, 7) === ym && !linked.has(t.id) && billMatchesTxn(b, t));
  hits.sort((a, c) => Math.abs(a.amount - (b.amount || 0)) - Math.abs(c.amount - (b.amount || 0)));
  return hits[0] || null;
}

export async function markBillPaidWith(bill, ym, txnId){
  bill.paidMonths = bill.paidMonths || {};
  bill.paidMonths[ym] = txnId;
  await dbPut('bills', bill);
  haptic(15);
  toast(`"${bill.name}" marked paid`);
  renderCurrent();
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
  // NEW(v3.0): an unpaid bill with a matching hand-logged transaction.
  const match = !isPaid ? findPaymentForBill(b, ym) : null;
  return `
    <div class="bill-row ${isPaid ? 'is-paid' : ''}" data-bill-id="${esc(b.id)}">
      <button class="bill-check ${isPaid ? 'checked' : ''}" data-id="${esc(b.id)}" aria-label="Toggle paid">
        ${isPaid ? '<svg viewBox="0 0 14 14" width="14" height="14"><path d="M2 7l3.5 3.5L12 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
      </button>
      <div class="bill-body">
        <div class="bill-name">${esc(b.name)}${tag}</div>
        <div class="bill-meta">
          <span class="bill-status ${st.kind}">${st.label || (isOnce ? `Due ${esc(b.dueDate)}` : `Day ${dueDay}`)}</span>
          <span class="bill-acct">· ${acctMeta}</span>
        </div>
        ${match ? `
          <div class="bill-match">
            Looks paid: ${fmt(match.amount)} on ${esc(match.date.slice(5))}${match.description ? ' · ' + esc(match.description) : ''}
            <button type="button" class="bill-link" data-bill="${esc(b.id)}" data-txn="${esc(match.id)}" data-ym="${ym}">Link</button>
          </div>` : ''}
      </div>
      <div class="bill-amt mono">${fmtShort(liveAmount)}</div>
    </div>
  `;
}

// NEW(v3.0): wiring shared by the Bills view and Home's Upcoming card.
export function wireBillRows(root){
  $$('.bill-link', root).forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const bill = state.bills.find(b => b.id === btn.dataset.bill);
    if (bill) markBillPaidWith(bill, btn.dataset.ym, btn.dataset.txn);
  }));
}

export function renderBills(){
  const v = $('#view-bills');
  const { year, month } = state.selected;
  const ym = ymOf(year, month);
  const isCurrentMonth = (year === new Date().getFullYear() && month === new Date().getMonth() + 1);
  const todayDay = new Date().getDate();

  const bills = state.bills.filter(b => b.active !== false && billAppliesToMonth(b, year, month));

  // Standard bills: static amount; once paid it stops counting as unpaid.
  // Auto-cc bills: amount is the LIVE balance and always counts — paying
  // just zeroes it, and new charges re-accrue immediately.
  const standardBills = bills.filter(b => b.recurrence !== 'auto-cc');
  const autoCcBills   = bills.filter(b => b.recurrence === 'auto-cc');

  const stdTotal = sumMoney(standardBills, b => b.amount || 0);
  const stdPaid  = sumMoney(standardBills.filter(b => isBillPaid(b, ym)), b => b.amount || 0);
  const autoCcLive = sumMoney(autoCcBills, b => getBillAmount(b, year, month));

  const totalDue    = round2(stdTotal + autoCcLive);
  const paidTotal   = stdPaid;
  const unpaidTotal = round2((stdTotal - stdPaid) + autoCcLive);

  const ra = computeRealAvailable(year, month);

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

  // FIX(v2.10.1): paused bills render in a dimmed section so they can be
  // reactivated (tap opens the editor).
  const pausedBills = state.bills
    .filter(b => b.active === false)
    .sort((a, b) => getBillDueDay(a) - getBillDueDay(b));
  const pausedRowHTML = (b) => {
    const isOnce = b.recurrence === 'once';
    const isAuto = b.recurrence === 'auto-cc';
    const acctMeta = isAuto
      ? `Tracks ${esc(b.linkedAccount)}`
      : (b.fromAccount ? `${esc(b.fromAccount)} → ${esc(b.account)}` : esc(b.account));
    const tag = isOnce ? ' <span class="bill-once-tag">Once</span>'
             : isAuto ? ' <span class="bill-auto-tag">Auto</span>'
             : '';
    return `
      <div class="bill-row is-paused" data-bill-id="${esc(b.id)}" style="opacity:.55;">
        <div class="bill-body" style="margin-left:0;">
          <div class="bill-name">${esc(b.name)}${tag}</div>
          <div class="bill-meta">
            <span class="bill-status future">Paused</span>
            <span class="bill-acct">· ${acctMeta}</span>
          </div>
        </div>
        <div class="bill-amt mono">${b.recurrence === 'auto-cc' ? '—' : fmtShort(b.amount || 0)}</div>
      </div>
    `;
  };
  const pausedHTML = pausedBills.length ? `
    <div class="bill-section">
      <div class="bill-section-head">Paused <span class="muted small">${pausedBills.length}</span></div>
      ${pausedBills.map(pausedRowHTML).join('')}
      <div class="muted small" style="padding:6px 2px 0;">Paused bills don't count toward totals. Tap one to edit and set Active to Yes.</div>
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

    ${bills.length === 0 && pausedBills.length === 0 ? `
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
      ${pausedHTML}
    `}

    <button class="btn" id="add-bill" style="margin-top:18px;">+ Add Bill</button>
  `;

  $$('.bill-check', v).forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const bill = state.bills.find(x => x.id === b.dataset.id);
    if (!bill) return;
    if (isBillPaid(bill, ym)) unpayBill(bill.id);
    else payBill(bill.id);
  }));
  wireBillRows(v);
  $$('.bill-row[data-bill-id]', v).forEach(el => el.addEventListener('click', () => openBillSheet(el.dataset.billId)));
  $('#add-bill', v).addEventListener('click', () => openBillSheet(null));
}

// FIX(v3.0): double-tap safe, per bill — two quick taps used to log two
// payment transactions (and orphan the first).
export const payBill = busyGuard(async (billId) => {
  const bill = state.bills.find(b => b.id === billId);
  if (!bill) return;
  const { year, month } = state.selected;
  const ym = ymOf(year, month);
  if (isBillPaid(bill, ym)) { toast('Already paid'); return; }

  // Auto-cc: the linked card's balance FOR THE VIEWED MONTH (FIX v2.10.2).
  const isAuto = bill.recurrence === 'auto-cc';
  const payAmount = round2(isAuto ? getBillAmount(bill, year, month) : bill.amount);
  if (isAuto && payAmount <= 0){
    toast('Nothing to pay — balance is $0');
    return;
  }

  const now = new Date();
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
  // Today if paying in the current month; otherwise the bill's dueDate (one-
  // time, if it's in the viewed month) or the month + dueDay.
  let dateIso;
  if (isCurrent){
    dateIso = today();
  } else if (bill.recurrence === 'once' && bill.dueDate && bill.dueDate.slice(0, 7) === ym){
    dateIso = bill.dueDate;
  } else {
    const dueDay = getBillDueDay(bill);
    dateIso = `${ym}-${String(Math.min(dueDay, 28)).padStart(2,'0')}`;
  }

  const txn = {
    id: uid(),
    date: dateIso,
    type: bill.type || 'Expense',
    account: isAuto ? bill.linkedAccount : bill.account,
    category: bill.category || bill.name,
    description: bill.name + ' (auto)',
    amount: payAmount,
    fromAccount: bill.fromAccount || null
  };
  await dbPut('transactions', txn);
  state.transactions.unshift(txn);
  state.transactions.sort((a,b) => (b.date||'').localeCompare(a.date||''));

  bill.paidMonths = bill.paidMonths || {};
  bill.paidMonths[ym] = txn.id;
  await dbPut('bills', bill);

  haptic(15); /* NEW(v2.2) */
  toast('Marked paid · transaction logged');
  renderCurrent();
}, (billId) => billId);

export const unpayBill = busyGuard(async (billId) => {
  const bill = state.bills.find(b => b.id === billId);
  if (!bill) return;
  const { year, month } = state.selected;
  const key = paidKey(bill, ymOf(year, month));
  if (!key) return;
  const txnId = bill.paidMonths[key];
  const removedTxn = state.transactions.find(t => t.id === txnId);
  // FIX(v2.9.1): soft delete + Undo, like every other delete path.
  if (removedTxn) await trashTxn(removedTxn);
  await dbDel('transactions', txnId);
  state.transactions = state.transactions.filter(t => t.id !== txnId);
  delete bill.paidMonths[key];
  await dbPut('bills', bill);
  renderCurrent();
  if (removedTxn){
    toastAction('Unpaid · payment moved to trash', 'Undo', async () => {
      await restoreTxn({ ...removedTxn, deletedAt: Date.now() });
      bill.paidMonths = bill.paidMonths || {};
      bill.paidMonths[key] = removedTxn.id;
      await dbPut('bills', bill);
      renderCurrent();
      toast('Payment restored');
    });
  } else {
    toast('Unpaid');
  }
}, (billId) => billId);

/* FIX(v1.2): the bill editor is driven by a form-state object (no native
   <select>s — they misbehave in standalone PWA mode on Samsung Internet). */
export function openBillSheet(billId){
  const existing = billId ? state.bills.find(b => b.id === billId) : null;
  // FIX(v3.1): a bill pointing at a CLOSED account kept being re-pointed to
  // the first open account on save. Its own accounts stay on offer.
  const own = existing ? [existing.account, existing.fromAccount, existing.linkedAccount] : [];
  const accts = state.accounts.filter(a => a.active || own.includes(a.name));
  const checking = accts.filter(a => a.type === 'Checking');
  const ccAccts = accts.filter(a => a.type === 'Credit Card');
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
            <div class="field"><label>Statement Closes (day)</label><input class="input" id="bf-close" type="number" min="1" max="31" inputmode="numeric" value="${esc(f.closeDay)}" /></div>
            <div class="field"><label>Grace Days</label><input class="input" id="bf-grace" type="number" min="0" max="60" inputmode="numeric" value="${esc(f.graceDays)}" /></div>
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
            ? `<div class="field"><label>Due Date</label><input class="input" id="bf-date" type="date" value="${esc(f.dueDate)}" /></div>`
            : `<div class="field"><label>Due Day (1–31)</label><input class="input" id="bf-day" type="number" min="1" max="31" inputmode="numeric" value="${esc(f.dueDay)}" /></div>`}
        </div>
        ${pickerBtn('bf-type', 'Type', f.type)}
        ${pickerBtn('bf-acct', acctLabelForType(), f.account)}
        ${needsFrom() ? pickerBtn('bf-from', 'From (Checking)', f.fromAccount) : ''}
        <div class="field"><label>Category <span class="muted small">(optional — helps match bills you log by hand)</span></label><input class="input" id="bf-cat" value="${esc(f.category)}" placeholder="e.g. Subscriptions" /></div>
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
      $('#bf-del').addEventListener('click', busyGuard(async () => {
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
      }));
    }
  }

  const save = busyGuard(async () => {
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
        amount: 0,   // irrelevant for auto-cc (always read live)
        dueDay: ((closeDay + graceDays - 1) % 30) + 1,
        dueDate: '',
        type: 'CC Payment',
        account: f.linkedAccount,
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
      const amount = parseAmount(f.amount);
      if (isNaN(amount) || amount <= 0){ toast('Enter a valid amount'); return; }
      if (!f.account){ toast('Pick an account'); return; }
      Object.assign(obj, {
        amount, dueDay, dueDate,
        type: f.type,
        account: f.account,
        fromAccount: needsFrom() ? f.fromAccount : null,
        category: f.category.trim(),
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

    // A one-time bill landing in a different month than the one being
    // viewed: say where it went so the save doesn't look lost.
    if (isOnce){
      const sel = state.selected;
      const billMonth = obj.dueDate.slice(0,7);
      if (billMonth > ymOf(sel.year, sel.month)){
        const [yr, mo] = billMonth.split('-').map(Number);
        toast(`Saved · shows in ${monthName(mo, true)} ${yr}`);
        return;
      }
    }
    toast('Saved');
  });

  render();
  openSheet();
}
