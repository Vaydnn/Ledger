/* ============================================================
   home.js — main dashboard view.
   Sections: migration banner (legacy refunds), hero KPI with
   income/expense/invest/refund tiles, Real Available card,
   upcoming bills preview, debt summary, account list, budgets,
   insights (new in v1.1.0).
   ============================================================ */

import { $, $$, fmt, fmtShort, monthKey, monthName, clamp, toast, monthAbbr, alphaSort, sumMoney, toCents, fromCents, esc } from './util.js';
import { state, dbPut, saveFlags } from './db.js';
import { balanceAt, monthTotals } from './effects.js';
import { openSheet, closeSheet, openPicker } from './sheet.js';
import { navigate } from './app.js';
import { txnHTML, openTxnSheet, filterActivityByAccount } from './txns.js';
import { billRowHTML, payBill, openBillSheet, getBillDueDay, computeRealAvailable, wireBillRows } from './bills.js';
import { renderInsightsCard } from './insights.js';
import { resetAddForm } from './add.js';           // NEW(v2.4)
import { renderPaceCard } from './pace.js';         // NEW(v2.6)
import { openBudgetsSheet, budgetSpentMap } from './budgets.js'; // NEW(v2.7.1)
import { renderGoalsCard } from './goals.js'; // NEW(v2.0)
import { preferredAccountFor } from './merchants.js'; // NEW(v3.0)
import { renderSafeCard, wireSafeCard } from './payday.js'; // NEW(v3.1)

/* NEW(v3.0): how an account's balance reads on Home. The old row stripped
   every minus sign — an overdrawn checking account (−$50) showed as $50, and
   a card carrying a CREDIT showed as money owed. Now:
     cash:  $1,234.00   /  −$50.00 (red, overdrawn)
     debt:  −$612.40 owed (amber)  /  +$20.00 credit (green)  /  $0.00 (paid off) */
export function acctBalanceHTML(a, bal){
  const isDebt = a.type === 'Credit Card' || a.type === 'Loan';
  if (isDebt){
    if (bal < -0.004) return `<span class="pos">+${fmt(-bal)} credit</span>`;
    if (bal < 0.005) return fmt(0);   // FIX(v3.1): was "−$0.00"
    return `−${fmt(bal).replace('−','')}`;
  }
  return bal < -0.004 ? `<span class="neg">${fmt(bal)}</span>` : fmt(bal);
}

/* ── NEW(v3.1): customizable Home ─────────────────────────────────────
   Below the hero, every card can be reordered, hidden, or collapsed to its
   title (tap ⌄). The cover screen is tall and narrow — collapsing the cards
   you only glance at keeps what matters above the fold. Stored in
   flags.homeLayout = { order, hidden, collapsed }. */
export const HOME_CARDS = [
  ['quicklog', 'Quick log'], ['pace', 'Month-End Pace'], ['safe', 'Safe to spend'], ['real', 'Real available'],
  ['insights', 'Insights'], ['recent', 'Recent'], ['bills', 'Upcoming Bills'],
  ['debt', 'Debt Total'], ['accounts', 'Accounts'], ['budgets', 'Budgets'], ['goals', 'Savings Goals']
];
const DEFAULT_ORDER = HOME_CARDS.map(([k]) => k);

export function homeLayout(){
  const saved = state.flags.homeLayout || {};
  const order = (saved.order || []).filter(k => DEFAULT_ORDER.includes(k));
  // Cards added in later versions slot in at their default position.
  DEFAULT_ORDER.forEach((k, i) => { if (!order.includes(k)) order.splice(Math.min(i, order.length), 0, k); });
  return { order, hidden: saved.hidden || [], collapsed: saved.collapsed || [] };
}
async function saveHomeLayout(layout){
  state.flags.homeLayout = { order: layout.order, hidden: layout.hidden, collapsed: layout.collapsed };
  await saveFlags();
}

function addCardFolds(v, layout){
  $$('.home-card', v).forEach(sec => {
    const key = sec.dataset.card;
    const head = sec.querySelector('.card-title, .real-head');
    if (!head) return;          // e.g. the quick-log buttons
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card-fold';
    btn.setAttribute('aria-label', 'Collapse or expand');
    btn.setAttribute('aria-expanded', String(!layout.collapsed.includes(key)));
    btn.textContent = '⌄';
    head.appendChild(btn);
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const now = homeLayout();
      const collapsed = !now.collapsed.includes(key);
      now.collapsed = collapsed ? [...now.collapsed, key] : now.collapsed.filter(k => k !== key);
      sec.classList.toggle('collapsed', collapsed);
      btn.setAttribute('aria-expanded', String(!collapsed));
      await saveHomeLayout(now);
    });
  });
}

export function openHomeCustomizeSheet(){
  const layout = homeLayout();
  const label = Object.fromEntries(HOME_CARDS);
  $('#sheetBody').innerHTML = `
    <h2>Customize Home</h2>
    <div class="muted small" style="margin-bottom:12px;line-height:1.5;">Order and show/hide the cards below the monthly summary. Tap ⌄ on any card on Home to collapse it.</div>
    ${layout.order.map((k, i) => `
      <div class="rec-row hc-row" data-k="${k}">
        <div style="min-width:0;flex:1;font-size:14px;${layout.hidden.includes(k) ? 'opacity:.45;' : ''}">${esc(label[k])}</div>
        <button type="button" class="btn ghost hc-up" data-k="${k}" ${i === 0 ? 'disabled' : ''} style="width:auto;padding:6px 10px;" aria-label="Move up">↑</button>
        <button type="button" class="btn ghost hc-down" data-k="${k}" ${i === layout.order.length - 1 ? 'disabled' : ''} style="width:auto;padding:6px 10px;" aria-label="Move down">↓</button>
        <button type="button" class="btn ${layout.hidden.includes(k) ? 'secondary' : 'ghost'} hc-vis" data-k="${k}" style="width:auto;padding:6px 10px;font-size:12px;min-width:64px;">${layout.hidden.includes(k) ? 'Hidden' : 'Shown'}</button>
      </div>`).join('')}
    <button class="btn ghost" id="hc-reset" style="margin-top:12px;">Reset to default</button>
  `;
  openSheet();
  const move = async (k, d) => {
    const l = homeLayout(); const i = l.order.indexOf(k); const j = i + d;
    if (j < 0 || j >= l.order.length) return;
    [l.order[i], l.order[j]] = [l.order[j], l.order[i]];
    await saveHomeLayout(l); renderHome(); openHomeCustomizeSheet();
  };
  $$('.hc-up').forEach(b => b.addEventListener('click', () => move(b.dataset.k, -1)));
  $$('.hc-down').forEach(b => b.addEventListener('click', () => move(b.dataset.k, 1)));
  $$('.hc-vis').forEach(b => b.addEventListener('click', async () => {
    const l = homeLayout(); const k = b.dataset.k;
    l.hidden = l.hidden.includes(k) ? l.hidden.filter(x => x !== k) : [...l.hidden, k];
    await saveHomeLayout(l); renderHome(); openHomeCustomizeSheet();
  }));
  $('#hc-reset').addEventListener('click', async () => {
    await saveHomeLayout({ order: [...DEFAULT_ORDER], hidden: [], collapsed: [] });
    renderHome(); openHomeCustomizeSheet();
  });
}

// Month swipe (v2.9.2) moved to app.js in v3.1 — shared by Home, Bills and
// Activity (wireMonthSwipes).

export function renderHome(){
  const { year, month } = state.selected;
  const tot = monthTotals(year, month);
  const ym = `${year}-${String(month).padStart(2,'0')}`;

  // Debt totals for the summary card (cash comes from computeRealAvailable).
  // FIX(v1.2): account sums now accumulate in cents (no float drift).
  let ccDebt = 0, loanDebt = 0; // cents
  state.accounts.filter(a => a.active).forEach(a => {
    const b = toCents(balanceAt(a.name, year, month));
    if (a.type === 'Credit Card') ccDebt += b;
    else if (a.type === 'Loan') loanDebt += b;
  });
  ccDebt = fromCents(ccDebt); loanDebt = fromCents(loanDebt);

  // FIX(v2.9.1): "Real available" now comes from ONE function shared with
  // the Bills view (computeRealAvailable in bills.js) — the two screens
  // used to compute it independently and disagree.
  const { cash, upcomingTotal, cardLines, unpaidBills, realAvailable } = computeRealAvailable(year, month);

  const todayDay = new Date().getDate();
  const isCurrentMonth = (year === new Date().getFullYear() && month === new Date().getMonth() + 1);
  const sortedUpcoming = [...unpaidBills].sort((a, b) => getBillDueDay(a) - getBillDueDay(b));
  const upcomingPreview = sortedUpcoming.slice(0, 4);

  // Legacy refund candidates.
  // FIX(v1.2): the heuristic flagged ANY Income on a debt account, which
  // caught deliberate "Cash Back" income logged on RH CC — so the banner
  // re-appeared forever and "Reclassify" would have rewritten intentional
  // Income into Refund. Only explicitly refund-named categories are flagged
  // now; cash-back income is the user's call.
  const legacyRefunds = state.transactions.filter(t => {
    if (t.type !== 'Income') return false;
    const cat = (t.category || '').toLowerCase();
    return cat === 'refunds' || cat === 'refund';
  });
  // FIX(v1.2): dismissal flag moved from localStorage to the meta store
  // (IndexedDB-only persistence rule); see db.js loadState for the port.
  const dismissedMigration = !!state.flags.migrationDismissed;

  const v = $('#view-home');
  // NEW(v3.1): every card below the hero is built separately so Home can be
  // reordered, trimmed and collapsed (homeLayout / Customize Home).
  const cards = {
    quicklog: renderQuickLog(),
    pace: renderPaceCard(),
    safe: isCurrentMonth ? renderSafeCard() : '',   // NEW(v3.1): a right-now number
    real: `
    <div class="real-card">
      <div class="real-head">
        <div>
          <div class="l">Real available</div>
          <div class="v ${realAvailable >= 0 ? 'pos' : 'neg'}">${fmt(realAvailable)}</div>
          <div class="sub">After ${unpaidBills.length} unpaid bill${unpaidBills.length===1?'':'s'}${cardLines.length ? ' · ' + cardLines.map(c => esc(c.name)).join(', ') : ''}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button class="btn ghost" id="ra-config" style="width:auto;padding:8px 11px;font-size:13px;" aria-label="Configure">⚙</button>
          <button class="btn ghost" id="go-bills" style="width:auto;padding:8px 14px;font-size:12px;">Bills →</button>
        </div>
      </div>
      <div class="real-breakdown">
        <div class="rb-row"><span>Cash on hand</span><span class="mono">${fmt(cash)}</span></div>
        <div class="rb-row"><span>− Bills due</span><span class="mono amber">${fmt(upcomingTotal)}</span></div>
        ${cardLines.map(c => `<div class="rb-row"><span>− ${esc(c.name)}</span><span class="mono amber">${fmt(c.bal)}</span></div>`).join('')}
        <div class="rb-row total"><span>= Available</span><span class="mono ${realAvailable>=0?'pos':'neg'}">${fmt(realAvailable)}</span></div>
      </div>
    </div>`,
    insights: renderInsightsCard(year, month),
    recent: state.transactions.length ? `
      <div class="card" style="margin-top:14px;">
        <h3 class="card-title">Recent</h3>
        ${state.transactions.slice(0, 5).map(t => txnHTML(t)).join('')}
      </div>` : '',
    bills: upcomingPreview.length ? `
      <div class="card" style="margin-top:14px;">
        <h3 class="card-title">Upcoming Bills <span class="pill">${unpaidBills.length} unpaid</span></h3>
        ${upcomingPreview.map(b => billRowHTML(b, ym, isCurrentMonth, todayDay)).join('')}
        ${unpaidBills.length > 4 ? `<button class="btn ghost" id="see-all-bills" style="margin-top:10px;">See all ${unpaidBills.length} bills</button>` : ''}
      </div>` : '',
    debt: `
    <div class="card" style="margin-top:14px;">
      <h3 class="card-title">Debt Total <span class="pill">${state.accounts.filter(a => a.active && (a.type==='Credit Card' || a.type==='Loan')).length}</span></h3>
      <div class="debt-summary">
        <div class="ds-row"><span>Credit Cards</span><span class="mono amber">${fmt(ccDebt)}</span></div>
        ${loanDebt > 0 ? `<div class="ds-row"><span>Loans</span><span class="mono amber">${fmt(loanDebt)}</span></div>` : ''}
        <div class="ds-row total"><span>Total owed</span><span class="mono amber">${fmt(ccDebt + loanDebt)}</span></div>
      </div>
    </div>`,
    accounts: `
    <div class="card" style="margin-top:14px;">
      <h3 class="card-title">Accounts <span class="pill">${state.accounts.filter(a=>a.active).length}</span></h3>
      ${state.accounts.filter(a => a.active).map(a => {
        const b = balanceAt(a.name, year, month);
        const isDebt = a.type === 'Credit Card' || a.type === 'Loan';
        const cls = a.type === 'Credit Card' ? 'cc' : (a.type === 'Loan' ? 'loan' : 'checking');
        return `
          <div class="acct-row" data-acct="${esc(a.name)}" style="cursor:pointer;">
            <div class="left">
              <div class="acct-bullet ${cls}"></div>
              <div style="min-width:0;">
                <div class="acct-name">${esc(a.name)}</div>
                <div class="acct-meta">${esc(a.type)}</div>
              </div>
            </div>
            <div class="acct-bal ${isDebt ? 'cc' : ''}">${acctBalanceHTML(a, b)}</div>
          </div>
        `;
      }).join('')}
    </div>`,
    budgets: renderBudgetsCard(year, month),
    goals: renderGoalsCard()
  };
  const layout = homeLayout();

  v.innerHTML = `
    ${legacyRefunds.length > 0 && !dismissedMigration ? `
      <div class="migrate-banner">
        <div class="migrate-head">
          <span class="migrate-dot">↺</span>
          <div style="flex:1;">
            <div class="migrate-title">New: dedicated Refund type</div>
            <div class="migrate-sub">Found ${legacyRefunds.length} old refund${legacyRefunds.length===1?'':'s'} logged as Income. Reclassify them?</div>
          </div>
        </div>
        <div class="migrate-actions">
          <button class="btn ghost" id="migrate-skip" style="width:auto;padding:8px 14px;font-size:12px;">Not now</button>
          <button class="btn" id="migrate-go" style="width:auto;padding:8px 14px;font-size:12px;">Reclassify</button>
        </div>
      </div>
    ` : ''}

    <div class="hero tt-top">
      <div class="label">Net this month</div>
      <div class="net ${tot.net >= 0 ? 'pos' : 'neg'}">
        <span class="sign">${tot.net >= 0 ? '+' : '−'}</span>${fmt(Math.abs(tot.net))}
      </div>
      <div class="sub">${monthName(month)} ${year} · ${state.transactions.filter(t => monthKey(t.date) === ym).length} transactions</div>
      <div class="hero-grid ${tot.rfnd > 0 ? 'has-refunds' : ''}">
        <div class="hero-stat income"><div class="v">${fmtShort(tot.inc)}</div><div class="l">Income</div></div>
        <div class="hero-stat expense"><div class="v">${fmtShort(tot.exp)}</div><div class="l">Expenses</div></div>
        <div class="hero-stat invest"><div class="v">${fmtShort(tot.inv)}</div><div class="l">Invested</div></div>
        ${tot.rfnd > 0 ? `<div class="hero-stat refund"><div class="v">${fmtShort(tot.rfnd)}</div><div class="l">Refunded</div></div>` : ''}
      </div>
    </div>

    ${layout.order.filter(k => !layout.hidden.includes(k) && cards[k]).map(k =>
      `<section class="home-card${layout.collapsed.includes(k) ? ' collapsed' : ''}" data-card="${k}">${cards[k]}</section>`).join('')}

    <button type="button" class="link-btn home-customize" id="home-customize">Customize Home</button>
  `;
  addCardFolds(v, layout);
  $('#home-customize', v).addEventListener('click', openHomeCustomizeSheet);

  // NEW(v2.4.1): quick-log, redesigned per feedback — three type buttons
  // (Expense / Income / Refund). Tapping one opens a picker of your
  // most-used categories for that type; picking a category lands on the
  // Add form pre-filled (type, category, your usual account for that
  // combo, today's date) with the cursor in the amount field.
  $$('.qa-btn', v).forEach(b => b.addEventListener('click', () => {
    const type = b.dataset.type;
    const cats = topCategories(type);
    if (!cats.length){ navigate('add'); return; } // nothing logged yet — plain Add
    openPicker(`${type} — pick a category`, cats, null, (category) => {
      resetAddForm({ type, category, account: usualAccount(type, category) });
      closeSheet();
      navigate('add');
      requestAnimationFrame(() => { const a = $('#f-amount'); if (a){ a.focus(); } });
    });
  }));

  // NEW(v2.9.2): recent transactions — tap to view/edit without leaving Home.
  $$('.txn', v).forEach(el => el.addEventListener('click', () => openTxnSheet(el.dataset.id)));

  // NEW(v2.9.2): tap an account row → Activity filtered to that account.
  // FIX(v3.0): an exact account filter, not a text search — searching
  // "Card" also matched "Gift Card" descriptions and any name containing it.
  $$('.acct-row[data-acct]', v).forEach(el => el.addEventListener('click', () => {
    filterActivityByAccount(el.dataset.acct);
    navigate('txns');
  }));

  // NEW(v2.9.2): dismiss a duplicate-suspect insight (false positives used
  // to pin the top insight slot for the whole month with no way out).
  $$('.ins-dismiss', v).forEach(b => b.addEventListener('click', async () => {
    const list = state.flags.dismissedDups || [];
    if (!list.includes(b.dataset.key)) list.push(b.dataset.key);
    state.flags.dismissedDups = list.slice(-50);
    await saveFlags();
    renderHome();
  }));

  $('#go-bills', v)?.addEventListener('click', () => navigate('bills'));
  $('#ra-config', v)?.addEventListener('click', openRealAvailSheet); // NEW(v2.7)
  wireSafeCard(v, renderHome);                                         // NEW(v3.1)
  $$('[data-go-budgets]', v).forEach(r => r.addEventListener('click', openBudgetsSheet)); // NEW(v2.7.1)
  $('#see-all-bills', v)?.addEventListener('click', () => navigate('bills'));
  // FIX(v3.0): the check circle pays the bill, same as on the Bills tab (this
  // wired a `.bill-pay-btn` class that no row has ever had, so a tap fell
  // through to the row and opened the editor instead).
  $$('.bill-check', v).forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    payBill(b.dataset.id);
  }));
  wireBillRows(v); // NEW(v3.0): "Looks paid · Link"
  $$('.bill-row[data-bill-id]', v).forEach(el => el.addEventListener('click', () => openBillSheet(el.dataset.billId)));

  $('#migrate-skip', v)?.addEventListener('click', async () => {
    state.flags.migrationDismissed = true;
    await saveFlags();
    renderHome();
  });
  $('#migrate-go', v)?.addEventListener('click', () => openMigrationSheet(legacyRefunds));
}

async function openMigrationSheet(candidates){
  const preview = candidates.slice(0, 12);
  const more = candidates.length - preview.length;
  const total = sumMoney(candidates, t => t.amount);
  $('#sheetBody').innerHTML = `
    <h2>Reclassify as Refunds</h2>
    <div class="muted small" style="margin-bottom:14px;">
      These transactions are typed <b>Income</b> but look like refunds.
      Converting them to the new <b>Refund</b> type keeps your Income KPI clean without changing any balances.
    </div>
    <div class="card" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;">
        <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.14em;">${candidates.length} transaction${candidates.length===1?'':'s'}</div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:14px;color:var(--green);">${fmt(total)}</div>
      </div>
      <div style="max-height:280px;overflow-y:auto;">
        ${preview.map(t => `
          <div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);font-size:12.5px;">
            <div style="min-width:0;flex:1;">
              <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(t.category||'Refund')}${t.description ? ' · '+esc(t.description) : ''}</div>
              <div class="muted" style="font-size:11px;margin-top:2px;">${esc(t.date)} · ${esc(t.account)}</div>
            </div>
            <div class="mono" style="color:var(--green);flex-shrink:0;">+$${t.amount.toFixed(2)}</div>
          </div>
        `).join('')}
        ${more > 0 ? `<div class="muted small" style="padding:8px 0 0;">…and ${more} more</div>` : ''}
      </div>
    </div>
    <button class="btn" id="mig-confirm">Reclassify ${candidates.length} → Refund</button>
    <button class="btn ghost" id="mig-cancel" style="margin-top:10px;">Cancel</button>
  `;
  openSheet();
  $('#mig-cancel').addEventListener('click', closeSheet);
  $('#mig-confirm').addEventListener('click', async () => {
    // Ensure "Refunds" (plural) exists in Refund categories so existing category names display naturally
    if (!state.categories.Refund.includes('Refunds')){
      state.categories.Refund = [...state.categories.Refund, 'Refunds'].sort(alphaSort);
      await dbPut('categories', { id:'Refund', list: state.categories.Refund });
    }
    for (const t of candidates){
      t.type = 'Refund';
      await dbPut('transactions', t);
    }
    // No cascadeForChange() call here: Income and Refund have identical
    // effects in txnEffects() on both cash and debt accounts (+amt for
    // cash, -amt for debt), so this migration doesn't change any balance.
    state.flags.migrationDismissed = true;
    await saveFlags();
    closeSheet();
    renderHome();
    toast(`Reclassified ${candidates.length} → Refund`);
  });
}

function renderBudgetsCard(year, month){
  const mAbbr = monthAbbr[month-1];
  const budgets = state.budgets.filter(b => b.year === year);
  if (!budgets.length) return '';

  // FIX(v3.0): shared definition — refunds net back into their category.
  const spent = budgetSpentMap(year, month);

  const rows = budgets
    .map(b => ({ b, target: b.amounts[mAbbr] || 0, used: spent[`${b.type}|${b.category}`] || 0 }))
    .filter(r => r.target > 0 || r.used > 0)
    .sort((a, b) => (b.used / Math.max(b.target,1)) - (a.used / Math.max(a.target,1)));

  if (!rows.length) return '';

  return `
    <div class="card" style="margin-top:14px;">
      <h3 class="card-title">Budgets <span class="pill">${rows.length}</span></h3>
      ${rows.map(r => {
        // FIX(v2.7.1): spending against a $0 target used to render as a
        // ratio against nothing ("$540 / $0", empty bar) — which read as
        // "the transaction isn't being counted." It IS counted; the budget
        // amount just isn't set for this month. Say exactly that, and make
        // the row tappable straight into the Budgets sheet.
        if (!(r.target > 0)){
          return `
            <div class="bdg-row bdg-unset" data-go-budgets="1" style="cursor:pointer;">
              <div class="bdg-head">
                <div class="bdg-name">${esc(r.b.category)}</div>
                <div class="bdg-nums"><b>${fmtShort(r.used)}</b> spent · <span class="muted">no ${monthName(month, true)} budget set →</span></div>
              </div>
              <div class="bar"><i style="width:0%"></i></div>
            </div>
          `;
        }
        const pct = clamp(r.used / r.target, 0, 1.5);
        const cls = pct >= 1 ? 'over' : pct >= 0.8 ? 'warn' : '';
        const remaining = r.target - r.used;
        return `
          <div class="bdg-row">
            <div class="bdg-head">
              <div class="bdg-name">${esc(r.b.category)}</div>
              <div class="bdg-nums"><b>${fmtShort(r.used)}</b> / ${fmtShort(r.target)} · ${remaining >= 0 ? fmtShort(remaining)+' left' : fmtShort(-remaining)+' over'}</div>
            </div>
            <div class="bar ${cls}"><i style="width:${Math.min(pct,1)*100}%"></i></div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

/* ── NEW(v2.7): Real available configuration sheet ─────────────────
   Pick which debt accounts count against your cash. Month-to-month
   cards (paid in full) belong here; long-horizon balances (0% promo
   payoff plans) don't — that's the whole point of the setting. */
function openRealAvailSheet(){
  const debts = state.accounts.filter(a => a.active && (a.type === 'Credit Card' || a.type === 'Loan'));
  const selected = new Set(state.flags.realAvailCards || []);
  const { year, month } = state.selected;

  $('#sheetBody').innerHTML = `
    <h2>Real Available</h2>
    <div class="muted small" style="margin-bottom:14px;line-height:1.55;">
      Real available = cash − bills due − the balances checked below. Check your month-to-month cards; leave long-term payoff balances (0% promos) unchecked. An auto-CC bill tracking a checked card is excluded from the bills side automatically — no double counting.
    </div>
    ${debts.length === 0 ? `<div class="muted small">No credit cards or loans yet.</div>` : debts.map(a => {
      const on = selected.has(a.name);
      return `
        <button class="rec-row ra-row" data-name="${esc(a.name)}" style="width:100%;font:inherit;color:inherit;cursor:pointer;text-align:left;">
          <div style="min-width:0;flex:1;">
            <div style="font-size:13.5px;font-weight:500;">${esc(a.name)}</div>
            <div class="muted small">${esc(a.type)} · balance ${fmt(balanceAt(a.name, year, month))}</div>
          </div>
          <span class="bill-check ${on ? 'checked' : ''}" style="flex-shrink:0;">
            ${on ? '<svg viewBox="0 0 14 14" width="14" height="14"><path d="M2 7l3.5 3.5L12 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
          </span>
        </button>
      `;
    }).join('')}
    <button class="btn" id="ra-done" style="margin-top:12px;">Done</button>
  `;
  openSheet();

  $$('.ra-row').forEach(r => r.addEventListener('click', async () => {
    const name = r.dataset.name;
    const list = new Set(state.flags.realAvailCards || []);
    list.has(name) ? list.delete(name) : list.add(name);
    state.flags.realAvailCards = [...list];
    await saveFlags();
    renderHome();           // live update behind the sheet
    openRealAvailSheet();   // re-render the sheet in place
  }));
  $('#ra-done').addEventListener('click', closeSheet);
}

/* ── NEW(v2.4.1): quick-log — type buttons + usage-ranked categories ── */
function renderQuickLog(){
  return `
    <div class="qa-row">
      <button class="qa-btn" data-type="Expense"><span class="qa-ico expense">−</span>Expense</button>
      <button class="qa-btn" data-type="Income"><span class="qa-ico income">+</span>Income</button>
      <button class="qa-btn" data-type="Refund"><span class="qa-ico refund">↺</span>Refund</button>
    </div>
  `;
}

// Most-used categories for a type, last 12 months weighted by frequency.
// Falls back to the full configured list so a rarely-used type still works.
function topCategories(type, limit = 8){
  const cutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const counts = {};
  for (const t of state.transactions){
    if (t.type !== type || !t.category) continue;
    if ((t.date || '') < cutoff) continue;
    counts[t.category] = (counts[t.category] || 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  if (ranked.length >= limit) return ranked.slice(0, limit);
  // pad with configured-but-unused categories (alphabetical) so the picker
  // is never artificially short
  const keyMap = { 'Expense':'Expense', 'Income':'Income', 'Refund':'Refund' };
  const configured = (state.categories[keyMap[type]] || []).filter(c => !ranked.includes(c));
  return ranked.concat(configured).slice(0, Math.max(limit, ranked.length));
}

// Your usual account for this type+category pairing. NEW(v3.0): an explicit
// category rule (e.g. Restaurants → Citi) or a clear recent habit wins; then
// the all-time usual account for the pairing, then for the type, then null
// (Add form defaults apply).
function usualAccount(type, category){
  const valid = state.accounts.filter(a => a.active).map(a => a.name);
  const pref = preferredAccountFor(type, category, valid);
  if (pref) return pref.account;
  const count = (filter) => {
    const m = {};
    for (const t of state.transactions){
      if (t.type !== type || !t.account) continue;
      if (filter && t.category !== category) continue;
      m[t.account] = (m[t.account] || 0) + 1;
    }
    let best = null, max = 0;
    for (const [k, v] of Object.entries(m)) if (v > max){ max = v; best = k; }
    return best;
  };
  return count(true) || count(false) || null;
}
