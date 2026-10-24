/* ============================================================
   payday.js — NEW(v3.1): "Safe to spend" per day until payday.

   Payday is either set by hand (flags.payday = { mode:'manual', anchor,
   every }) or detected from your income: the paycheck-like category
   (Salary / Paycheck / Payroll / Wages…, else the biggest regular income)
   is grouped into paydays — deposits within 3 days of each other are one
   payday (split direct deposits) — and the cadence comes from the gaps.

   Safe to spend = checking now
                 − bills and recurring charges due before payday (the same
                   events the Cashflow Forecast projects)
                 − the cards you subtract in Real available
   … divided by the days left until payday (today included).

   v3.2: a paycheck logged AHEAD of payday (HR approved payroll early, so you
   entered it on the 25th on the 24th) is already in checking — it isn't the
   "next payday" any more. Any logged paycheck within 3 days of a candidate
   payday means that payday has happened, and the window runs to the one
   after. A twice-a-month pay (the 10th and 25th) is recognised as such and
   follows the calendar instead of a fixed 15-day step.
   ============================================================ */

import { $, $$, fmt, esc, today, parseLocalDate, toLocalISO, addDays, daysBetween, sumMoney, round2, toast } from './util.js';
import { state, saveFlags } from './db.js';
import { balanceLatest } from './effects.js';
import { buildEvents } from './forecast.js';
import { semiMonthlySlots } from './subscriptions.js';
import { openSheet, closeSheet } from './sheet.js';

const PAY_RE = /salary|pay\s?check|payroll|wage|direct\s?dep/i;
const EVERY = { week: 7, '2weeks': 14, month: 'month' };
const EVERY_LABEL = { week: 'every week', '2weeks': 'every 2 weeks', month: 'monthly' };
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
const SHORT = { weekday: 'short', month: 'short', day: 'numeric' };
const dayLabel = (d) => d.toLocaleDateString('en-US', SHORT);

function median(a){
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// The k-th payday after `a`. Monthly keeps the original day (31st → Feb 28
// → Mar 31), it doesn't drift to the shortest month's.
const nthPayday = (a, step, k) => step === 'month'
  ? new Date(a.getFullYear(), a.getMonth() + k, Math.min(a.getDate(), new Date(a.getFullYear(), a.getMonth() + k + 1, 0).getDate()))
  : addDays(a, step * k);

// Paydays (cluster start dates, ascending) for one income category.
export function paydayClusters(category, sinceIso){
  const dates = [...new Set(state.transactions
    .filter(t => t.type === 'Income' && t.category === category && t.date && t.date >= sinceIso)
    .map(t => t.date))].sort();
  const out = [];
  for (const d of dates){
    if (out.length && daysBetween(out[out.length - 1].last, d) <= 3){ out[out.length - 1].last = d; continue; }
    out.push({ first: d, last: d });
  }
  return out.map(c => c.first);
}

// → { category, step (days | 'month'), last (iso), approx: true } or null.
export function detectPaySchedule(todayIso = today()){
  const since = toLocalISO(addDays(parseLocalDate(todayIso), -150));
  const totals = {};
  for (const t of state.transactions){
    if (t.type !== 'Income' || !t.date || t.date < since || t.date > todayIso) continue;
    totals[t.category] = (totals[t.category] || 0) + (t.amount || 0);
  }
  const cats = Object.keys(totals).sort((a, b) =>
    (PAY_RE.test(b) - PAY_RE.test(a)) || (totals[b] - totals[a]));
  for (const category of cats){
    const days = paydayClusters(category, since).filter(d => d <= todayIso);
    if (days.length < 3) continue;
    const gaps = days.slice(1).map((d, i) => daysBetween(days[i], d)).slice(-5);
    const g = median(gaps);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    if (sd / mean > 0.35) continue;                       // irregular (gig income, gifts…)
    let step = null;
    if (g >= 6 && g <= 8) step = 7;
    else if (g >= 12 && g <= 17) step = Math.round(g);
    else if (g >= 26 && g <= 35) step = 'month';
    if (!step) continue;
    // NEW(v3.2): the same two days every month → follow the calendar.
    const slots = typeof step === 'number' && step >= 12 ? semiMonthlySlots(days.map(parseLocalDate)) : null;
    if (slots) return { category, step: 'semi', slots, last: days[days.length - 1], approx: true };
    return { category, step, last: days[days.length - 1], approx: true };
  }
  return null;
}

// Next payday strictly after today (expectedToday when one is due today
// but hasn't been logged yet — the money isn't in checking, so the
// conservative count runs to the one after).
export function nextPayday(todayIso = today()){
  const p = state.flags.payday;
  if (p?.mode === 'manual' && p.anchor && EVERY[p.every]){
    return rollForward({ step: EVERY[p.every], last: p.anchor, manual: true, every: p.every }, todayIso);
  }
  const auto = detectPaySchedule(todayIso);
  return auto ? rollForward(auto, todayIso) : null;
}
// Candidate paydays for a twice-a-month schedule, ascending, around `t`.
function semiDates(slots, t){
  const out = [];
  for (let k = -1; k < 5; k++){
    const last = new Date(t.getFullYear(), t.getMonth() + k + 1, 0).getDate();
    for (const day of slots) out.push(new Date(t.getFullYear(), t.getMonth() + k, Math.min(day, last)));
  }
  return out.sort((a, b) => a - b);
}
function rollForward(sched, todayIso){
  const t = parseLocalDate(todayIso), a = parseLocalDate(sched.last);
  // Paychecks already in the books (future-dated ones included) of this schedule's category.
  const cat = sched.category || detectPaySchedule(todayIso)?.category;
  const logged = cat ? paydayClusters(cat, toLocalISO(addDays(t, -45))) : [];
  const isLogged = (d) => logged.some(l => Math.abs(daysBetween(l, toLocalISO(d))) <= 3);
  const dates = sched.step === 'semi' ? semiDates(sched.slots, t) : null;
  let expectedToday = false;
  for (let k = 0; k < (dates ? dates.length : 800); k++){
    const d = dates ? dates[k] : nthPayday(a, sched.step, k);
    if (d < t || isLogged(d)) continue;          // gone by, or already deposited (maybe early)
    // Today is a payday that isn't in the data yet — the money isn't in
    // checking, so the conservative count runs to the one after.
    if (+d === +t){ expectedToday = true; continue; }
    return { ...sched, date: d, expectedToday };   // a future manual anchor is k = 0
  }
  return null;
}

export function safeToSpend(todayIso = today()){
  const checking = state.accounts.filter(a => a.active && a.type === 'Checking');
  if (!checking.length) return null;
  const pay = nextPayday(todayIso);
  if (!pay) return { pay: null };
  const days = Math.max(1, daysBetween(todayIso, toLocalISO(pay.date)));
  const cash = sumMoney(checking, a => balanceLatest(a.name));
  const raCards = (state.flags.realAvailCards || []).filter(n => state.accounts.find(a => a.name === n && a.active));
  const cardLines = raCards.map(n => ({ name: n, bal: balanceLatest(n) }));
  const cardDeduct = sumMoney(cardLines, c => c.bal);
  const end = pay.date;
  const due = buildEvents(days).filter(e => e.kind !== 'income' && e.amount < 0 && e.date < end && !raCards.includes(e.acct));
  const dueBefore = sumMoney(due, e => -e.amount);
  const total = round2(cash - dueBefore - cardDeduct);
  const spentToday = sumMoney(state.transactions.filter(t => t.type === 'Expense' && t.date === todayIso), t => t.amount);
  return { pay, days, cash, cardLines, cardDeduct, due, dueBefore, total, perDay: round2(total / days), spentToday };
}

/* ── Home card ── */
export function renderSafeCard(){
  const s = safeToSpend();
  if (!s) return '';
  if (!s.pay) return `
    <div class="card safe-card" style="margin-top:14px;">
      <h3 class="card-title">Safe to spend</h3>
      <div class="muted small" style="line-height:1.5;margin-bottom:10px;">No regular paycheck found yet. Tell Ledger when you get paid to see what's safe to spend each day until then.</div>
      <button class="btn secondary" id="safe-config">Set payday</button>
    </div>`;
  const when = s.pay.expectedToday ? `payday expected today · then ${dayLabel(s.pay.date)}` : `${s.days} day${s.days === 1 ? '' : 's'} until payday · ${dayLabel(s.pay.date)}`;
  return `
    <div class="card safe-card" style="margin-top:14px;">
      <div class="real-head">
        <div>
          <div class="l">Safe to spend</div>
          ${s.total >= 0
            ? `<div class="v pos">${fmt(s.perDay)}<span class="safe-unit">/day</span></div>`
            : `<div class="v neg">${fmt(-s.total)} short</div>`}
          <div class="sub">${esc(when)}${s.pay.approx ? ' (estimated)' : ''}</div>
        </div>
        <button class="btn ghost" id="safe-config" style="width:auto;padding:8px 11px;font-size:13px;" aria-label="Payday settings">⚙</button>
      </div>
      <div class="real-breakdown">
        <div class="rb-row"><span>Checking</span><span class="mono">${fmt(s.cash)}</span></div>
        <div class="rb-row"><span>− Due before payday${s.due.length ? ` (${s.due.length})` : ''}</span><span class="mono amber">${fmt(s.dueBefore)}</span></div>
        ${s.cardLines.map(c => `<div class="rb-row"><span>− ${esc(c.name)}</span><span class="mono amber">${fmt(c.bal)}</span></div>`).join('')}
        <div class="rb-row total"><span>= Until payday</span><span class="mono ${s.total >= 0 ? 'pos' : 'neg'}">${fmt(s.total)}</span></div>
        ${s.spentToday ? `<div class="rb-row"><span>Spent today</span><span class="mono">${fmt(s.spentToday)}</span></div>` : ''}
      </div>
    </div>`;
}

export function wireSafeCard(root, onChange){
  $('#safe-config', root)?.addEventListener('click', () => openPaydaySheet(onChange));
}

export function openPaydaySheet(onChange){
  const p = state.flags.payday || {};
  const auto = detectPaySchedule();
  const autoNext = auto ? rollForward(auto, today()) : null;
  const nxt = nextPayday();
  let mode = p.mode === 'manual' ? 'manual' : 'auto';
  let every = EVERY[p.every] ? p.every : '2weeks';
  let anchor = p.anchor || (nxt ? toLocalISO(nxt.date) : today());
  const draw = () => {
    $('#sheetBody').innerHTML = `
      <h2>Payday</h2>
      <div class="seg" id="pd-mode" role="tablist">
        <button type="button" class="seg-btn ${mode === 'auto' ? 'active' : ''}" data-v="auto">Detect it</button>
        <button type="button" class="seg-btn ${mode === 'manual' ? 'active' : ''}" data-v="manual">Set it myself</button>
      </div>
      ${mode === 'auto' ? `
        <div class="muted small" style="margin:12px 0;line-height:1.55;">
          ${auto ? `From your <b>${esc(auto.category)}</b> deposits: ${auto.step === 'month' ? 'monthly' : auto.step === 'semi' ? `twice a month (~the ${ordinal(auto.slots[0])} and ${ordinal(auto.slots[1])})` : `every ~${auto.step} days`}, last on ${esc(dayLabel(parseLocalDate(auto.last)))}.`
                   + (autoNext ? `<br>Next payday ≈ <b>${esc(dayLabel(autoNext.date))}</b>.` : '')
                 : "Couldn't find a regular paycheck in the last 5 months — set it yourself."}
        </div>` : `
        <div class="field" style="margin-top:12px;"><label for="pd-date">A payday (the next one, or a recent one)</label>
          <input type="date" id="pd-date" value="${esc(anchor)}" /></div>
        <div class="field"><label>Paid</label>
          <div class="seg" id="pd-every" role="tablist">
            ${Object.keys(EVERY).map(k => `<button type="button" class="seg-btn ${every === k ? 'active' : ''}" data-v="${k}">${esc(EVERY_LABEL[k][0].toUpperCase() + EVERY_LABEL[k].slice(1))}</button>`).join('')}
          </div></div>`}
      <div class="muted small" style="margin:6px 0 14px;line-height:1.5;">Safe to spend = checking, minus bills and recurring charges due before payday, minus the cards you subtract in Real available — spread over the days left.</div>
      <button class="btn" id="pd-save">Save</button>`;
    $$('#pd-mode .seg-btn').forEach(b => b.addEventListener('click', () => { mode = b.dataset.v; draw(); }));
    $$('#pd-every .seg-btn').forEach(b => b.addEventListener('click', () => { every = b.dataset.v; draw(); }));
    $('#pd-date')?.addEventListener('input', (e) => { anchor = e.target.value; });
    $('#pd-save').addEventListener('click', async () => {
      if (mode === 'manual'){
        if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)){ toast('Pick a payday date'); return; }
        state.flags.payday = { mode: 'manual', anchor, every };
      } else state.flags.payday = { mode: 'auto' };
      await saveFlags();
      closeSheet();
      onChange?.();
    });
  };
  draw();
  openSheet();
}
