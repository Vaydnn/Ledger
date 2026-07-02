/* ============================================================
   app.js — entry point. Owns navigation, month picker, init.

   All view/sheet modules import `navigate` / `renderCurrent` from
   here. This creates a partial circular import, but it's safe
   because those references are only used inside event handlers
   (not at module top-level), so by the time they're called,
   both modules are fully loaded.
   ============================================================ */

import { $, $$, monthAbbr, monthName, toast, toastAction, initRipples, haptic } from './util.js';
import { state, loadState, saveSelected, seedFromJSON, TAB_ID, purgeTombstones, scrubLegacyData } from './db.js';
import { restoreJSON } from './manage.js';
import { initSheet, openSheet, closeSheet, isSheetOpen } from './sheet.js';
import { renderHome } from './home.js';
import { renderBills } from './bills.js';
import { renderAdd } from './add.js';
import { renderTxns } from './txns.js';
import { renderDebts } from './debts.js';
import { renderMore } from './more.js';
import { maybeAutoSnapshot } from './networth.js'; // NEW(v2.0)
import { purgeTrash } from './trash.js';           // NEW(v2.0)

/* ─── Navigation ─────────────────────────── */
export function renderCurrent(){
  if (state.view === 'home')       renderHome();
  else if (state.view === 'bills') renderBills();
  else if (state.view === 'add')   renderAdd();
  else if (state.view === 'txns')  renderTxns();
  else if (state.view === 'debts') renderDebts();
  else if (state.view === 'more')  renderMore();
}

export function renderAll(){
  renderMonthPicker();
  renderCurrent();
}

// NEW(v2.2): per-tab scroll memory — switching back to a tab returns you to
// where you were, like a native bottom-nav app. The Add form always opens
// at the top (it's a fresh task each time).
const scrollMemory = {};

export function navigate(name){
  const prev = state.view;
  if (prev && prev !== name) scrollMemory[prev] = window.scrollY;

  // NEW(v2.3): a cross-tab refresh deferred while the Add form was open
  // applies as soon as the user leaves it.
  if (tabSyncDirty && prev === 'add' && name !== 'add'){
    applyTabSync().catch(e => console.warn('Tab sync refresh failed', e));
  }

  const swap = () => {
    state.view = name;
    $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
    // Debts is a sub-view of More — keep More tab highlighted
    const tabHighlight = name === 'debts' ? 'more' : name;
    $$('.tab').forEach(t => t.setAttribute('aria-current', t.dataset.go === tabHighlight ? 'page' : 'false'));
    renderCurrent();
    const top = name === 'add' ? 0 : (scrollMemory[name] || 0);
    window.scrollTo({ top, behavior:'instant' });
  };

  // FIX(v2.4.1): View Transitions removed. Snapshot-based animation made the
  // fixed bottom bar appear to pop upward on every tab switch (the root
  // snapshot includes fixed elements, and differing scroll heights shifted
  // it). The per-view CSS fade that predates v2.2 stays — it animates only
  // the content, never the chrome.
  swap();
}

/* ─── Month picker (in the app bar) ─────────────────────────── */
function renderMonthPicker(){
  const { year, month } = state.selected;
  $('#monthPick').textContent = `${monthName(month, true)} ${year} ▾`;
}

function openMonthPicker(){
  // Guard t.date — hand-edited backups can contain dateless records, and an
  // unguarded .slice() here bricked the whole picker (same class of bug as
  // the v1.2 loadState sort fix).
  const yrs = [...new Set(state.transactions.filter(t => t.date).map(t => Number(t.date.slice(0,4))))].sort();
  if (!yrs.length) yrs.push(state.selected.year);
  $('#sheetBody').innerHTML = `
    <h2>Select Month</h2>
    ${yrs.map(y => `
      <div style="margin-bottom:14px;">
        <div class="muted small" style="margin-bottom:8px;">${y}</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;">
          ${monthAbbr.map((m,i) => `
            <button class="chip mp" data-y="${y}" data-m="${i+1}" aria-pressed="${state.selected.year===y && state.selected.month===i+1}" style="padding:10px;text-transform:capitalize;">${m}</button>
          `).join('')}
        </div>
      </div>
    `).join('')}
  `;
  openSheet();
  $$('.mp').forEach(b => b.addEventListener('click', async () => {
    state.selected.year = Number(b.dataset.y);
    state.selected.month = Number(b.dataset.m);
    await saveSelected();
    closeSheet();
    renderMonthPicker();
    renderCurrent();
  }));
}

/* ─── NEW(v2.3): cross-tab state sync ─────────────────────────────
   Two tabs (think: the PC) share IndexedDB but not in-memory state — the
   stale tab would silently stomp the fresh one on its next save. db.js
   announces every write on a BroadcastChannel; here we reload state when
   another tab writes. Politely: never mid-sheet and never while the Add
   form might hold half-typed input — those defer until the sheet closes
   or the user navigates. */
let tabSyncDirty = false;
let tabSyncTimer = null;

async function applyTabSync(){
  tabSyncDirty = false;
  await loadState();
  renderAll();
}

function maybeApplyTabSync(){
  if (isSheetOpen() || state.view === 'add'){ tabSyncDirty = true; return; }
  applyTabSync().catch(e => console.warn('Tab sync refresh failed', e));
}

function setupTabSync(){
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const bc = new BroadcastChannel('ledger-writes');
    bc.addEventListener('message', (e) => {
      if (!e.data || e.data.tabId === TAB_ID) return; // ignore our own echo
      clearTimeout(tabSyncTimer);
      tabSyncTimer = setTimeout(maybeApplyTabSync, 350); // coalesce bursts (cascades)
    });
    window.addEventListener('ledger:sheetclosed', () => {
      if (tabSyncDirty) applyTabSync().catch(e => console.warn('Tab sync refresh failed', e));
    });
  } catch(e){ /* BroadcastChannel unavailable — single-tab behavior, fine */ }
}

/* ─── NEW(v2.3): surface silent failures ─────────────────────────────
   The v2.1 bug taught the lesson: an exception inside an async click
   handler vanishes into the console and the button just "does nothing".
   For a personal finance app, knowing a save failed beats polish. Toasts
   are throttled so an error loop can't spam. */
let lastErrorToast = 0;
function setupErrorSurfacing(){
  const report = (err) => {
    console.error('[Ledger]', err);
    if (Date.now() - lastErrorToast > 5000){
      lastErrorToast = Date.now();
      toast('Something went wrong — see console');
    }
  };
  window.addEventListener('unhandledrejection', (e) => report(e.reason));
  window.addEventListener('error', (e) => report(e.error || e.message));
}

/* ─── NEW(v2.9.1): explicit first-run choice ─────────────────────────
   Replaces the silent auto-seed. The old check ("no accounts? wipe every
   store and reseed") couldn't tell a fresh install from partial data loss
   — if accounts vanished while transactions survived, it destroyed the
   survivors and quietly replaced them with the seed snapshot, which looks
   plausible enough to keep using for days. Now: seeding only happens when
   ALL core stores are empty, and only when the user explicitly picks it.
   seedFromJSON also no longer touches trash/tombstones/meta (db.js). */
function isFreshInstall(){
  return state.accounts.length === 0 && state.transactions.length === 0 && state.bills.length === 0;
}

function showFirstRun(){
  const el = document.createElement('div');
  el.id = 'first-run';
  el.style.cssText = 'position:fixed;inset:0;z-index:200;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:24px;';
  el.innerHTML = `
    <div style="max-width:340px;width:100%;text-align:center;">
      <div style="font-family:'Instrument Serif',serif;font-size:34px;margin-bottom:6px;">Ledger<span style="color:var(--ember);">.</span></div>
      <div class="muted small" style="margin-bottom:22px;line-height:1.55;">Nothing here yet. Everything you add stays on this device in IndexedDB.</div>
      <button class="btn" id="fr-restore">Restore from backup</button>
      <button class="btn secondary" id="fr-seed" style="margin-top:10px;">Load sample data</button>
      <button class="btn ghost" id="fr-empty" style="margin-top:10px;">Start empty</button>
    </div>
  `;
  document.body.appendChild(el);
  const dismiss = () => { el.remove(); renderAll(); };
  $('#fr-restore', el).addEventListener('click', () => restoreJSON(dismiss));
  $('#fr-seed', el).addEventListener('click', async () => {
    try {
      const res = await fetch('seed.json');
      if (!res.ok) throw new Error('seed.json unavailable');
      await seedFromJSON(await res.json());
      await loadState();
      dismiss();
    } catch(e){
      console.warn('Seed load failed:', e);
      toast('Could not load sample data');
    }
  });
  $('#fr-empty', el).addEventListener('click', dismiss);
}

/* ─── Init ─────────────────────────── */
async function init(){
  await loadState();

  if (isFreshInstall()) showFirstRun();

  initSheet();
  renderAll();

  // NEW(v2.0): opportunistic monthly net-worth snapshot + trash purge.
  // Both run after the first paint so they never block startup; failures
  // are non-fatal.
  maybeAutoSnapshot().catch(e => console.warn('Auto snapshot failed', e));
  purgeTrash();
  purgeTombstones();                 // NEW(v2.3)
  scrubLegacyData().catch(e => console.warn('Scrub failed', e)); // NEW(v2.3): one-time
  setupTabSync();                    // NEW(v2.3)
  setupErrorSurfacing();             // NEW(v2.3)
  // NEW(v2.3.1): ask the browser to exempt our IndexedDB from eviction under
  // storage pressure. Best-effort — installed PWAs are usually granted
  // silently. Without this, a storage-hungry device can wipe the ledger.
  try { navigator.storage?.persist?.(); } catch(e){}

  $$('.tab').forEach(t => t.addEventListener('click', () => navigate(t.dataset.go)));
  $('#monthPick').addEventListener('click', openMonthPicker);
  initRipples(); // NEW(v2.2)

  setTimeout(() => $('#splash').style.display = 'none', 300);

  if ('serviceWorker' in navigator){
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      // NEW(v2.9.1): update visibility. Precached files are now served
      // cache-only (see sw.js), so a new release is invisible until reload —
      // tell the user instead of relying on "open the app twice".
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller){
            toastAction('Update ready', 'Reload', () => location.reload(), 10000);
          }
        });
      });
    } catch(e) { console.warn('SW failed', e); }
  }
}

init().catch(e => {
  console.error(e);
  $('#splash').innerHTML = '<div style="color:#e89954;text-align:center;padding:20px;">Error loading: '+e.message+'</div>';
});
