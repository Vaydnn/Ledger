/* ============================================================
   forecast.js — NEW in v1.1.0.

   90-day cashflow forecast starting from today's cash position.
   Event sources:
     - Recurring Income (detected via detectRecurring('Income'))
     - Recurring Expenses (subscription detector, expense side)
     - Configured bills (state.bills): monthly bills project via dueDay,
       one-time bills (recurrence:'once', added v1.1.2) land once on
       their dueDate, auto-cc bills (recurrence:'auto-cc', added v1.1.3)
       project a single event at the next statement-due date with the
       current live balance.
   Each event is projected forward on its own cadence through the window.
   The line chart shows the projected cash balance day-by-day; below it
   is a chronological list of upcoming events.

   FIX(v3.0): two double counts removed.
   - Recurring expenses charged to a CREDIT CARD no longer come straight out
     of cash on their charge date — that money reaches cash through the
     card's payment (an auto-CC or CC Payment bill), which was subtracted too.
   - A detected recurring charge that a bill already covers (same category,
     or the bill's name in the merchant) is skipped. The old de-dup required
     the same date AND the same cents, which almost never happened, so e.g.
     rent was subtracted twice every month.
   Unpaid one-time bills already past due land as today's event.

   v3.2:
   - Paychecks are found even after a job change (subscriptions.js looks at
     the recent regime) and a twice-a-month pay follows its days of the month.
     A paycheck already logged (entered ahead of payday) isn't projected again.
   - Cards you pay in full (Real available's ⚙) are paid the way you pay them:
     one payment on pay-run day for the balance you carry plus the charges
     that land before it. Their individual charges stay in the list, tagged,
     but aren't cash movements.
   - A recurring charge a bill already covers (same card, same price, same
     time of month) is skipped — an ISP charge was counted next to the Internet bill.
   - An unpaid monthly bill past its due day lands today (like Real available).
   - Variable bills use their estimate / entered amount per month.
   ============================================================ */

import { $, fmt, fmtShort, monthName, parseLocalDate, toLocalISO, addDays, sumMoney, esc, squash, round2 } from './util.js';
import { state } from './db.js';
import { balanceLatest, acctTypeMap } from './effects.js';
import { openSheet } from './sheet.js';
import { detectRecurring } from './subscriptions.js';
import { cardPayMode, cardCycle, statementInfo, lastClose } from './statement.js';
import { getBillAmount, isBillPaid, billMonthAmount, isVariableBill, isBillEstimated, seriesCoveredByBill, plannedCardPayment } from './bills.js';

// Project the next due date for an auto-cc bill, given today.
// We assume close+grace ≈ a real-world due date once a month. Find
// the next future occurrence of (close + grace days) starting from
// today. Returns null if it'd fall after `endD`.
function projectAutoCcDueDate(closeDay, graceDays, todayD, endD){
  // Walk month-by-month from current month: closeDate = (year, month-1, closeDay)
  // dueDate = closeDate + graceDays. If dueDate is in the future and ≤ endD, that's our hit.
  let y = todayD.getFullYear();
  let m = todayD.getMonth(); // 0-indexed
  for (let i = 0; i < 4; i++){  // look up to 4 months ahead, plenty for a 90-day window
    const lastDayOfMonth = new Date(y, m + 1, 0).getDate();
    const close = new Date(y, m, Math.min(closeDay, lastDayOfMonth));
    const due = new Date(close); due.setDate(due.getDate() + graceDays);
    if (due > todayD && due <= endD) return due;
    m += 1; if (m > 11){ m = 0; y += 1; }
  }
  return null;
}

// Total cash right now = sum of Checking + Savings balances
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));

export function currentCash(){
  return sumMoney(
    state.accounts.filter(a => a.active && (a.type === 'Checking' || a.type === 'Savings')),
    a => balanceLatest(a.name));
}

// Project a recurring event's future occurrences within [from, to]
// FIX(v1.2): millisecond-based day stepping duplicated/skipped a calendar day
// across the fall-back DST transition (Texas = US Central). addDays() steps by
// calendar day via the Date constructor, which is DST-safe.
function projectOccurrences(lastDate, canonDays, fromD, toD){
  const out = [];
  let next = addDays(lastDate, canonDays);
  while (next <= toD){
    if (next >= fromD) out.push(new Date(next));
    next = addDays(next, canonDays);
  }
  return out;
}

// Project bill due-dates forward. Each bill has a dueDay (1-31).
// We generate one occurrence per month in the window, clamping to the
// month's last day if dueDay exceeds it (e.g., dueDay=31 in February).
function projectBillDates(dueDay, fromD, toD){
  const out = [];
  let y = fromD.getFullYear();
  let m = fromD.getMonth() + 1;
  while (true){
    const lastDayOfMonth = new Date(y, m, 0).getDate();
    const day = Math.min(dueDay, lastDayOfMonth);
    const d = new Date(y, m - 1, day);
    if (d > toD) break;
    if (d >= fromD) out.push(d);
    m += 1; if (m > 12){ m = 1; y += 1; }
  }
  return out;
}

// NEW(v3.2): the day you pay your cards (and bills) in one go — the 1st by
// default. flags.bulkPay = { day }.
export function bulkPayDay(){
  const d = Number(state.flags.bulkPay && state.flags.bulkPay.day);
  return d >= 1 && d <= 28 ? Math.floor(d) : 1;
}
// Pay-run dates after `fromD` (exclusive) through `toD`, one per month.
export function runDatesBetween(fromD, toD){
  const day = bulkPayDay();
  const out = [];
  let y = fromD.getFullYear(), m = fromD.getMonth();
  for (let i = 0; i < 40; i++){
    const d = new Date(y, m, day);
    if (d > toD) break;
    if (d > fromD) out.push(d);
    m += 1; if (m > 11){ m = 0; y += 1; }
  }
  return out;
}
// The cards you pay in full (the ones checked in Real available's ⚙).
export function payInFullCards(){
  return (state.flags.realAvailCards || []).filter(n => state.accounts.find(a => a.name === n && a.active));
}

// Dates of a twice-a-month pay inside [fromD, toD].
function projectSlots(slots, fromD, toD){
  const out = [];
  let y = fromD.getFullYear(), m = fromD.getMonth();
  for (let i = 0; i < 40; i++){
    const last = new Date(y, m + 1, 0).getDate();
    for (const day of slots){
      const d = new Date(y, m, Math.min(day, last));
      if (d >= fromD && d <= toD) out.push(d);
    }
    m += 1; if (m > 11){ m = 0; y += 1; }
    if (new Date(y, m, 1) > toD) break;
  }
  return out.sort((a, b) => a - b);
}

// Build the ordered event list for the forecast window
// v3.1: exported for Home's Safe to spend (payday.js). Each event carries
// the account it hits (acct) so card double counts can be filtered.
// v3.2: cards you pay in full (Real available's ⚙) are modeled the way you
// pay them — their charges are tagged `cardCharge` (they reach cash through
// the payment, not on the charge date) and each pay-run day gets one 'card'
// event: the balance you carry now plus the charges that land before it.
export function buildEvents(days){
  const todayD = new Date();
  todayD.setHours(0, 0, 0, 0);
  const endD = addDays(todayD, days); // FIX(v1.2): DST-safe
  const ymNow = toLocalISO(todayD).slice(0, 7);

  const events = [];

  const aType = acctTypeMap();
  const isCashAcct = (n) => aType[n] === 'Checking' || aType[n] === 'Savings';
  const active = state.bills.filter(b => b.active !== false);
  const full = payInFullCards();
  // Cards/loans whose payments are modeled by a bill: their charges reach
  // cash through that payment, never directly.
  const paidViaBill = new Set([
    ...active.filter(b => b.recurrence === 'auto-cc').map(b => b.linkedAccount),
    ...active.filter(b => b.recurrence !== 'auto-cc' && (b.type === 'CC Payment' || b.type === 'Loan Payment')).map(b => b.account)
  ].filter(n => !full.includes(n)));     // …unless the card is paid in full on pay-run day

  // Logged paychecks (any date from a week ago on) per income category — a
  // paycheck you entered ahead of payday has already happened.
  const loggedIncome = {};
  const weekAgo = toLocalISO(addDays(todayD, -7));
  for (const t of state.transactions){
    if (t.type !== 'Income' || !t.date || t.date < weekAgo) continue;
    (loggedIncome[t.category] = loggedIncome[t.category] || []).push(t.date);
  }
  const alreadyLogged = (cat, d) => (loggedIncome[cat] || []).some(l => Math.abs(Math.round((parseLocalDate(l) - d) / 86400000)) <= 3);

  // Recurring Income (paychecks, Prolific, etc.)
  const incRecurring = detectRecurring('Income');
  for (const r of incRecurring){
    const occs = r.slots ? projectSlots(r.slots, todayD, endD) : projectOccurrences(r.last, r.canonDays, todayD, endD);
    for (const d of occs){
      if (d <= r.last || alreadyLogged(r.category, d)) continue;     // NEW(v3.2): don't count a paycheck twice
      events.push({
        date:d, kind:'income', label:r.label, amount:r.medAmt,
        detail:`${r.slots ? 'Twice a month' : r.cadence} · ${r.category}`
      });
    }
  }

  // Recurring Expenses (subscriptions)
  for (const r of detectRecurring('Expense')){
    if (seriesCoveredByBill(r)) continue;
    if (paidViaBill.has(r.primaryAccount)) continue;
    const onCard = full.includes(r.primaryAccount);
    const occs = projectOccurrences(r.last, r.canonDays, todayD, endD);
    for (const d of occs){
      events.push({
        date:d, kind:'subscription', label:r.label, amount:-r.medAmt, acct:r.primaryAccount,
        cardCharge: onCard ? r.primaryAccount : undefined,
        detail:`${r.cadence} · ${r.category}${r.primaryAccount && !isCashAcct(r.primaryAccount) ? ' · ' + r.primaryAccount : ''}`
      });
    }
  }

  // Configured Bills — recurring monthly project forward via dueDay,
  // one-time bills land on their dueDate (single occurrence), auto-cc
  // bills get a single occurrence at the next statement-due date with
  // the current live balance (we can't predict future charges).
  for (const b of active){
    if (b.recurrence === 'auto-cc'){
      if (full.includes(b.linkedAccount)) continue;          // NEW(v3.2): the pay-run event covers it
      const liveAmt = getBillAmount(b);
      if (liveAmt <= 0) continue;
      const due = projectAutoCcDueDate(b.closeDay || 1, b.graceDays != null ? b.graceDays : 21, todayD, endD);
      if (!due) continue;
      const ymBill = toLocalISO(due).slice(0, 7);
      if (isBillPaid(b, ymBill)) continue;
      events.push({
        date:due, kind:'bill', label:b.name, amount:-liveAmt, acct:b.linkedAccount, billId:b.id,
        detail:`Auto · ${b.linkedAccount}`
      });
      continue;
    }
    if (!b.amount && !isVariableBill(b)) continue;
    const type = b.type || 'Expense';
    // An expense bill charged to a card whose payment is itself a bill
    // reaches cash through that payment.
    if (type === 'Expense' && paidViaBill.has(b.account)) continue;
    // …and a card you pay in full: the payment covers it, not a bill-sized hole in cash.
    if ((type === 'CC Payment') && full.includes(b.account)) continue;
    const cardCharge = type === 'Expense' && full.includes(b.account) ? b.account : undefined;
    let dates = [];
    let overdue = false;
    if (b.recurrence === 'once'){
      if (!b.dueDate || isBillPaid(b, b.dueDate.slice(0, 7))) continue;
      const d = parseLocalDate(b.dueDate);
      if (d < todayD) dates = [new Date(todayD)];        // NEW(v3.0): overdue → due now
      else if (d <= endD) dates = [d];
    } else {
      if (!b.dueDay) continue;
      dates = projectBillDates(b.dueDay, todayD, endD);
      // NEW(v3.2): this month's bill is past due and unpaid → it's due now
      // (Real available already counts it; the forecast used to skip it).
      const dueThisMonth = new Date(todayD.getFullYear(), todayD.getMonth(), Math.min(b.dueDay, new Date(todayD.getFullYear(), todayD.getMonth() + 1, 0).getDate()));
      if (dueThisMonth < todayD && !isBillPaid(b, ymNow)){ dates.unshift(new Date(todayD)); overdue = true; }
    }
    dates.forEach((d, i) => {
      // Skip bills already marked paid for the month they fall in
      const ymd = toLocalISO(d).slice(0, 7);
      if (b.recurrence !== 'once' && isBillPaid(b, ymd)) return;
      const amt = b.recurrence === 'once' ? (b.amount || 0) : billMonthAmount(b, ymd);
      if (!amt) return;
      const late = b.recurrence === 'once' ? parseLocalDate(b.dueDate) < todayD : (overdue && i === 0);
      const est = b.recurrence !== 'once' && isBillEstimated(b, ymd);
      events.push({
        date:d, kind:'bill', label:b.name, amount:-amt, acct:b.account, billId:b.id, cardCharge, est,
        detail: (b.recurrence === 'once' ? (late ? 'One-time bill · overdue' : 'One-time bill') : (late ? `Bill · overdue (due ${b.dueDay})` : `Bill · due ${b.dueDay}`))
                + (est ? ' · estimate' : '') + (cardCharge ? ` · on ${cardCharge}` : '')
      });
    });
  }

  // NEW(v3.2): cards you pay on pay-run day — one payment per run. A card on
  // "statement" mode pays the statement that has closed (or will close before
  // that run); whatever is charged after the closing day rides on the next
  // statement. A card on "full" pays everything owed by then. If you said
  // "I'll pay X" for that month (the card's Auto (CC) bill), X is the payment
  // and the rest stays on the card.
  const runs = full.length ? runDatesBetween(todayD, endD) : [];
  const dayLbl = (d) => `${monthName(d.getMonth() + 1, true)} ${d.getDate()}`;
  for (const card of full){
    const ch = events.filter(e => e.cardCharge === card).sort((x, y) => x.date - y.date);
    let idx = 0;
    const take = (limit, inclusive) => {
      let sum = 0;
      while (idx < ch.length && (inclusive ? ch[idx].date <= limit : ch[idx].date < limit)){ sum -= ch[idx].amount; idx++; }
      return sum;
    };
    const mode = cardPayMode(card);
    const cyc = mode === 'statement' ? cardCycle(card) : null;
    const info = cyc ? statementInfo(card, toLocalISO(todayD)) : null;
    let bal = Math.max(0, balanceLatest(card));          // owed now, grows with the charges ahead
    runs.forEach((run, i) => {
      let owed, carry = 0, charges = 0, extra = 0, closed = false, detail;
      if (!cyc){
        carry = bal; charges = take(run, false); owed = carry + charges;
        detail = i === 0 && carry > 0.004
          ? `Balance ${fmt(carry)}${charges > 0.004 ? ` + ${fmt(charges)} expected charges` : ''}`
          : 'Charges since the last pay run';
      } else {
        const c = lastClose(cyc.closeDay, toLocalISO(run));
        if (c <= todayD){                                  // already closed → what's still due
          owed = i === 0 && info ? info.remaining : 0; carry = owed;
          extra = take(run, false); closed = true;
          detail = `Statement closed ${dayLbl(c)}${info && info.entered ? ' (entered)' : info && info.needsEntry ? ' (estimate)' : ''}`;
        } else {                                           // closes before the run
          carry = bal; charges = take(c, true); owed = carry + charges;
          extra = take(run, false);
          detail = `Statement closes ${dayLbl(c)}: ${fmt(carry)} carried + ${fmt(charges)} expected charges`;
        }
      }
      owed = round2(owed);
      const plan = plannedCardPayment(card, toLocalISO(run).slice(0, 7));   // "I'll pay X"
      const pay = round2(plan != null ? plan : owed);
      // What stays on the card after this payment.
      bal = closed ? Math.max(0, bal + extra - pay) : Math.max(0, owed - pay) + extra;
      if (!cyc) bal = Math.max(0, owed - pay);
      const left = round2(Math.max(0, owed - pay));
      if (plan != null) detail = `Paying ${fmt(plan)} of ${fmt(owed)} due${left > 0.004 ? ` · ${fmt(left)} left on the statement` : ''} · ${detail}`;
      else if (closed && bal > 0.004) detail += ` · ${fmt(bal)} left for the next one`;
      if (pay > 0.004){
        events.push({
          date: run, kind: 'card', label: `${card} · ${cyc ? 'statement balance' : 'pay in full'}`, amount: -pay, acct: card, cardPay: true,
          card, mode: cyc ? 'statement' : 'full', balance: round2(carry), charges: round2(charges), owed, planned: plan != null, detail
        });
      }
    });
  }

  events.sort((a, b) => a.date - b.date);
  return events;
}

// Produce a daily cash-balance series for the chart
export function buildSeries(events, startCash, days){
  const todayD = new Date();
  todayD.setHours(0, 0, 0, 0);

  // Aggregate events by day (ISO) — a charge on a pay-in-full card isn't a
  // cash movement; the card's payment event is.
  const dayDeltas = {};
  for (const e of events){
    if (e.cardCharge) continue;
    const iso = toLocalISO(e.date);
    dayDeltas[iso] = round2((dayDeltas[iso] || 0) + e.amount);
  }

  const series = [];
  let balance = startCash;
  for (let i = 0; i <= days; i++){
    const d = addDays(todayD, i); // FIX(v1.2): ms-stepping duplicated a day across fall-back DST
    const iso = toLocalISO(d);
    if (dayDeltas[iso]) balance = round2(balance + dayDeltas[iso]);
    series.push({ date:d, iso, balance });
  }
  return series;
}

// Build the SVG line chart — mirrors the networth chart style
function renderChartSVG(series){
  const w = 700, h = 180, pad = 14;
  const bals = series.map(s => s.balance);
  const min = Math.min(...bals);
  const max = Math.max(...bals);
  const span = Math.max(1, max - min);
  const n = series.length;
  const sx = (i) => pad + (i / Math.max(1, n - 1)) * (w - pad*2);
  const sy = (v) => pad + (1 - (v - min) / span) * (h - pad*2);
  const path = series.map((s, i) => `${i===0?'M':'L'}${sx(i).toFixed(1)},${sy(s.balance).toFixed(1)}`).join('');
  const area = `${path} L${sx(n-1)},${h-pad} L${sx(0)},${h-pad} Z`;

  // Zero-line, if 0 is within span
  const zeroLine = (min < 0 && max > 0)
    ? `<line class="zero" x1="${pad}" y1="${sy(0).toFixed(1)}" x2="${w-pad}" y2="${sy(0).toFixed(1)}" />`
    : '';

  return `
    <svg class="fc-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="fcgrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(232,153,84,.30)"/>
          <stop offset="100%" stop-color="rgba(232,153,84,0)"/>
        </linearGradient>
      </defs>
      ${zeroLine}
      <path class="area" d="${area}"/>
      <path class="line" d="${path}"/>
    </svg>
  `;
}

export function openForecastSheet(){
  const startCash = currentCash();
  const days = 90;
  const events = buildEvents(days);
  const series = buildSeries(events, startCash, days);

  const endBal  = series[series.length - 1].balance;
  const minBal  = series.reduce((m, s) => s.balance < m.balance ? s : m, series[0]);
  const netFlow = endBal - startCash;

  const fmtDate = (d) => `${monthName(d.getMonth()+1, true)} ${d.getDate()}`;
  const daysFromNow = (d) => {
    const td = new Date(); td.setHours(0,0,0,0);
    return Math.round((d - td) / 86400000);
  };

  // Group events for the list view: by date, each date becomes a row-group
  const byDate = {};
  for (const e of events){
    const iso = toLocalISO(e.date);
    (byDate[iso] = byDate[iso] || []).push(e);
  }
  const sortedDates = Object.keys(byDate).sort();

  $('#sheetBody').innerHTML = `
    <h2>Cashflow Forecast</h2>
    <div class="muted small" style="margin-bottom:14px;">
      Next ${days} days, projected from today's cash (${fmt(startCash)}) using detected recurring income, subscriptions, and your configured bills. Cards you pay in full come out of cash on pay-run day (the ${ordinal(bulkPayDay())}), not when charged.
    </div>

    <div class="sub-totals">
      <div class="sub-tile">
        <div class="l">Today</div>
        <div class="v">${fmtShort(startCash)}</div>
      </div>
      <div class="sub-tile">
        <div class="l">In ${days}d</div>
        <div class="v" style="color:${endBal >= startCash ? 'var(--green)' : 'var(--red)'};">${fmtShort(endBal)}</div>
      </div>
      <div class="sub-tile">
        <div class="l">Net flow</div>
        <div class="v" style="color:${netFlow >= 0 ? 'var(--green)' : 'var(--red)'};">${netFlow >= 0 ? '+' : '−'}${fmtShort(Math.abs(netFlow))}</div>
      </div>
    </div>

    <div class="fc-chart-wrap">
      ${renderChartSVG(series)}
    </div>

    ${minBal.balance < startCash * 0.2 || minBal.balance < 0 ? `
      <div class="debt-warn" style="margin-top:4px;">
        ⚠ Lowest projected point: ${fmt(minBal.balance)} on ${fmtDate(minBal.date)} (in ${daysFromNow(minBal.date)}d).
      </div>
    ` : ''}

    ${events.length === 0 ? `
      <div class="empty" style="padding:30px 10px;">
        <div class="big">No upcoming events.</div>
        Log a few months of recurring income and expenses, or add bills in the Bills tab.
      </div>
    ` : `
      <h3 class="card-title" style="margin-top:18px;">Upcoming Events <span class="pill">${events.length}</span></h3>
      ${sortedDates.map(iso => {
        const d = parseLocalDate(iso);
        const dLbl = fmtDate(d);
        const away = daysFromNow(d);
        const awayLbl = away === 0 ? 'Today' : `in ${away}d`;
        const dayTotal = byDate[iso].reduce((s, e) => s + (e.cardCharge ? 0 : e.amount), 0);
        return `
          <div class="fc-day">
            <div class="fc-day-head">
              <div class="fc-day-date">${dLbl} <span class="muted small" style="font-weight:400;">· ${awayLbl}</span></div>
              <div class="fc-day-net ${dayTotal >= 0 ? 'pos' : 'neg'}">${dayTotal >= 0 ? '+' : '−'}${fmtShort(Math.abs(dayTotal))}</div>
            </div>
            ${byDate[iso].map(e => {
              const isIn = e.amount > 0;
              const iconMap = { income:'+', subscription:'↻', bill:'✓', card:'$' };
              const iconCls = { income:'inc', subscription:'pay', bill:'pay', card:'pay' };
              return `
                <div class="fc-event" style="${e.cardCharge ? 'opacity:.6;' : ''}">
                  <div class="txn-icon ${iconCls[e.kind]}">${iconMap[e.kind]}</div>
                  <div class="fc-event-body">
                    <div class="fc-event-label">${esc(e.label)}</div>
                    <div class="fc-event-detail">${esc(e.detail)}</div>
                  </div>
                  <div class="fc-event-amt ${isIn ? 'pos' : 'neg'}">${isIn ? '+' : '−'}$${Math.abs(e.amount).toFixed(2)}</div>
                </div>
              `;
            }).join('')}
          </div>
        `;
      }).join('')}
    `}

    <div class="muted small" style="margin-top:14px;text-align:center;line-height:1.55;">
      Forecast quality improves with more transaction history. One-off purchases aren't projected, and charges on a card whose payment is a bill reach cash through that bill.
    </div>
  `;
  openSheet({ wide: true }); // v3.1: centered dialog unfolded
}
