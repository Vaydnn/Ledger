/* ============================================================
   more.js — More tab: menu of entry points to everything that
   isn't a core view. Includes new v1.1.0 menu items for Monthly
   Breakdown, Year View, and Cashflow Forecast.
   ============================================================ */

import { $, $$, APP_VERSION } from './util.js';
import { state } from './db.js';
import { navigate, renderAll } from './app.js';
import { renderNetWorthChart, openNetWorthSheet } from './networth.js';
import { openSubscriptionsSheet } from './subscriptions.js';
import { openBudgetsSheet } from './budgets.js';
import { openBalancesSheet } from './balances.js';
import { openAccountsSheet, openCategoriesSheet, openAboutSheet, exportXLSX, importXLSX, backupJSON, restoreJSON, resetData, recomputeAllBalances } from './manage.js';
import { openBreakdownSheet } from './breakdown.js';
import { openYearViewSheet } from './yearview.js';
import { openForecastSheet } from './forecast.js';
import { openReconcileSheet } from './reconcile.js'; // NEW(v2.0)
import { openGoalsSheet } from './goals.js';         // NEW(v2.0)
import { openTrashSheet } from './trash.js';         // NEW(v2.0)

export function renderMore(){
  const v = $('#view-more');
  v.innerHTML = `
    <button class="menu-item" data-act="debts">
      <span class="l"><span class="ico" style="color:var(--amber);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h3"/></svg></span>Debts &amp; Loans</span>
      <span class="arrow">›</span>
    </button>

    <button class="menu-item" data-act="breakdown">
      <span class="l"><span class="ico" style="color:var(--green);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 3v18h18"/><path d="M7 14l3-3 3 3 5-5"/></svg></span>Monthly Breakdown</span>
      <span class="arrow">›</span>
    </button>

    <button class="menu-item" data-act="yearview">
      <span class="l"><span class="ico" style="color:var(--blue);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg></span>Year View</span>
      <span class="arrow">›</span>
    </button>

    <button class="menu-item" data-act="forecast">
      <span class="l"><span class="ico" style="color:var(--ember);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 17l6-6 4 4 7-8"/><path d="M14 7h6v6"/></svg></span>Cashflow Forecast</span>
      <span class="arrow">›</span>
    </button>

    <button class="menu-item" data-act="subs">
      <span class="l"><span class="ico" style="color:var(--ember-2);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 12a9 9 0 0 1 15.5-6.2M21 4v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2M3 20v-5h5"/></svg></span>Subscriptions</span>
      <span class="arrow">›</span>
    </button>

    <button class="menu-item" data-act="reconcile">
      <span class="l"><span class="ico" style="color:var(--green);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg></span>Reconcile CSV</span>
      <span class="arrow">›</span>
    </button>

    <button class="menu-item" data-act="goals">
      <span class="l"><span class="ico" style="color:var(--blue);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/></svg></span>Savings Goals</span>
      <span class="arrow">›</span>
    </button>

    <div class="card" style="margin:14px 0;">
      <h3 class="card-title">Net Worth</h3>
      ${renderNetWorthChart()}
      <button class="btn secondary" id="add-nw" style="margin-top:14px;">+ Add Snapshot</button>
    </div>

    <button class="menu-item" data-act="budgets">
      <span class="l"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 12l4-7 5 5 5-3 4 9"/><path d="M3 19h18"/></svg></span>Budgets</span>
      <span class="arrow">›</span>
    </button>
    <button class="menu-item" data-act="accounts">
      <span class="l"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/></svg></span>Accounts</span>
      <span class="arrow">›</span>
    </button>
    <button class="menu-item" data-act="categories">
      <span class="l"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/></svg></span>Categories</span>
      <span class="arrow">›</span>
    </button>
    <button class="menu-item" data-act="balances">
      <span class="l"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5"/></svg></span>Starting Balances</span>
      <span class="arrow">›</span>
    </button>
    <button class="menu-item" data-act="recompute">
      <span class="l"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 12a9 9 0 0 1 15.5-6.2M21 4v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2M3 20v-5h5"/><path d="M9 12l2 2 4-4"/></svg></span>Recompute Balances</span>
      <span class="arrow">›</span>
    </button>
    <button class="menu-item" data-act="export">
      <span class="l"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg></span>Export to Excel</span>
      <span class="arrow">›</span>
    </button>
    <button class="menu-item" data-act="import">
      <span class="l"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 21V9M7 14l5-5 5 5M5 3h14"/></svg></span>Import xlsx</span>
      <span class="arrow">›</span>
    </button>
    <button class="menu-item" data-act="backup">
      <span class="l"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 4h16v16H4z"/><path d="M4 9h16M9 4v16"/></svg></span>Backup as JSON</span>
      <span class="arrow">›</span>
    </button>
    <button class="menu-item" data-act="restore">
      <span class="l"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 21V9M7 14l5-5 5 5"/><path d="M4 4h16"/></svg></span>Restore from JSON</span>
      <span class="arrow">›</span>
    </button>
    <button class="menu-item" data-act="trash">
      <span class="l"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/><path d="M10 11v5M14 11v5"/></svg></span>Trash</span>
      <span class="arrow">›</span>
    </button>
    <button class="menu-item" data-act="reset">
      <span class="l"><span class="ico" style="color:var(--red);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 6h18M8 6V4h8v2M5 6l1 14h12l1-14"/></svg></span>Reset All Data</span>
      <span class="arrow">›</span>
    </button>
    <button class="menu-item" data-act="about">
      <span class="l"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 8v.01M11 12h1v5h1"/></svg></span>About</span>
      <span class="arrow">›</span>
    </button>

    <div style="text-align:center;margin-top:24px;color:var(--text-3);font-size:11px;letter-spacing:.1em;text-transform:uppercase;">
      Ledger v${APP_VERSION} · ${state.transactions.length} txns · ${state.accounts.length} accounts · ${state.bills.length} bills
    </div>
  `;
  $('#add-nw', v).addEventListener('click', () => openNetWorthSheet(renderMore));
  $$('.menu-item', v).forEach(b => b.addEventListener('click', () => moreAction(b.dataset.act)));
}

function moreAction(act){
  switch (act){
    case 'debts':       navigate('debts'); break;
    case 'breakdown':   openBreakdownSheet(); break;
    case 'yearview':    openYearViewSheet(); break;
    case 'forecast':    openForecastSheet(); break;
    case 'subs':        openSubscriptionsSheet(); break;
    case 'reconcile':   openReconcileSheet(); break;          // NEW(v2.0)
    case 'goals':       openGoalsSheet(renderAll); break;     // NEW(v2.0)
    case 'trash':       openTrashSheet(renderAll); break;     // NEW(v2.0)
    case 'budgets':     openBudgetsSheet(); break;
    case 'accounts':    openAccountsSheet(); break;
    case 'categories':  openCategoriesSheet(); break;
    case 'balances':    openBalancesSheet(); break;
    case 'recompute':   recomputeAllBalances(); break;
    case 'export':      exportXLSX(); break;
    case 'import':      importXLSX(renderAll); break;
    case 'backup':      backupJSON(); break;
    case 'restore':     restoreJSON(renderAll); break;
    case 'reset':       resetData(); break;
    case 'about':       openAboutSheet(); break;
  }
}
