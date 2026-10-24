/* ============================================================
   cards.js — NEW(v3.2): card statements, the way you actually pay them.

   Each credit card has a billing cycle: it CLOSES on a day, the statement
   balance is what you owe from it, and everything you charge after the
   closing day rides on the NEXT statement. Ledger shows both, apart:

     Statement  $4,000.00   closed Oct 22 · due Nov 16
     Paid since $0.00       → still due $4,000.00
     Charged since it closed $1,017.43  → on the next statement

   The statement balance is computed from your transactions, but you can
   ENTER the number your bank shows — it counts for that one statement (the
   next close goes back to computing). The pay run and the forecast pay the
   statement still due (or the whole balance — a per-card choice), and a card
   can be tracked as an Auto (CC) bill in one tap.

   Home card "Card statements" + a sheet per card (tap a row, or the
   "statement … due …" line on an account).
   ============================================================ */

import { $, $$, fmt, esc, today, toLocalISO, parseLocalDate, monthName, clamp, parseAmount, round2, uid, toast, busyGuard } from './util.js';
import { state, dbPut, saveFlags } from './db.js';
import { openSheet, closeSheet } from './sheet.js';
import { statementInfo, cardCycle, cardPayMode, cycleSpending } from './statement.js';
import { renderCurrent } from './app.js';

const fmtDay = (iso) => { const d = parseLocalDate(iso); return `${monthName(d.getMonth() + 1, true)} ${d.getDate()}`; };
const cards = () => state.accounts.filter(a => a.active && a.type === 'Credit Card');
const autoBillFor = (name) => state.bills.find(b => b.recurrence === 'auto-cc' && b.linkedAccount === name);

// Which checking account usually pays this card (latest CC Payment, else the
// auto bill's, else the first open checking account).
export function payerFor(card){
  const checking = state.accounts.filter(a => a.active && a.type === 'Checking').map(a => a.name);
  const last = state.transactions.find(t => t.type === 'CC Payment' && t.account === card && t.fromAccount && checking.includes(t.fromAccount));
  if (last) return last.fromAccount;
  const b = autoBillFor(card);
  return b && checking.includes(b.fromAccount) ? b.fromAccount : (checking[0] || null);
}

/* ── Home card ─────────────────────────────────────────────────────── */
export function renderCardsCard(){
  const list = cards();
  if (!list.length) return '';
  return `
    <div class="card" style="margin-top:14px;">
      <h3 class="card-title">Card statements <span class="pill">${list.length}</span></h3>
      ${list.map(a => {
        const s = statementInfo(a.name);
        if (!s) return `
          <button type="button" class="cs-row" data-card="${esc(a.name)}">
            <div class="cs-l"><div class="cs-name">${esc(a.name)}</div><div class="muted small">Set when its statement closes →</div></div>
          </button>`;
        const due = fmtDay(s.dueIso);
        return `
          <button type="button" class="cs-row" data-card="${esc(a.name)}">
            <div class="cs-l">
              <div class="cs-name">${esc(a.name)}</div>
              <div class="muted small">Closed ${esc(fmtDay(s.closeIso))}${s.entered ? ' · entered' : ''} · due ${esc(due)}</div>
              <div class="muted small">${s.charged > 0.004 ? `${fmt(s.charged)} charged since → next statement` : 'nothing charged since'}</div>
            </div>
            <div class="cs-r">
              ${s.remaining > 0.004 ? `<span class="mono amber">${fmt(s.remaining)}</span><div class="muted small">statement due</div>`
                                    : `<span class="stmt-paid">paid ✓</span>`}
            </div>
          </button>`;
      }).join('')}
    </div>`;
}
export function wireCardsCard(root){
  $$('.cs-row', root).forEach(b => b.addEventListener('click', () => openCardSheet(b.dataset.card)));
  // The "statement … due …" line on an account row opens it too.
  $$('.acct-row .stmt-due, .acct-row .stmt-paid', root).forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    openCardSheet(el.closest('.acct-row').dataset.acct);
  }));
}

/* ── the card sheet ────────────────────────────────────────────────── */
export function openCardSheet(name){
  const acct = state.accounts.find(a => a.name === name && a.type === 'Credit Card');
  if (!acct) return;
  const cyc = cardCycle(name);
  const s = cyc ? statementInfo(name) : null;
  const spend = cyc ? cycleSpending(name) : null;
  const mode = cardPayMode(name);
  const bill = autoBillFor(name);
  const row = (l, r, cls = '') => `<div class="rb-row ${cls}"><span>${l}</span><span class="mono">${r}</span></div>`;

  $('#sheetBody').innerHTML = `
    <h2>${esc(name)}</h2>
    ${s ? `
      <div class="real-breakdown" style="margin-bottom:6px;">
        ${row(`Statement · closed ${esc(fmtDay(s.closeIso))}`, `<b>${fmt(s.statement)}</b>`)}
        ${row('− Paid since it closed', fmt(s.paidSince))}
        ${row(`= Still due by ${esc(fmtDay(s.dueIso))}`, `<span class="${s.remaining > 0.004 ? 'amber' : 'pos'}">${fmt(s.remaining)}</span>`, 'total')}
        ${row('Charged since it closed → next statement', fmt(s.charged))}
        ${row('Current balance', fmt(s.current))}
      </div>
      <div class="field" style="margin-top:14px;">
        <label for="cs-amt">Statement balance — what your bank shows for the ${esc(fmtDay(s.closeIso))} statement</label>
        <input class="input" id="cs-amt" type="text" inputmode="decimal" value="${s.statement.toFixed(2)}" />
      </div>
      <div class="muted small" style="margin:-4px 0 10px;line-height:1.5;">
        ${s.entered ? `You entered this. Ledger calculates ${fmt(s.computed)} from your transactions.` : `Ledger calculates this from your transactions.`}
        It counts for this statement only; spending after ${esc(fmtDay(s.closeIso))} goes on the next one.
      </div>
      <button type="button" class="btn" id="cs-save">Save statement balance</button>
      ${s.entered ? '<button type="button" class="btn ghost" id="cs-clear" style="margin-top:8px;">Use Ledger\'s number</button>' : ''}
    ` : `
      <div class="muted small" style="line-height:1.55;margin-bottom:12px;">Tell Ledger when this card's statement closes and it can show the statement balance — what you owe — apart from what you charge after it.</div>
    `}

    <div class="nm-sec">
      <div class="nm-sec-h">Billing cycle</div>
      <div class="row-2">
        <div class="field"><label for="cs-close">Statement closes (day)</label><input class="input" id="cs-close" type="number" min="1" max="31" inputmode="numeric" value="${cyc ? esc(cyc.closeDay) : ''}" placeholder="e.g. 22" /></div>
        <div class="field"><label for="cs-grace">Payment due (days after)</label><input class="input" id="cs-grace" type="number" min="0" max="60" inputmode="numeric" value="${cyc ? esc(cyc.graceDays) : ''}" placeholder="25" /></div>
      </div>
      <button type="button" class="btn secondary" id="cs-cycle">${cyc ? 'Save cycle' : 'Set cycle'}</button>
    </div>

    ${cyc ? `
    <div class="nm-sec">
      <div class="nm-sec-h">On pay-run day, pay</div>
      <div class="seg" id="cs-mode" role="tablist">
        <button type="button" class="seg-btn ${mode === 'statement' ? 'active' : ''}" data-v="statement">Statement balance</button>
        <button type="button" class="seg-btn ${mode === 'full' ? 'active' : ''}" data-v="full">Everything owed</button>
      </div>
      <div class="muted small" style="margin:8px 0 0;line-height:1.5;">Used by the Pay run and the Next month preview (for cards you count in Real available's ⚙).</div>
    </div>

    <div class="nm-sec">
      <div class="nm-sec-h">Bill</div>
      ${bill
        ? `<div class="muted small" style="line-height:1.5;">Tracked by the Auto (CC) bill “${esc(bill.name)}” — ${bill.ccAmount === 'statement' ? 'it amounts to the statement still due' : 'it amounts to the current balance'}.</div>`
        : `<div class="muted small" style="line-height:1.5;margin-bottom:8px;">Track this card as an Auto (CC) bill: it shows in Bills with the statement still due and the due date, and you can pay it from there.</div>
           <button type="button" class="btn secondary" id="cs-bill">Track as an Auto (CC) bill</button>`}
    </div>

    <div class="nm-sec">
      <div class="nm-sec-h">Spending since ${esc(fmtDay(s.closeIso))} · ${fmt(spend.total)}</div>
      ${spend.top.length ? spend.top.slice(0, 6).map(c => row(esc(c.category), fmt(c.amount), 'nm-minor')).join('') : '<div class="nm-note" style="margin-top:0;">No purchases yet.</div>'}
    </div>` : ''}
    <button type="button" class="btn ghost" id="cs-close-sheet" style="margin-top:16px;">Close</button>
  `;
  openSheet();

  const refresh = () => { renderCurrent(); openCardSheet(name); };
  $('#cs-close-sheet').addEventListener('click', closeSheet);

  $('#cs-save')?.addEventListener('click', busyGuard(async () => {
    const v = parseAmount($('#cs-amt').value);
    if (isNaN(v) || v < 0){ toast('Enter the statement balance'); return; }
    acct.stmt = { closeIso: s.closeIso, amount: round2(v) };
    await dbPut('accounts', acct);
    toast(`${name} statement: ${fmt(round2(v))}`);
    refresh();
  }));
  $('#cs-clear')?.addEventListener('click', busyGuard(async () => {
    delete acct.stmt;
    await dbPut('accounts', acct);
    toast('Using Ledger\'s number');
    refresh();
  }));

  $('#cs-cycle').addEventListener('click', busyGuard(async () => {
    const cd = parseInt($('#cs-close').value, 10);
    const gd = parseInt($('#cs-grace').value, 10);
    if (!(cd >= 1 && cd <= 31)){ toast('Enter the day of the month it closes (1–31)'); return; }
    acct.closeDay = cd;
    acct.graceDays = gd >= 0 && gd <= 60 ? gd : 25;
    await dbPut('accounts', acct);
    // Keep an Auto (CC) bill on the same cycle.
    const b = autoBillFor(name);
    if (b){
      b.closeDay = acct.closeDay; b.graceDays = acct.graceDays;
      b.dueDay = ((b.closeDay + b.graceDays - 1) % 30) + 1;
      await dbPut('bills', b);
    }
    toast('Cycle saved');
    refresh();
  }));

  $$('#cs-mode .seg-btn').forEach(btn => btn.addEventListener('click', async () => {
    state.flags.cardPay = { ...(state.flags.cardPay || {}), [name]: btn.dataset.v };
    await saveFlags();
    refresh();
  }));

  $('#cs-bill')?.addEventListener('click', busyGuard(async () => {
    const from = payerFor(name);
    if (!from){ toast('Add a checking account first'); return; }
    const c = cardCycle(name);
    const nb = {
      id: uid(), name: name.replace(/\s*(CC|card)$/i, '').trim() || name, recurrence: 'auto-cc', active: true, paidMonths: {}, notes: '',
      amount: 0, dueDate: '', type: 'CC Payment', account: name, fromAccount: from, category: 'CC Payment',
      linkedAccount: name, closeDay: c.closeDay, graceDays: c.graceDays, ccAmount: 'statement',
      dueDay: ((c.closeDay + c.graceDays - 1) % 30) + 1
    };
    await dbPut('bills', nb);
    state.bills.push(nb);
    state.bills.sort((a, b) => (a.dueDay || 0) - (b.dueDay || 0));
    toast(`Added bill “${nb.name}” — pays from ${from}`);
    refresh();
  }));
}
