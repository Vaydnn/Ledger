/* ============================================================
   statement.js — NEW(v3.1): a card's statement balance vs its current one.

   Current balance  = everything charged so far (what Ledger always showed).
   Statement balance = the balance on the last statement's closing day —
                       paying THAT by the due date is what avoids interest.
   Still due        = statement balance − payments made since it closed.

   The cycle comes from the card itself (Accounts → card → "Statement
   closes on day"), else from an Auto (CC) bill tracking it.

   v3.2: you can ENTER the statement balance your bank shows (account.stmt =
   { closeIso, amount }). It stands for that one statement only — once the
   next one closes, Ledger goes back to computing it. Charges made after the
   closing day are never part of it: they ride on the NEXT statement, which is
   why "still due" and "charged since" are shown separately. Each card also
   has a pay mode (flags.cardPay[name]: 'statement' | 'full') — what the pay
   run and the forecast pay on pay-run day.
   ============================================================ */

import { today, parseLocalDate, toLocalISO, addDays, toCents, fromCents } from './util.js';
import { state } from './db.js';
import { acctTypeMap, txnEffectsCents, balanceLatest } from './effects.js';

export function cardCycle(name){
  const a = state.accounts.find(x => x.name === name);
  if (!a || a.type !== 'Credit Card') return null;
  if (a.closeDay) return { closeDay: a.closeDay, graceDays: a.graceDays ?? 25, source: 'card' };
  const b = state.bills.find(x => x.recurrence === 'auto-cc' && x.linkedAccount === name && x.active !== false && x.closeDay);
  if (b) return { closeDay: b.closeDay, graceDays: b.graceDays ?? 21, source: 'bill' };
  return null;
}

// The most recent closing date on or before `todayIso` (the day clamps to
// short months: closes on the 31st → Feb 28).
export function lastClose(closeDay, todayIso = today()){
  const t = parseLocalDate(todayIso);
  const onMonth = (y, m) => new Date(y, m, Math.min(closeDay, new Date(y, m + 1, 0).getDate()));
  const thisMonth = onMonth(t.getFullYear(), t.getMonth());
  return thisMonth <= t ? thisMonth : onMonth(t.getFullYear(), t.getMonth() - 1);
}

export function statementInfo(name, todayIso = today()){
  const cyc = cardCycle(name);
  if (!cyc) return null;
  const close = lastClose(cyc.closeDay, todayIso);
  const closeIso = toLocalISO(close);
  const aType = acctTypeMap();
  let afterC = 0, paidC = 0, chargedC = 0;
  for (const t of state.transactions){
    if (!t.date || t.date <= closeIso) continue;
    const eff = txnEffectsCents(t, aType)[name] || 0;
    afterC += eff;
    if (t.type === 'CC Payment' && t.account === name && eff < 0) paidC -= eff;
    else if (eff > 0) chargedC += eff;
  }
  const currentC = toCents(balanceLatest(name));
  const computedC = currentC - afterC;
  // NEW(v3.2): the amount you entered for THIS statement wins over the computed one.
  const a = state.accounts.find(x => x.name === name);
  const entered = !!(a && a.stmt && a.stmt.closeIso === closeIso && isFinite(Number(a.stmt.amount)));
  const statementC = entered ? toCents(a.stmt.amount) : computedC;
  return {
    closeIso, dueIso: toLocalISO(addDays(close, cyc.graceDays)),
    statement: fromCents(statementC), paidSince: fromCents(paidC),
    remaining: fromCents(Math.max(0, statementC - paidC)),
    current: fromCents(currentC), cycle: cyc,
    entered, computed: fromCents(computedC),
    charged: fromCents(chargedC)       // purchases since it closed — they're on the NEXT statement
  };
}

// What to pay on pay-run day: the statement still due, or everything owed.
export function cardPayMode(name){
  const m = state.flags.cardPay && state.flags.cardPay[name];
  if (m === 'statement' || m === 'full') return (m === 'statement' && !cardCycle(name)) ? 'full' : m;
  return cardCycle(name) ? 'statement' : 'full';
}

// Purchases on a card since its last closing day, by category, biggest first.
export function cycleSpending(name, todayIso = today()){
  const cyc = cardCycle(name);
  if (!cyc) return null;
  const closeIso = toLocalISO(lastClose(cyc.closeDay, todayIso));
  const by = {};
  let total = 0, n = 0;
  for (const t of state.transactions){
    if (t.type !== 'Expense' || t.account !== name || !t.date || t.date <= closeIso || t.date > todayIso) continue;
    const k = t.category || '(uncategorized)';
    by[k] = (by[k] || 0) + toCents(t.amount); total += toCents(t.amount); n++;
  }
  return { closeIso, total: fromCents(total), count: n,
           top: Object.entries(by).sort((x, y) => y[1] - x[1]).map(([category, c]) => ({ category, amount: fromCents(c) })) };
}
