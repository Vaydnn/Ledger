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
   v3.2:
   - VARIABLE bills (a phone bill): monthly, but the amount changes. The bill
     carries an estimate (3-month average of what it actually was, last
     month's, or a fixed number); each month's actual is entered when it
     arrives, or picked up from the payment you log. bill.amounts maps
     'YYYY-MM' → actual; bill.amount tracks the current estimate so older
     builds and the reminder worker still read something sensible.
   - Link any transaction to a bill by hand (a payment that is a different
     amount, or from a different checking account, than the bill says).
   - Payment matching no longer requires the same From account.
   ============================================================ */

import { $, $$, fmt, fmtShort, monthName, today, uid, clamp, toast, toastAction, sumMoney, round2, parseAmount, toCents, fromCents, haptic, esc, squash, ymOf, currentYm, daysBetween, busyGuard } from './util.js';
import { state, dbPut, dbDel, dataVersion } from './db.js';
import { balanceAt, balanceLatest } from './effects.js';
import { openSheet, closeSheet, openPicker } from './sheet.js';
import { renderCurrent } from './app.js';
import { trashTxn, restoreTxn } from './trash.js';
import { isWide } from './layout.js';   // NEW(v3.1)
import { statementInfo } from './statement.js';   // NEW(v3.1)
import { openNextMonthSheet, openPayRunSheet } from './nextmonth.js';   // NEW(v3.2)
import { openCardSheet } from './cards.js';                             // NEW(v3.2)

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

/* ── NEW(v3.2): variable-amount bills ─────────────────────────────────── */
export const isVariableBill = (b) => !!b && b.variable === true && (b.recurrence || 'monthly') === 'monthly';

// id → transaction, rebuilt when the data changes (history reads this a lot).
let _txnMap = null, _txnStamp = '';
function txnById(id){
  const stamp = `${dataVersion.n}|${state.transactions.length}`;
  if (!_txnMap || stamp !== _txnStamp){
    _txnMap = new Map(state.transactions.map(t => [t.id, t]));
    _txnStamp = stamp;
  }
  return _txnMap.get(id) || null;
}

// What a variable bill actually came to in a month: the amount entered, else
// the payment transaction it's linked to, else null (not known yet).
export function billActual(bill, ym){
  const v = (bill.amounts || {})[ym];
  if (v != null && isFinite(Number(v))) return round2(v);
  const id = (bill.paidMonths || {})[ym];
  const t = id ? txnById(id) : null;
  return t ? round2(t.amount) : null;
}
// [[ym, amount], …] oldest → newest — every month with a known actual.
export function billHistory(bill){
  const yms = new Set([...Object.keys(bill.amounts || {}), ...Object.keys(bill.paidMonths || {})]);
  const out = [];
  for (const ym of [...yms].sort()){
    const a = billActual(bill, ym);
    if (a != null && a > 0) out.push([ym, a]);
  }
  return out;
}
// The estimate for a month, from the actuals BEFORE it.
export function billEstimate(bill, ym){
  const mode = bill.estMode || 'avg3';
  const hist = billHistory(bill).filter(([k]) => k < ym);
  if (mode !== 'fixed' && hist.length){
    if (mode === 'last') return hist[hist.length - 1][1];
    const last3 = hist.slice(-3);
    return round2(last3.reduce((s, [, a]) => s + a, 0) / last3.length);
  }
  return bill.amount || 0;
}
// A bill's amount for a month: fixed, or (variable) the actual once known,
// the estimate until then.
export function billMonthAmount(bill, ym){
  if (!isVariableBill(bill)) return bill.amount || 0;
  const a = billActual(bill, ym);
  return a != null ? a : billEstimate(bill, ym);
}
export const isBillEstimated = (bill, ym) => isVariableBill(bill) && billActual(bill, ym) == null;

// Record a month's actual and roll the stored estimate forward (a fixed
// estimate stays what the user typed). Caller saves the bill.
function setActual(bill, ym, amount){
  bill.amounts = { ...(bill.amounts || {}), [ym]: round2(amount) };
  if ((bill.estMode || 'avg3') !== 'fixed') bill.amount = billEstimate(bill, '9999-99') || bill.amount;
}

/* NEW(v3.2): "I'll pay X this month" on an Auto (CC) bill. The amount you plan
   to pay (bill.amounts['YYYY-MM']) replaces the statement/balance figure for
   that month in Real available, the pay run, the forecast and the Pay button;
   the difference from the statement stays on the card and the row says so. */
export function plannedPayment(bill, ym){
  if (!bill || bill.recurrence !== 'auto-cc') return null;
  const v = (bill.amounts || {})[ym];
  return v != null && isFinite(Number(v)) ? round2(v) : null;
}
// What you plan to pay on a card in a month (via its Auto (CC) bill), if anything.
export function plannedCardPayment(card, ym){
  const b = state.bills.find(x => x.recurrence === 'auto-cc' && x.active !== false && x.linkedAccount === card);
  return b && !isBillPaid(b, ym) ? plannedPayment(b, ym) : null;
}
async function setPlanned(bill, ym, amount){
  const next = { ...(bill.amounts || {}) };
  if (amount == null) delete next[ym]; else next[ym] = round2(amount);
  bill.amounts = next;
  await dbPut('bills', bill);
}

// Effective amount owed for a bill — live for auto-cc, stored otherwise.
// FIX(v2.9.1): optional (year, month) context — past months read the card's
// balance as of that month instead of today's.
export function getBillAmount(bill, year, month){
  if (bill.recurrence !== 'auto-cc') return billMonthAmount(bill, year == null ? currentYm() : ymOf(year, month));
  if (!bill.linkedAccount) return 0;
  const now = new Date();
  const isLive = year == null || (year === now.getFullYear() && month === now.getMonth() + 1);
  // NEW(v3.2): the amount you said you'll pay wins; and the NEXT month's bill
  // on a statement card is the statement that's due then (the one that has closed).
  const planned = plannedPayment(bill, year == null ? currentYm() : ymOf(year, month));
  if (planned != null) return planned;
  const nextYm = ymOf(now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear(), now.getMonth() === 11 ? 1 : now.getMonth() + 2);
  if (!isLive && bill.ccAmount === 'statement' && ymOf(year, month) === nextYm){
    const s = statementInfo(bill.linkedAccount);
    if (s) return s.remaining;
  }
  // NEW(v3.1): "pay the statement balance" — what's still due from the last
  // statement (the amount that avoids interest), not everything charged since.
  if (isLive && bill.ccAmount === 'statement'){
    const s = statementInfo(bill.linkedAccount);
    if (s) return s.remaining;
  }
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
    sumMoney(stdUnpaid, b => getBillAmount(b, year, month)) +
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

/* NEW(v3.2): is a detected recurring charge already one of the bills? By
   category or name (as before), or — what the old test missed — the same
   card, the same price (±5%) and the same time of month (±4 days): an ISP charge
   on 10/31 and 11/30 next to an Internet bill due the 2nd is ONE charge. */
export function seriesCoveredByBill(r){
  const dayGap = (a, b) => { const g = Math.abs(a - b); return Math.min(g, 30 - g); };
  return state.bills.some(b => {
    if (b.active === false || b.recurrence === 'auto-cc' || (b.type || 'Expense') !== 'Expense') return false;
    if (b.category && b.category === r.category) return true;
    if (squash(b.name).length >= 3 && squash(r.label).includes(squash(b.name))) return true;
    if (b.recurrence === 'once' || isVariableBill(b) || !r.primaryAccount || b.account !== r.primaryAccount || !r.last) return false;
    const amt = b.amount || 0;
    return Math.abs(r.medAmt - amt) <= Math.max(1, amt * 0.05) && dayGap(r.last.getDate(), b.dueDay || 0) <= 4;
  });
}

/* ── NEW(v3.0): matching hand-logged transactions to bills ───────────── */
export function billMatchesTxn(b, t){
  if (!b || !t || b.active === false) return false;
  if (b.recurrence === 'auto-cc') return t.type === 'CC Payment' && t.account === b.linkedAccount;
  const type = b.type || 'Expense';
  if (t.type !== type || t.account !== b.account) return false;
  // FIX(v3.2): the From account isn't part of the match — a payment made from
  // the other checking account is still that bill's payment.
  const amt = b.amount || 0;
  if (isVariableBill(b)){
    // The amount is the thing that varies: only a wildly different one rules it out.
    const est = billEstimate(b, (t.date || '').slice(0, 7)) || amt;
    if (est > 0 && ((t.amount || 0) < est * 0.4 || (t.amount || 0) > est * 2.5)) return false;
  } else if (Math.abs((t.amount || 0) - amt) > Math.max(1, amt * 0.1)) return false;
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
  cands.sort((a, b) => Math.abs(billMonthAmount(a, ym) - t.amount) - Math.abs(billMonthAmount(b, ym) - t.amount));
  return cands[0] || null;
}

// The transaction (if any) in a month that looks like this bill's payment.
export function findPaymentForBill(b, ym){
  const linked = new Set();
  for (const bb of state.bills) for (const id of Object.values(bb.paidMonths || {})) linked.add(id);
  const hits = state.transactions.filter(t => t.date && t.date.slice(0, 7) === ym && !linked.has(t.id) && billMatchesTxn(b, t));
  const want = billMonthAmount(b, ym);
  hits.sort((a, c) => Math.abs(a.amount - want) - Math.abs(c.amount - want));
  return hits[0] || null;
}

export async function markBillPaidWith(bill, ym, txnId){
  if (!txnId) return;
  bill.paidMonths = bill.paidMonths || {};
  bill.paidMonths[ym] = txnId;
  const t = isVariableBill(bill) ? txnById(txnId) : null;
  if (t) setActual(bill, ym, t.amount);     // NEW(v3.2): the payment IS the month's amount
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
  const isVar = isVariableBill(b);
  const est = isVar && !isPaid && isBillEstimated(b, ym);   // NEW(v3.2): amount not in yet
  // NEW(v3.2): an Auto (CC) bill shows the statement, what you plan to pay, and what's left.
  const stmt = isAuto && !isPaid && b.ccAmount === 'statement' ? statementInfo(b.linkedAccount) : null;
  const plan = isAuto && !isPaid ? plannedPayment(b, ym) : null;
  const planNote = isAuto && !isPaid
    ? (plan != null && stmt ? `Paying ${fmt(plan)} of the ${stmt.needsEntry ? '~' : ''}${fmt(stmt.remaining)} statement${plan < stmt.remaining - 0.004 ? ` · ${fmt(stmt.remaining - plan)} left` : ''}`
      : plan != null ? `Paying ${fmt(plan)}`
      : stmt ? (stmt.needsEntry ? `Statement ~${fmt(stmt.remaining)} still due (estimate — enter yours)` : `Statement ${fmt(stmt.remaining)} still due`) : '')
    : '';
  const tag = isOnce ? ' <span class="bill-once-tag">Once</span>'
           : isAuto ? ' <span class="bill-auto-tag">Auto</span>'
           : isVar ? ' <span class="bill-var-tag">Varies</span>'
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
          ${est ? `<button type="button" class="bill-enter" data-bill="${esc(b.id)}" data-ym="${ym}">Enter amount</button>` : ''}
          ${isAuto && !isPaid ? `<button type="button" class="bill-enter" data-bill="${esc(b.id)}" data-ym="${ym}">${plan != null ? 'Change payment' : 'Set payment'}</button>` : ''}
        </div>
        ${planNote ? `<div class="muted small" style="margin-top:4px;">${esc(planNote)}</div>` : ''}
        ${match ? `
          <div class="bill-match">
            Looks paid: ${fmt(match.amount)} on ${esc(match.date.slice(5))}${match.description ? ' · ' + esc(match.description) : ''}
            <button type="button" class="bill-link" data-bill="${esc(b.id)}" data-txn="${esc(match.id)}" data-ym="${ym}">Link</button>
          </div>` : ''}
      </div>
      <div class="bill-amt mono">${est ? '~' : ''}${fmtShort(liveAmount)}${est ? '<div class="bill-est">est.</div>' : ''}</div>
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
  $$('.bill-enter', root).forEach(btn => btn.addEventListener('click', (e) => {   // NEW(v3.2)
    e.stopPropagation();
    openBillAmountSheet(btn.dataset.bill, btn.dataset.ym);
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

  const stdTotal = sumMoney(standardBills, b => getBillAmount(b, year, month));
  const stdPaid  = sumMoney(standardBills.filter(b => isBillPaid(b, ym)), b => getBillAmount(b, year, month));
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
        <div class="bill-amt mono">${b.recurrence === 'auto-cc' ? '—' : fmtShort(getBillAmount(b))}</div>
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

  const mainHTML = `
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

    <div class="bill-tools">
      <button class="btn ghost" id="go-nextmonth" type="button">Next month →</button>
      <button class="btn ghost" id="go-payrun" type="button">Pay run</button>
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
  // NEW(v3.1): unfolded, a month calendar sits beside the list.
  v.innerHTML = isWide()
    ? `<div class="split"><div class="split-main">${mainHTML}</div><aside class="split-side">${billCalendarHTML(bills, year, month, isCurrentMonth, todayDay)}</aside></div>`
    : mainHTML;
  $$('.cal-bill', v).forEach(el => el.addEventListener('click', () => openBillSheet(el.dataset.billId)));

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
  $('#go-nextmonth', v).addEventListener('click', () => openNextMonthSheet());   // NEW(v3.2)
  $('#go-payrun', v).addEventListener('click', () => openPayRunSheet());          // NEW(v3.2)
}

/* ── NEW(v3.1): bills calendar (unfolded) ─────────────────────────────
   The month as a grid with each bill on its due day, colored by status.
   One-time bills carried from an earlier month (still unpaid) are listed
   under the grid — their due day isn't in this month. */
export function billCalendarHTML(bills, year, month, isCurrentMonth, todayDay){
  const ym = ymOf(year, month);
  const days = new Date(year, month, 0).getDate();
  const lead = new Date(year, month - 1, 1).getDay();
  const byDay = {};
  const carried = [];
  for (const b of bills){
    let d;
    if (b.recurrence === 'once'){
      if (!b.dueDate) continue;
      if (b.dueDate.slice(0, 7) !== ym){ carried.push(b); continue; }
      d = Number(b.dueDate.slice(8, 10));
    } else d = Math.min(getBillDueDay(b), days);
    (byDay[d] || (byDay[d] = [])).push(b);
  }
  const chip = (b) => {
    const st = billStatus(b, ym, isCurrentMonth, todayDay);
    return `<button type="button" class="cal-bill ${st.kind}" data-bill-id="${esc(b.id)}" title="${esc(b.name)}">${esc(b.name)} <span class="mono">${fmtShort(getBillAmount(b, year, month))}</span></button>`;
  };
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="cal-cell blank"></div>');
  for (let d = 1; d <= days; d++){
    const isToday = isCurrentMonth && d === todayDay;
    cells.push(`<div class="cal-cell${isToday ? ' today' : ''}${byDay[d] ? ' has' : ''}"><div class="cal-d">${d}</div>${(byDay[d] || []).map(chip).join('')}</div>`);
  }
  return `
    <h2 class="split-title">${monthName(month)} ${year}</h2>
    <div class="cal">
      ${['S','M','T','W','T','F','S'].map(w => `<div class="cal-w">${w}</div>`).join('')}
      ${cells.join('')}
    </div>
    ${carried.length ? `<div class="section-label">Carried over · unpaid</div>${carried.map(chip).join('')}` : ''}
    <div class="muted small" style="margin-top:10px;">Tap a bill to edit it.</div>
  `;
}

// Where a bill's payment is dated: today in the current month; otherwise the
// bill's own due date (one-time) or month + due day.
function billPayDate(bill, year, month){
  const ym = ymOf(year, month);
  const now = new Date();
  if (year === now.getFullYear() && month === now.getMonth() + 1) return today();
  if (bill.recurrence === 'once' && bill.dueDate && bill.dueDate.slice(0, 7) === ym) return bill.dueDate;
  return `${ym}-${String(Math.min(getBillDueDay(bill), 28)).padStart(2,'0')}`;
}

// NEW(v3.2): the one place a bill payment is logged — the Pay button and the
// Pay run both go through it. Caller handles toasts and re-rendering.
export async function logBillPayment(bill, year, month, amount, dateIso){
  const ym = ymOf(year, month);
  const isAuto = bill.recurrence === 'auto-cc';
  const txn = {
    id: uid(),
    date: dateIso || billPayDate(bill, year, month),
    type: bill.type || 'Expense',
    account: isAuto ? bill.linkedAccount : bill.account,
    category: bill.category || bill.name,
    description: bill.name + ' (auto)',
    amount: round2(amount),
    fromAccount: bill.fromAccount || null
  };
  await dbPut('transactions', txn);
  state.transactions.unshift(txn);
  state.transactions.sort((a,b) => (b.date||'').localeCompare(a.date||''));

  bill.paidMonths = bill.paidMonths || {};
  bill.paidMonths[ym] = txn.id;
  if (isVariableBill(bill)) setActual(bill, ym, txn.amount);
  await dbPut('bills', bill);
  return txn;
}

// FIX(v3.0): double-tap safe, per bill — two quick taps used to log two
// payment transactions (and orphan the first).
// NEW(v3.2): `amount` overrides what's owed (the amount sheet passes it); a
// variable bill whose amount isn't in yet asks for it first.
export const payBill = busyGuard(async (billId, amount) => {
  const bill = state.bills.find(b => b.id === billId);
  if (!bill) return;
  const { year, month } = state.selected;
  const ym = ymOf(year, month);
  if (isBillPaid(bill, ym)) { toast('Already paid'); return; }
  if (amount == null && isBillEstimated(bill, ym)){ openBillAmountSheet(bill.id, ym, { pay: true }); return; }

  // Auto-cc: the linked card's balance FOR THE VIEWED MONTH (FIX v2.10.2).
  const isAuto = bill.recurrence === 'auto-cc';
  const payAmount = round2(amount != null ? amount : getBillAmount(bill, year, month));
  if (isAuto && payAmount <= 0){
    toast('Nothing to pay — balance is $0');
    return;
  }
  await logBillPayment(bill, year, month, payAmount);

  haptic(15); /* NEW(v2.2) */
  toast('Marked paid · transaction logged');
  renderCurrent();
}, (billId) => billId);

/* NEW(v3.2): "what is it this month?" — the amount sheet for a variable bill.
   Save the amount (Real available and the forecast use it from then on), or
   save and pay in one go. */
export function openBillAmountSheet(billId, ym, { pay = false } = {}){
  const bill = state.bills.find(b => b.id === billId);
  if (!bill) return;
  if (bill.recurrence === 'auto-cc') return openCardPaymentSheet(bill, ym, { pay });
  const [y, m] = ym.split('-').map(Number);
  const cur = billMonthAmount(bill, ym);
  const hist = billHistory(bill).filter(([k]) => k < ym).slice(-6).reverse();
  $('#sheetBody').innerHTML = `
    <h2>${esc(bill.name)} · ${monthName(m, true)} ${y}</h2>
    <div class="muted small" style="margin-bottom:12px;line-height:1.5;">
      ${isBillEstimated(bill, ym) ? 'Ledger is estimating this month from your recent bills.' : 'This month\'s amount is entered.'}
      Enter what you were billed once you know it.
    </div>
    <div class="field"><label for="ba-amt">Amount this month</label>
      <input class="input" id="ba-amt" type="text" inputmode="decimal" value="${cur ? cur.toFixed(2) : ''}" /></div>
    ${hist.length ? `<div class="muted small" style="margin:-4px 0 14px;">Recent: ${hist.map(([k, a]) => `${esc(monthName(Number(k.slice(5)), true))} ${fmt(a)}`).join(' · ')}</div>` : ''}
    ${pay ? '<button class="btn" id="ba-pay">Pay it</button><button class="btn ghost" id="ba-save" style="margin-top:10px;">Save amount only</button>'
          : '<button class="btn" id="ba-save">Save amount</button><button class="btn secondary" id="ba-pay" style="margin-top:10px;">Save &amp; pay</button>'}
  `;
  openSheet();
  const read = () => {
    const v = parseAmount($('#ba-amt').value);
    if (isNaN(v) || v <= 0){ toast('Enter a valid amount'); return null; }
    return round2(v);
  };
  $('#ba-save').addEventListener('click', busyGuard(async () => {
    const v = read(); if (v == null) return;
    setActual(bill, ym, v);
    await dbPut('bills', bill);
    closeSheet(); renderCurrent();
    toast(`${bill.name}: ${fmt(v)} for ${monthName(m, true)}`);
  }));
  $('#ba-pay').addEventListener('click', async () => {
    const v = read(); if (v == null) return;
    closeSheet();
    await payBill(bill.id, v);
  });
}

/* NEW(v3.2): "I'll pay X" for a card bill — shows the statement, the balance,
   and the difference your amount leaves, live as you type. */
function openCardPaymentSheet(bill, ym, { pay = false } = {}){
  const card = bill.linkedAccount;
  const acct = state.accounts.find(a => a.name === card);
  const [y, m] = ym.split('-').map(Number);
  const s = statementInfo(card);
  const owed0 = s ? s.remaining : Math.max(0, balanceLatest(card));
  const plan = plannedPayment(bill, ym);
  const start = plan != null ? plan : owed0;
  const dd = (iso) => `${monthName(Number(iso.slice(5, 7)), true)} ${Number(iso.slice(8))}`;
  $('#sheetBody').innerHTML = `
    <h2>${esc(card)} · ${monthName(m, true)} ${y}</h2>
    ${s ? `
      <div class="field"><label for="cp-stmt-amt">Statement balance — closed ${esc(dd(s.closeIso))}${s.needsEntry ? ' (not entered yet — this is an estimate)' : ''}</label>
        <input class="input" id="cp-stmt-amt" type="text" inputmode="decimal" value="${s.statement.toFixed(2)}" /></div>
      <div class="real-breakdown" style="margin:4px 0 8px;">
        <div class="rb-row"><span>− Paid since it closed</span><span class="mono">${fmt(s.paidSince)}</span></div>
        <div class="rb-row total"><span>= Still due ${esc(dd(s.dueIso))}</span><span class="mono" id="cp-due">${fmt(s.remaining)}</span></div>
        <div class="rb-row"><span>On the next statement (owed beyond it)</span><span class="mono" id="cp-next">${fmt(s.charged)}</span></div>
        <div class="rb-row"><span>Current balance</span><span class="mono">${fmt(balanceLatest(card))}</span></div>
      </div>` : `
      <div class="real-breakdown" style="margin:4px 0 8px;"><div class="rb-row"><span>Current balance</span><span class="mono">${fmt(balanceLatest(card))}</span></div></div>`}
    <div class="field" style="margin-top:12px;"><label for="cp-amt">What I'll pay</label>
      <input class="input" id="cp-amt" type="text" inputmode="decimal" value="${start.toFixed(2)}" /></div>
    <div id="cp-diff" class="muted small" style="margin:-4px 0 12px;line-height:1.5;"></div>
    ${pay ? '<button class="btn" id="cp-pay">Pay it</button><button class="btn ghost" id="cp-save" style="margin-top:10px;">Save amount only</button>'
          : '<button class="btn" id="cp-save">Save</button><button class="btn secondary" id="cp-pay" style="margin-top:10px;">Save &amp; pay</button>'}
    ${plan != null ? '<button type="button" class="btn ghost" id="cp-clear" style="margin-top:10px;">Use the full statement</button>' : ''}
  `;
  openSheet();
  // The statement figure you type drives "still due", "next statement" and the difference, live.
  const stmtVal = () => {
    if (!s) return null;
    const v = parseAmount($('#cp-stmt-amt').value);
    return isNaN(v) || v < 0 ? null : round2(v);
  };
  const dueNow = () => { const sv = stmtVal(); return sv == null ? owed0 : Math.max(0, round2(sv - s.paidSince)); };
  const diff = () => {
    const v = parseAmount($('#cp-amt').value);
    const el = $('#cp-diff');
    const owed = dueNow();
    if (s){
      $('#cp-due').textContent = fmt(owed);
      $('#cp-next').textContent = fmt(Math.max(0, round2(s.current - owed)));
    }
    if (isNaN(v) || v < 0){ el.textContent = ''; return; }
    const left = round2(owed - v);
    el.innerHTML = !s ? `Balance after paying ${fmt(v)}: ${fmt(Math.max(0, balanceLatest(card) - v))}.`
      : left > 0.004 ? `${fmt(v)} of ${fmt(owed)} due → <b>${fmt(left)} left</b> on this statement (it carries over, and can accrue interest).`
      : left < -0.004 ? `${fmt(-left)} more than the statement — it goes toward what you've charged since.`
      : 'Pays the statement exactly.';
  };
  $('#cp-amt').addEventListener('input', diff);
  $('#cp-stmt-amt')?.addEventListener('input', diff);
  diff();
  const read = () => {
    const v = parseAmount($('#cp-amt').value);
    if (isNaN(v) || v <= 0){ toast('Enter an amount to pay'); return null; }
    return round2(v);
  };
  // Keep the statement figure if it changed (or was only an estimate).
  const saveStatement = async () => {
    const sv = stmtVal();
    if (s && sv != null && acct && (s.needsEntry || !s.entered || !near2(sv, s.statement))){
      acct.stmt = { closeIso: s.closeIso, amount: sv };
      await dbPut('accounts', acct);
    }
  };
  $('#cp-save').addEventListener('click', busyGuard(async () => {
    const v = read(); if (v == null) return;
    await saveStatement();
    await setPlanned(bill, ym, v);
    closeSheet(); renderCurrent();
    toast(`Paying ${fmt(v)} on ${card} for ${monthName(m, true)}`);
  }));
  $('#cp-pay').addEventListener('click', async () => {
    const v = read(); if (v == null) return;
    await saveStatement();
    await setPlanned(bill, ym, v);
    closeSheet();
    await payBill(bill.id, v);
  });
  $('#cp-clear')?.addEventListener('click', busyGuard(async () => {
    await setPlanned(bill, ym, null);
    closeSheet(); renderCurrent();
    toast('Using the full statement');
  }));
}
const near2 = (a, b) => Math.abs(a - b) < 0.005;

/* NEW(v3.2): link any transaction to a bill by hand — for a payment whose
   amount (or source account) doesn't match what the bill says. */
export function openLinkPaymentSheet(billId, ym){
  const bill = state.bills.find(b => b.id === billId);
  if (!bill) return;
  const linked = new Set();
  for (const bb of state.bills) for (const id of Object.values(bb.paidMonths || {})) linked.add(id);
  const auto = bill.recurrence === 'auto-cc';
  const type = auto ? 'CC Payment' : (bill.type || 'Expense');
  const acct = auto ? bill.linkedAccount : bill.account;
  const [y, m] = ym.split('-').map(Number);
  const prev = ymOf(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1);
  const want = billMonthAmount(bill, ym);
  const cands = state.transactions
    .filter(t => t.type === type && t.account === acct && !linked.has(t.id) && t.date && (t.date.slice(0, 7) === ym || t.date.slice(0, 7) === prev))
    .sort((a, b) => Math.abs(a.amount - want) - Math.abs(b.amount - want) || b.date.localeCompare(a.date))
    .slice(0, 40);
  $('#sheetBody').innerHTML = `
    <h2>Link a payment · ${esc(bill.name)}</h2>
    <div class="muted small" style="margin-bottom:12px;line-height:1.5;">Pick the transaction that paid ${esc(bill.name)} for ${monthName(m, true)} ${y}. Closest amounts first.</div>
    ${cands.length === 0
      ? `<div class="muted small" style="padding:14px 0;">No unlinked ${esc(type)} on ${esc(acct)} in ${esc(monthName(m, true))} or ${esc(monthName(Number(prev.slice(5)), true))}.</div>`
      : cands.map(t => `
        <button type="button" class="rec-row lp-row" data-id="${esc(t.id)}" style="width:100%;font:inherit;color:inherit;cursor:pointer;text-align:left;">
          <div style="min-width:0;flex:1;">
            <div style="font-size:13.5px;font-weight:500;">${fmt(t.amount)}${t.description ? ' · ' + esc(t.description) : ''}</div>
            <div class="muted small">${esc(t.date)}${t.fromAccount ? ' · from ' + esc(t.fromAccount) : ''}</div>
          </div>
          <span class="btn secondary" style="width:auto;padding:6px 12px;font-size:12px;">Link</span>
        </button>`).join('')}
    <button class="btn ghost" id="lp-cancel" style="margin-top:12px;">Cancel</button>
  `;
  openSheet();
  $$('.lp-row').forEach(r => r.addEventListener('click', busyGuard(async () => {
    closeSheet();
    await markBillPaidWith(bill, ym, r.dataset.id);
  }, () => 'lp')));
  $('#lp-cancel').addEventListener('click', closeSheet);
}

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
    graceDays: existing?.graceDays != null ? existing.graceDays : 21,
    ccAmount: existing?.ccAmount === 'statement' ? 'statement' : 'current',   // NEW(v3.1)
    variable: existing?.variable === true,                                    // NEW(v3.2)
    estMode: ['avg3', 'last', 'fixed'].includes(existing?.estMode) ? existing.estMode : 'avg3',
    amounts: { ...(existing?.amounts || {}) },
    paidMonths: { ...(existing?.paidMonths || {}) }
  };
  const selYm = ymOf(state.selected.year, state.selected.month);

  // NEW(v3.2): past charges that look like this bill (same account, and the
  // bill's category — or its name in the description), one per month, newest.
  const importCandidates = () => {
    const linkedIds = new Set();
    for (const bb of state.bills) for (const id of Object.values(bb.paidMonths || {})) linkedIds.add(id);
    const cat = f.category.trim(), name = squash(f.name);
    const byMonth = {};
    for (const t of state.transactions){
      if (t.type !== 'Expense' || t.account !== f.account || !t.date || linkedIds.has(t.id)) continue;
      const hit = (cat && t.category === cat) || (name.length >= 3 && squash(t.description).includes(name));
      if (!hit) continue;
      const ym = t.date.slice(0, 7);
      if (!byMonth[ym] || t.date > byMonth[ym].date) byMonth[ym] = t;
    }
    return Object.entries(byMonth).sort().slice(-12);     // [[ym, txn], …]
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

    const varyingHTML = () => {
      const tmp = { paidMonths: f.paidMonths, amounts: f.amounts };
      const hist = billHistory(tmp).slice(-6).reverse();
      return `
        <div class="field">
          <label>Does the amount change?</label>
          <div class="seg" id="bf-var" role="tablist">
            <button type="button" class="seg-btn ${!f.variable ? 'active' : ''}" data-v="fixed">Same each month</button>
            <button type="button" class="seg-btn ${f.variable ? 'active' : ''}" data-v="varies">Varies</button>
          </div>
        </div>
        ${f.variable ? `
          <div class="field">
            <label>Estimate from</label>
            <div class="seg seg-3" id="bf-est" role="tablist">
              <button type="button" class="seg-btn ${f.estMode === 'avg3' ? 'active' : ''}" data-v="avg3">3-mo average</button>
              <button type="button" class="seg-btn ${f.estMode === 'last' ? 'active' : ''}" data-v="last">Last month</button>
              <button type="button" class="seg-btn ${f.estMode === 'fixed' ? 'active' : ''}" data-v="fixed">Fixed</button>
            </div>
          </div>
          <div class="muted small" style="margin:-4px 0 12px;line-height:1.5;">
            Until you enter the real amount, Ledger counts the estimate (the number above is the fallback when there's no history). Enter the amount when the bill arrives — or just log the payment and link it.
            ${hist.length ? `<br>History: ${hist.map(([k, a]) => `${esc(monthName(Number(k.slice(5)), true))} ${fmt(a)}`).join(' · ')}` : ''}
          </div>
          <button type="button" class="btn ghost" id="bf-import" style="margin-bottom:14px;">Import past charges from my transactions</button>
        ` : ''}`;
    };

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
          <div class="field">
            <label>Bill amount</label>
            <div class="seg" id="bf-ccamt" role="tablist">
              <button type="button" class="seg-btn ${f.ccAmount === 'current' ? 'active' : ''}" data-v="current">Current balance</button>
              <button type="button" class="seg-btn ${f.ccAmount === 'statement' ? 'active' : ''}" data-v="statement">Statement balance</button>
            </div>
          </div>
          <div class="muted small" style="margin:-4px 0 14px;line-height:1.5;">
            ${f.ccAmount === 'statement'
              ? 'Amount = what\'s still due from the last statement (closing day above) — paying that by the due date avoids interest.'
              : 'Amount auto-tracks the live running balance of the linked card.'}
            Due day is computed from close + grace (e.g. close 15, grace 21 → due day 6 of next month).
            When you mark it paid, a CC Payment is logged for that amount.
          </div>
        `}
      ` : `
        <div class="row-2">
          <div class="field"><label>${f.variable && f.recurrence === 'monthly' ? 'Estimate' : 'Amount'}</label><input class="input" id="bf-amt" type="text" inputmode="decimal" placeholder="0.00" value="${esc(f.amount)}" /></div>
          ${isOnce
            ? `<div class="field"><label>Due Date</label><input class="input" id="bf-date" type="date" value="${esc(f.dueDate)}" /></div>`
            : `<div class="field"><label>Due Day (1–31)</label><input class="input" id="bf-day" type="number" min="1" max="31" inputmode="numeric" value="${esc(f.dueDay)}" /></div>`}
        </div>
        ${f.recurrence === 'monthly' ? varyingHTML() : ''}
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
      ${existing && !isBillPaid(existing, selYm)
        ? `<button type="button" class="btn ghost" id="bf-link" style="margin-top:10px;">Link a payment to ${esc(monthName(state.selected.month, true))}…</button>` : ''}
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
      $$('#bf-ccamt .seg-btn').forEach(b => b.addEventListener('click', () => { f.ccAmount = b.dataset.v; render(); }));   // NEW(v3.1)
    } else if (!isAuto){
      $('#bf-amt').addEventListener('input', e => f.amount = e.target.value);
      if (isOnce) $('#bf-date').addEventListener('input', e => f.dueDate = e.target.value);
      else $('#bf-day').addEventListener('input', e => f.dueDay = clamp(parseInt(e.target.value)||1, 1, 31));
      $('#bf-cat').addEventListener('input', e => f.category = e.target.value);
      if (f.recurrence === 'monthly'){
        $$('#bf-var .seg-btn').forEach(b => b.addEventListener('click', () => { f.variable = b.dataset.v === 'varies'; render(); }));
        $$('#bf-est .seg-btn').forEach(b => b.addEventListener('click', () => { f.estMode = b.dataset.v; render(); }));
        $('#bf-import')?.addEventListener('click', () => {
          const found = importCandidates();
          if (!found.length){ toast('No matching charges found — set the category or name first'); return; }
          // A charge that already happened IS that month's payment — link it (so the
          // month doesn't read as unpaid and count against Real available a second time).
          let n = 0;
          for (const [ym, t] of found){
            if (f.paidMonths[ym] || f.amounts[ym] != null) continue;
            if (ym <= currentYm()) f.paidMonths[ym] = t.id; else f.amounts[ym] = round2(t.amount);
            n++;
          }
          toast(n ? `Imported ${n} month${n === 1 ? '' : 's'} of history` : 'Already have those months');
          render();
        });
      }

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
    $('#bf-link')?.addEventListener('click', () => openLinkPaymentSheet(existing.id, selYm));   // NEW(v3.2)
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
      paidMonths: f.paidMonths,
      notes: existing?.notes || ''
    };
    // NEW(v3.2): a variable bill keeps its actuals; everything else drops the flag.
    if (f.recurrence === 'monthly' && f.variable){
      obj.variable = true;
      obj.estMode = f.estMode;
      obj.amounts = { ...f.amounts };
    } else if (existing?.amounts && Object.keys(existing.amounts).length){
      obj.amounts = { ...existing.amounts };      // history survives a switch back to fixed
    }
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
        graceDays,
        ccAmount: f.ccAmount            // NEW(v3.1): 'current' | 'statement'
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

    if (obj.variable && obj.estMode !== 'fixed'){            // NEW(v3.2): the stored number follows the history
      const e = billEstimate(obj, '9999-99');
      if (e) obj.amount = e;
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
