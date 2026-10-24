/* ============================================================
   nextmonth.js — NEW(v3.2): the bulk-pay planner.

   You pay your cards and bills in one go on a set day (the 1st, by default —
   flags.bulkPay = { day }). Two things make that day easy:

   NEXT MONTH PREVIEW — walks today's cash through the next pay run:
     cash today
       − what's still due before the run (unpaid bills, charges, minus any
         paycheck that lands first)
       = going into the run
       − the run: every card you pay in full (balance + the charges that land
         before the day) and every bill due from the run day to the next run
       = after the run, then the paychecks and charges later in the cycle
     and what is already building on your cards for the run after that.
   It reads the same events as the Cashflow Forecast (forecast.js), so the two
   always agree; it covers KNOWN money only — everyday spending isn't in it.

   PAY RUN — a checklist of exactly what you'd pay on the day: tick, adjust an
   amount, "Pay N items" logs them all at once with a single Undo. Cards paid
   in full come from the checking account you usually pay them from.
   ============================================================ */

import { $, $$, fmt, esc, today, parseLocalDate, toLocalISO, addDays, daysBetween, monthName, sumMoney, round2, parseAmount, uid, toast, toastAction, haptic, busyGuard } from './util.js';
import { state, dbPut, dbDel, saveFlags } from './db.js';
import { balanceLatest } from './effects.js';
import { openSheet, closeSheet, openPicker } from './sheet.js';
import { buildEvents, bulkPayDay, runDatesBetween, payInFullCards, currentCash } from './forecast.js';
import { isBillPaid, billAppliesToMonth, getBillAmount, getBillDueDay, isBillEstimated, isVariableBill, logBillPayment, plannedCardPayment } from './bills.js';
import { renderCurrent } from './app.js';
import { ignoreRecurring, unignoreRecurring } from './subscriptions.js';
import { payerFor } from './cards.js';
import { cardPayMode, statementInfo } from './statement.js';

const fmtDay = (d) => `${monthName(d.getMonth() + 1, true)} ${d.getDate()}`;
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
const isCash = (e) => !e.cardCharge && e.kind !== 'card';

// Same label + kind on several days (a weekly $1 charge) reads as one line.
function groupEvents(list){
  const m = new Map();
  for (const e of list){
    const k = `${e.kind}|${e.label}`;
    const g = m.get(k) || { label: e.label, kind: e.kind, amount: 0, count: 0, first: e.date, last: e.date, detail: e.detail, est: false, acct: e.acct, seriesKey: e.seriesKey };
    g.amount = round2(g.amount + e.amount); g.count++; g.last = e.date; g.est = g.est || !!e.est;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => a.first - b.first);
}

/* ── the plan ──────────────────────────────────────────────────────── */
export function nextMonthPlan(todayIso = today()){
  const todayD = parseLocalDate(todayIso);
  const runs = runDatesBetween(todayD, addDays(todayD, 75));
  const run = runs[0], run2 = runs[1];
  const events = buildEvents(daysBetween(todayIso, toLocalISO(run2)) + 1);
  const cash = currentCash();

  const before = events.filter(e => isCash(e) && e.date < run);
  const beforeOut = sumMoney(before.filter(e => e.amount < 0), e => -e.amount);
  const beforeIn = sumMoney(before.filter(e => e.amount > 0), e => e.amount);
  const goingIn = round2(cash - beforeOut + beforeIn);

  const cards = events.filter(e => e.kind === 'card' && +e.date === +run);
  const bills = events.filter(e => e.kind === 'bill' && !e.cardCharge && e.date >= run && e.date < run2);
  const runTotal = round2(sumMoney(cards, e => -e.amount) + sumMoney(bills, e => -e.amount));
  const afterRun = round2(goingIn - runTotal);

  const rest = events.filter(e => isCash(e) && e.kind !== 'bill' && e.date >= run && e.date < run2);
  const restIn = sumMoney(rest.filter(e => e.amount > 0), e => e.amount);
  const restOut = sumMoney(rest.filter(e => e.amount < 0), e => -e.amount);
  const endOfCycle = round2(afterRun + restIn - restOut);

  // Lowest cash between the run and the end of the cycle (the run lands first).
  let low = { amount: afterRun, date: run };
  let bal = afterRun;
  for (const e of rest){ bal = round2(bal + e.amount); if (bal < low.amount) low = { amount: bal, date: e.date }; }

  const building = events.filter(e => e.cardCharge && e.date >= run && e.date < run2);
  const nextCards = events.filter(e => e.kind === 'card' && +e.date === +run2);
  return {
    today: todayD, run, run2, cash,
    before: groupEvents(before), beforeOut, beforeIn, goingIn,
    cards, bills, runTotal, afterRun,
    rest: groupEvents(rest), restIn, restOut, endOfCycle, low,
    building: groupEvents(building), nextCards,
    buildingTotal: round2(sumMoney(nextCards, e => -e.amount)),
    hasCards: payInFullCards().length > 0
  };
}

/* ── Home card ─────────────────────────────────────────────────────── */
export function renderNextMonthCard(){
  const p = nextMonthPlan();
  return `
    <div class="card" style="margin-top:14px;">
      <h3 class="card-title">Next month <span class="pill">${esc(fmtDay(p.run))} pay run</span></h3>
      <div class="real-breakdown">
        <div class="rb-row"><span>Cash going into ${esc(fmtDay(p.run))}</span><span class="mono">${fmt(p.goingIn)}</span></div>
        <div class="rb-row"><span>− Pay run</span><span class="mono amber">${fmt(p.runTotal)}</span></div>
        <div class="rb-row total"><span>= After the pay run</span><span class="mono ${p.afterRun >= 0 ? 'pos' : 'neg'}">${fmt(p.afterRun)}</span></div>
      </div>
      <button type="button" class="btn secondary" id="nm-open" style="margin-top:10px;">See the preview</button>
    </div>`;
}
export function wireNextMonthCard(root){
  $('#nm-open', root)?.addEventListener('click', () => openNextMonthSheet());
}

/* ── the preview sheet ─────────────────────────────────────────────── */
export function openNextMonthSheet(){
  const p = nextMonthPlan();
  const out = (n) => `<span class="mono amber">−${fmt(Math.abs(n)).replace('−', '')}</span>`;
  const inn = (n) => `<span class="mono pos">+${fmt(n)}</span>`;
  const row = (label, right, { sub = '', total = false, minor = false } = {}) => `
    <div class="nm-row${total ? ' nm-total' : ''}${minor ? ' nm-minor' : ''}">
      <span class="nm-l">${esc(label)}${sub ? `<span class="nm-sub">${esc(sub)}</span>` : ''}</span>${right}
    </div>`;
  // A projected charge came from a detected pattern — let it be dismissed right here.
  const evRow = (g) => row(
    `${g.est ? '~' : ''}${g.label}${g.count > 1 ? ` ×${g.count}` : ''}`,
    (g.amount < 0 ? out(g.amount) : inn(g.amount)) + (g.seriesKey ? `<button type="button" class="link-btn nm-ignore" data-key="${esc(g.seriesKey)}" title="Not recurring" aria-label="Not recurring" style="margin-left:8px;">✕</button>` : ''),
    { sub: `${fmtDay(g.first)}${g.count > 1 ? ` – ${fmtDay(g.last)}` : ''}${g.detail ? ' · ' + g.detail : ''}${g.seriesKey ? ' · tap ✕ if this isn\'t really recurring' : ''}`, minor: true });
  const list = (groups, max = 8) => groups.slice(0, max).map(evRow).join('')
    + (groups.length > max ? `<div class="nm-note" style="margin-top:2px;">+ ${groups.length - max} more</div>` : '');
  const runLabel = fmtDay(p.run);
  const through = fmtDay(addDays(p.run, -1));

  $('#sheetBody').innerHTML = `
    <h2>Next month</h2>
    <div class="muted small" style="margin-bottom:6px;line-height:1.5;">Your cash walked through the ${esc(runLabel)} pay run, using known bills, recurring charges and paychecks. Everyday spending (groceries, gas…) isn't in it.</div>

    <div class="nm-sec">
      ${row('Cash today', `<span class="mono">${fmt(p.cash)}</span>`, { total: true })}
    </div>

    <div class="nm-sec">
      <div class="nm-sec-h">Before the pay run · through ${esc(through)}</div>
      ${p.before.length ? list(p.before) : '<div class="nm-note" style="margin-top:0;">Nothing else due before then.</div>'}
      ${row(`= Going into ${runLabel}`, `<span class="mono ${p.goingIn >= 0 ? '' : 'neg'}">${fmt(p.goingIn)}</span>`, { total: true })}
    </div>

    <div class="nm-sec">
      <div class="nm-sec-h">${esc(runLabel)} pay run</div>
      ${p.cards.map(c => row(c.label, out(c.amount), { sub: c.detail, minor: true })).join('')}
      ${p.bills.map(b => row(`${b.est ? '~' : ''}${b.label}`, out(b.amount), { sub: `due ${ordinal(b.date.getDate())}${b.detail.includes('overdue') ? ' · overdue' : ''}`, minor: true })).join('')}
      ${!p.cards.length && !p.bills.length ? '<div class="nm-note" style="margin-top:0;">Nothing to pay in that run.</div>' : ''}
      ${row('− Pay run total', out(p.runTotal), { total: true })}
      ${row('= After the pay run', `<span class="mono ${p.afterRun >= 0 ? 'pos' : 'neg'}">${fmt(p.afterRun)}</span>`, { total: true })}
    </div>

    <div class="nm-sec">
      <div class="nm-sec-h">Rest of the cycle · ${esc(runLabel)} – ${esc(fmtDay(addDays(p.run2, -1)))}</div>
      ${p.rest.length ? list(p.rest) : '<div class="nm-note" style="margin-top:0;">No known paychecks or cash charges.</div>'}
      ${row('= End of the cycle', `<span class="mono ${p.endOfCycle >= 0 ? 'pos' : 'neg'}">${fmt(p.endOfCycle)}</span>`, { total: true })}
      ${row('Lowest point', `<span class="mono ${p.low.amount >= 0 ? '' : 'neg'}">${fmt(p.low.amount)}</span>`, { sub: fmtDay(p.low.date), minor: true })}
    </div>

    ${p.building.length || p.nextCards.length ? `
    <div class="nm-sec">
      <div class="nm-sec-h">Building on your cards · for the ${esc(fmtDay(p.run2))} run</div>
      ${p.nextCards.map(c => row(c.label, out(c.amount), { sub: c.detail, minor: true })).join('')}
      ${p.building.length ? '<div class="nm-sec-h" style="margin-top:8px;">Known charges</div>' + list(p.building) : ''}
      ${row('Known so far', out(p.buildingTotal), { total: true })}
    </div>` : ''}

    ${!p.hasCards ? '<div class="nm-note">Tip: check the cards you pay in full in Real available (⚙ on Home) and they show up in the pay run.</div>' : ''}
    <button type="button" class="btn" id="nm-payrun" style="margin-top:16px;">Open the pay run</button>
    <button type="button" class="btn ghost" id="nm-day" style="margin-top:10px;">Pay-run day: the ${esc(ordinal(bulkPayDay()))}</button>
  `;
  openSheet();
  $('#nm-payrun').addEventListener('click', () => openPayRunSheet());
  $$('.nm-ignore').forEach(b => b.addEventListener('click', async () => {
    const key = b.dataset.key;
    await ignoreRecurring(key);
    renderCurrent();
    openNextMonthSheet();
    toastAction('Won\'t be treated as recurring', 'Undo', async () => { await unignoreRecurring(key); renderCurrent(); openNextMonthSheet(); });
  }));
  $('#nm-day').addEventListener('click', () => {
    openPicker('Pay-run day', Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `The ${ordinal(i + 1)}` })), String(bulkPayDay()), async (val) => {
      state.flags.bulkPay = { day: Number(val) };
      await saveFlags();
      renderCurrent();
      openNextMonthSheet();
    });
  });
}

/* ── pay run ───────────────────────────────────────────────────────── */
// What the pay run for a month contains.
export function payRunItems(year, month){
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const full = payInFullCards();
  const bills = state.bills
    .filter(b => b.active !== false && billAppliesToMonth(b, year, month) && !isBillPaid(b, ym))
    .filter(b => {
      if (b.recurrence === 'auto-cc') return !full.includes(b.linkedAccount);        // the card line covers it
      return !((b.type || 'Expense') === 'Expense' && full.includes(b.account));    // a charge TO a pay-in-full card isn't paid in the run
    })
    .map(b => ({
      kind: 'bill', bill: b, name: b.name, amount: getBillAmount(b, year, month),
      meta: b.recurrence === 'once' ? `due ${b.dueDate}` : `due the ${ordinal(getBillDueDay(b))}`,
      est: isBillEstimated(b, ym)
    }))
    .filter(i => i.amount > 0)
    .sort((a, b) => getBillDueDay(a.bill) - getBillDueDay(b.bill));
  const cards = full
    .map(n => {
      const s = cardPayMode(n) === 'statement' ? statementInfo(n) : null;
      const due = round2(s ? s.remaining : Math.max(0, balanceLatest(n)));
      const plan = plannedCardPayment(n, ym);     // NEW(v3.2): "I'll pay X"
      return { kind: 'card', name: n, amount: plan != null ? plan : due, from: payerFor(n),
               meta: (plan != null ? `paying ${fmt(plan)} of ${fmt(due)} · ` : '')
                     + (s ? `statement closed ${fmtDay(parseLocalDate(s.closeIso))}${s.entered ? ' (entered)' : s.needsEntry ? ' (estimate)' : ''} · from ` : 'pay in full · from ') };
    })
    .filter(c => c.amount > 0.004 && c.from)
    .map(c => ({ ...c, meta: c.meta + c.from }));
  return [...cards, ...bills];
}

// Home: only on/just after the pay-run day, and only while something's left.
export function renderPayRunCard(){
  const now = new Date();
  const since = now.getDate() - bulkPayDay();
  if (since < 0 || since > 3) return '';
  const items = payRunItems(now.getFullYear(), now.getMonth() + 1);
  if (!items.length) return '';
  const total = round2(sumMoney(items, i => i.amount));
  return `
    <div class="card" style="margin-top:14px;">
      <h3 class="card-title">${since === 0 ? 'Pay run today' : 'Pay run'} <span class="pill">${items.length} to pay</span></h3>
      <div class="rb-row"><span>Cards + bills</span><span class="mono amber">${fmt(total)}</span></div>
      <button type="button" class="btn secondary" id="pr-open" style="margin-top:10px;">Start the pay run</button>
    </div>`;
}
export function wirePayRunCard(root){
  $('#pr-open', root)?.addEventListener('click', () => openPayRunSheet());
}

export function openPayRunSheet(){
  const { year, month } = state.selected;
  const items = payRunItems(year, month);
  const on = items.map(() => true);
  const amts = items.map(i => i.amount);
  const ym = `${year}-${String(month).padStart(2, '0')}`;

  const totals = () => {
    const sel = items.map((_, i) => i).filter(i => on[i]);
    return { n: sel.length, total: round2(sumMoney(sel, i => amts[i])) };
  };
  const draw = () => {
    const t = totals();
    $('#sheetBody').innerHTML = `
      <h2>Pay run · ${esc(monthName(month, true))} ${year}</h2>
      <div class="muted small" style="margin-bottom:8px;line-height:1.5;">Untick anything you're not paying today; change an amount if it's different. Payments are logged dated today.</div>
      ${items.length === 0 ? '<div class="empty" style="padding:24px 10px;"><div class="big">Nothing to pay.</div>Every bill this month is paid and no pay-in-full card carries a balance.</div>' : items.map((i, k) => `
        <div class="pr-row${on[k] ? '' : ' is-off'}" data-k="${k}">
          <button type="button" class="bill-check pr-tick ${on[k] ? 'checked' : ''}" data-k="${k}" aria-label="Include">
            ${on[k] ? '<svg viewBox="0 0 14 14" width="14" height="14"><path d="M2 7l3.5 3.5L12 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
          </button>
          <div class="pr-body">
            <div class="pr-name">${i.est ? '~' : ''}${esc(i.name)}</div>
            <div class="pr-meta">${esc(i.meta)}${i.est ? ' · estimate' : ''}</div>
          </div>
          <input class="input pr-amt" data-k="${k}" type="text" inputmode="decimal" value="${amts[k].toFixed(2)}" aria-label="Amount" />
        </div>`).join('')}
      ${items.length ? `
        <div class="pr-total"><span>${t.n} item${t.n === 1 ? '' : 's'}</span><span class="mono">${fmt(t.total)}</span></div>
        <button type="button" class="btn" id="pr-go" ${t.n ? '' : 'disabled'}>Pay ${t.n} item${t.n === 1 ? '' : 's'} · ${fmt(t.total)}</button>` : ''}
      <button type="button" class="btn ghost" id="pr-close" style="margin-top:10px;">${items.length ? 'Cancel' : 'Close'}</button>
    `;
    $$('.pr-tick').forEach(b => b.addEventListener('click', () => { on[+b.dataset.k] = !on[+b.dataset.k]; draw(); }));
    $$('.pr-amt').forEach(inp => inp.addEventListener('change', () => {
      const v = parseAmount(inp.value);
      if (!isNaN(v) && v >= 0) amts[+inp.dataset.k] = round2(v);
      draw();
    }));
    $('#pr-close').addEventListener('click', closeSheet);
    $('#pr-go')?.addEventListener('click', go);
  };

  const go = busyGuard(async () => {
    const chosen = items.map((i, k) => ({ i, amount: amts[k] })).filter((_, k) => on[k] && amts[k] > 0);
    if (!chosen.length) return;
    const dateIso = today();
    const created = [];       // transaction ids
    const snapshots = [];     // bills as they were
    for (const { i, amount } of chosen){
      if (i.kind === 'bill'){
        snapshots.push([i.bill, JSON.parse(JSON.stringify(i.bill))]);
        created.push((await logBillPayment(i.bill, year, month, amount, dateIso)).id);
      } else {
        const txn = { id: uid(), date: dateIso, type: 'CC Payment', account: i.name, fromAccount: i.from,
                      category: 'CC Payment', description: 'Pay run', amount };
        await dbPut('transactions', txn);
        state.transactions.unshift(txn);
        created.push(txn.id);
      }
    }
    state.transactions.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    closeSheet(); renderCurrent(); haptic(15);
    const total = round2(sumMoney(chosen, c => c.amount));
    toastAction(`Paid ${chosen.length} item${chosen.length === 1 ? '' : 's'} · ${fmt(total)}`, 'Undo', async () => {
      for (const id of created) await dbDel('transactions', id);
      state.transactions = state.transactions.filter(t => !created.includes(t.id));
      for (const [bill, before] of snapshots){
        for (const k of Object.keys(bill)) delete bill[k];
        Object.assign(bill, before);
        await dbPut('bills', bill);
      }
      renderCurrent();
      toast('Pay run undone');
    }, 9000);
  });
  draw();
  openSheet();
}
