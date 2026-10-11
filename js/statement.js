/* ============================================================
   statement.js — NEW(v3.1): a card's statement balance vs its current one.

   Current balance  = everything charged so far (what Ledger always showed).
   Statement balance = the balance on the last statement's closing day —
                       paying THAT by the due date is what avoids interest.
   Still due        = statement balance − payments made since it closed.

   The cycle comes from the card itself (Accounts → card → "Statement
   closes on day"), else from an Auto (CC) bill tracking it.
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
  let afterC = 0, paidC = 0;
  for (const t of state.transactions){
    if (!t.date || t.date <= closeIso) continue;
    const eff = txnEffectsCents(t, aType)[name] || 0;
    afterC += eff;
    if (t.type === 'CC Payment' && t.account === name && eff < 0) paidC -= eff;
  }
  const currentC = toCents(balanceLatest(name));
  const statementC = currentC - afterC;
  return {
    closeIso, dueIso: toLocalISO(addDays(close, cyc.graceDays)),
    statement: fromCents(statementC), paidSince: fromCents(paidC),
    remaining: fromCents(Math.max(0, statementC - paidC)),
    current: fromCents(currentC), cycle: cyc
  };
}
