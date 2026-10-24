/* ============================================================
   recurring.js — NEW(v3.1): "Netflix is usually charged today — log it?"

   Uses the subscription detector (subscriptions.js detectRecurring): a
   merchant charged on a steady monthly / bi-monthly / quarterly / yearly
   rhythm whose next charge is due today (or up to 3 days ago) and hasn't
   been logged yet gets a one-tap prompt on Home. Bills already remind you
   about what they cover, so those are skipped; "Not now" hides a prompt
   until the next charge.
   ============================================================ */

import { $$, fmt, esc, today, toLocalISO, daysBetween, uid, toastAction, toast, squash } from './util.js';
import { state, dbPut, dbDel, saveFlags } from './db.js';
import { detectRecurring } from './subscriptions.js';
import { invalidateMerchantCache } from './merchants.js';
import { seriesCoveredByBill } from './bills.js';

const MONTHS = { 30: 1, 60: 2, 91: 3, 365: 12 };
const GRACE_DAYS = 3;

// Next charge on the calendar, N months on, on the series' usual day of the
// month (clamped to short months). The usual day, not the last charge's:
// a 31st-of-the-month charge that landed on Sep 30 is due Oct 31, not Oct 30.
export function nextCharge(last, canon, usualDay = last.getDate()){
  const d = new Date(last.getFullYear(), last.getMonth() + MONTHS[canon], 1);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(usualDay, lastDay));
  return d;
}
// Most common day of the month in the series (ties → the later day, since
// short months only ever pull a charge earlier).
function usualDay(txns){
  const n = {};
  for (const t of txns) { const d = Number(t.date.slice(8, 10)); n[d] = (n[d] || 0) + 1; }
  return Number(Object.entries(n).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]);
}

const coveredByBill = seriesCoveredByBill;   // v3.2: shared with the forecast and Pace

// [{ key, label, due, late, txn: the latest charge (template) }]
export function recurringPrompts(todayIso = today()){
  const dismissed = state.flags.recurDismissed || {};
  const out = [];
  for (const r of detectRecurring('Expense')){
    if (!r.key.startsWith('m:') || !MONTHS[r.canonDays]) continue;   // merchants on a monthly-or-longer rhythm
    if (coveredByBill(r)) continue;
    const series = state.transactions.filter(t => r.txnIds.has(t.id) && t.date).sort((a, b) => b.date.localeCompare(a.date));
    const latest = series[0];
    if (!latest) continue;
    const due = toLocalISO(nextCharge(r.last, r.canonDays, usualDay(series)));
    const late = daysBetween(due, todayIso);
    if (late < 0 || late > GRACE_DAYS) continue;
    if (dismissed[r.key] === due) continue;
    out.push({ key: r.key, label: r.label, due, late, txn: latest });
  }
  return out.sort((a, b) => b.late - a.late);
}

const whenLabel = (late) => late === 0 ? 'due today' : late === 1 ? 'was due yesterday' : `was due ${late} days ago`;
const usable = (n) => !!n && state.accounts.some(a => a.name === n && a.active);

export function renderRecurringCard(){
  const list = recurringPrompts();
  if (!list.length) return '';
  return `
    <div class="card recur-card" style="margin-top:14px;">
      <h3 class="card-title">Usually charged around now</h3>
      ${list.map(p => `
        <div class="recur-row" data-key="${esc(p.key)}">
          <div class="recur-l">
            <div class="recur-name">${esc(p.label)}</div>
            <div class="muted small">${fmt(p.txn.amount)}${usable(p.txn.account) ? ' · ' + esc(p.txn.account) : ''} · ${whenLabel(p.late)}</div>
          </div>
          <div class="recur-acts">
            <button type="button" class="btn secondary recur-log" data-key="${esc(p.key)}" ${usable(p.txn.account) ? '' : 'disabled'}>Log it</button>
            <button type="button" class="link-btn recur-edit" data-key="${esc(p.key)}">Edit first</button>
            <button type="button" class="link-btn recur-skip" data-key="${esc(p.key)}">Not now</button>
          </div>
        </div>`).join('')}
    </div>`;
}

// Logs the charge as last time, on the day it was due.
export async function logRecurring(p){
  const t = p.txn;
  const txn = { id: uid(), date: p.due, type: 'Expense', account: t.account, category: t.category,
                description: String(t.description ?? ''), amount: t.amount };
  if ((t.tags || []).length) txn.tags = [...t.tags];
  await dbPut('transactions', txn);
  state.transactions.push(txn);
  state.transactions.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  invalidateMerchantCache();
  return txn;
}

export function wireRecurringCard(root, { rerender, logAgain }){
  const find = (k) => recurringPrompts().find(p => p.key === k);
  $$('.recur-log', root).forEach(b => b.addEventListener('click', async () => {
    const p = find(b.dataset.key);
    if (!p) return;
    b.disabled = true;
    const txn = await logRecurring(p);
    rerender();
    toastAction(`Logged ${p.label} · ${fmt(txn.amount)}`, 'Undo', async () => {
      await dbDel('transactions', txn.id);
      state.transactions = state.transactions.filter(x => x.id !== txn.id);
      invalidateMerchantCache();
      rerender();
      toast('Removed');
    });
  }));
  $$('.recur-edit', root).forEach(b => b.addEventListener('click', () => {
    const p = find(b.dataset.key);
    if (p) logAgain(p.txn, { date: p.due });
  }));
  $$('.recur-skip', root).forEach(b => b.addEventListener('click', async () => {
    const p = find(b.dataset.key);
    if (!p) return;
    state.flags.recurDismissed = { ...(state.flags.recurDismissed || {}), [p.key]: p.due };
    await saveFlags();
    rerender();
  }));
}
