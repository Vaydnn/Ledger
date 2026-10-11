/* ============================================================
   remind-core.js — NEW(v3.1): which bills are due, shared by the app and
   the service worker.

   Deliberately NOT an ES module (no import/export): the service worker
   loads it with importScripts() and the app with a side-effect import —
   both get globalThis.LedgerRemind. Pure functions over plain bill records
   (the same shape as state.bills / the IndexedDB 'bills' store).
   ============================================================ */
(function(){
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parse = (s) => new Date(s + 'T00:00:00');
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
  const isPaid = (b, ym) => {
    const pm = b.paidMonths || {};
    if (b.recurrence === 'once') return Object.values(pm).some(Boolean);
    return !!pm[ym];
  };
  // Same rule as bills.js getBillDueDay.
  const dueDay = (b) => {
    if (b.recurrence !== 'auto-cc') return b.dueDay || 1;
    const close = b.closeDay || 1, grace = b.graceDays != null ? b.graceDays : 21;
    return ((close + grace - 1) % 30) + 1;
  };

  // Unpaid, active bills due within `daysAhead` days of todayIso — overdue
  // ones included (negative daysUntil). Sorted soonest first.
  function dueBills(bills, todayIso, opts){
    const ahead = (opts && opts.daysAhead != null) ? opts.daysAhead : 2;
    const t = parse(todayIso);
    const ym = todayIso.slice(0, 7);
    const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    const out = [];
    for (const b of bills || []){
      if (!b || b.active === false) continue;
      let due;
      if (b.recurrence === 'once'){
        if (!b.dueDate || isPaid(b, ym)) continue;
        due = b.dueDate;
      } else {
        if (isPaid(b, ym)) continue;
        due = ym + '-' + pad(Math.min(dueDay(b), last));
      }
      const daysUntil = daysBetween(todayIso, due);
      if (daysUntil > ahead) continue;
      out.push({ id: b.id, name: b.name || 'Bill', amount: b.recurrence === 'auto-cc' ? null : (b.amount || 0),
                 dueIso: due, daysUntil, overdue: daysUntil < 0 });
    }
    return out.sort((a, b) => a.daysUntil - b.daysUntil);
  }

  // Badge = bills overdue or due today.
  function badgeCount(bills, todayIso){
    return dueBills(bills, todayIso, { daysAhead: 0 }).length;
  }

  // One notification summarizing everything due. hideAmounts (privacy
  // mode) leaves only names and dates on the lock screen.
  function summary(list, opts){
    const hide = !!(opts && opts.hideAmounts);
    const when = (d) => d.daysUntil < 0 ? `${-d.daysUntil}d overdue` : d.daysUntil === 0 ? 'today' : d.daysUntil === 1 ? 'tomorrow' : `in ${d.daysUntil}d`;
    const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return {
      title: list.length === 1 ? `${list[0].name} is due ${when(list[0])}` : `${list.length} bills due soon`,
      body: list.map(d => `${d.name}${d.amount != null && !hide ? ' ' + money(d.amount) : ''} · ${when(d)}`).join('\n')
    };
  }

  globalThis.LedgerRemind = { dueBills, badgeCount, summary, iso };
})();
