/* ============================================================
   app.js — entry point. Owns navigation, month picker, init.

   All view/sheet modules import `navigate` / `renderCurrent` from
   here. This creates a partial circular import, but it's safe
   because those references are only used inside event handlers
   (not at module top-level), so by the time they're called,
   both modules are fully loaded.
   ============================================================ */

import { $, $$, monthAbbr, monthName, toast, toastAction, initRipples, esc, haptic } from './util.js';
import { state, loadState, saveSelected, saveFlags, seedFromJSON, TAB_ID, purgeTombstones, scrubLegacyData } from './db.js';
import { restoreJSON, restoreFromText, maybeBackupNudge } from './manage.js';
import { initSheet, openSheet, closeSheet, isSheetOpen } from './sheet.js';
import { renderHome } from './home.js';
import { renderBills } from './bills.js';
import { renderAdd, resetAddForm } from './add.js';
import { openReconcileSheet, openReconcileWithFile } from './reconcile.js';   // NEW(v3.1): shortcuts + share target
import { renderTxns, txnFilters, txnLayoutHandoff } from './txns.js';
import { renderDebts } from './debts.js';
import { renderMore } from './more.js';
import { maybeAutoSnapshot } from './networth.js'; // NEW(v2.0)
import { purgeTrash } from './trash.js';           // NEW(v2.0)
import { ensureAnchorsMigrated, migrateLegacyBalances } from './balances.js'; // NEW(v3.0)
import { applyLayoutClasses, onLayoutChange } from './layout.js';          // NEW(v3.1)
import { updateBadge, remindOnOpen } from './reminders.js';               // NEW(v3.1)
import { lockNow, isLocked, whenUnlocked, setupAutoLock } from './lock.js'; // NEW(v3.1)
import { applyTheme, setupPrivacy } from './appearance.js';               // NEW(v3.1)

/* ─── NEW(v3.1): fold ↔ unfold continuity ─────────────────────────────
   Crossing the breakpoint re-renders the current view (Activity's list +
   detail, the Add form's side column and Bills' calendar only exist
   unfolded) — without losing your place:
   - SCROLL: the first item at the top of the screen (a transaction row, a
     Home card, a bill) is found again after the re-render and put back at
     the same height. Fallback: the same fraction of the page.
   - FOCUS: the field you were typing in keeps focus and cursor position.
   - An open sheet stays open (CSS just switches it between bottom sheet
     and side panel). Activity's selected transaction moves between the
     pane and the sheet (txnLayoutHandoff). */
const ANCHOR_SEL = '[data-id], [data-card], [data-bill-id], [data-goal], .txn-day, .field';
function captureScrollAnchor(){
  const view = $('.view.active');
  if (!view) return null;
  const top = 64;   // below the app bar
  for (const el of view.querySelectorAll(ANCHOR_SEL)){
    const r = el.getBoundingClientRect();
    if (r.bottom > top && r.height > 0){
      const key = ['data-id','data-card','data-bill-id','data-goal'].find(a => el.hasAttribute(a));
      const val = key ? el.getAttribute(key) : null;
      const sel = key ? `[${key}="${(window.CSS && CSS.escape) ? CSS.escape(val) : val}"]` : (el.id ? `#${el.id}` : null);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      return { sel, offset: r.top, frac: max > 0 ? window.scrollY / max : 0 };
    }
  }
  return null;
}
function restoreScrollAnchor(a){
  if (!a) return;
  const el = a.sel && $(`.view.active ${a.sel}`);
  if (el){ window.scrollBy(0, el.getBoundingClientRect().top - a.offset); return; }
  const max = document.documentElement.scrollHeight - window.innerHeight;
  window.scrollTo(0, Math.max(0, a.frac * max));
}
function captureFocus(){
  const el = document.activeElement;
  if (!el || !el.id || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return null;
  let s = null, e = null;
  try { s = el.selectionStart; e = el.selectionEnd; } catch(_){}
  return { id: el.id, s, e };
}
function restoreFocus(f){
  if (!f) return;
  const el = document.getElementById(f.id);
  if (!el) return;
  el.focus({ preventScroll: true });
  try { if (f.s != null) el.setSelectionRange(f.s, f.e); } catch(_){}
}
function setupLayoutChanges(){
  onLayoutChange(({ wide }) => {
    const anchor = captureScrollAnchor();
    const focus = captureFocus();
    applyLayoutClasses();
    const after = state.view === 'txns' ? txnLayoutHandoff(wide) : null;
    renderCurrent();
    restoreScrollAnchor(anchor);
    restoreFocus(focus);
    if (after) after();
  });
}

/* ── Month swipe (v2.9.2 Home; v3.1 also Bills + Activity) ─────────────
   Swipe left/right to step a month; the picker stays for jumping far.
   Guards: edge touches are ignored (Android back-gesture zone), the swipe
   must be decisively horizontal, and swipes that START on something that
   scrolls sideways (filter chips, category chips, type pills, the number
   pad) are left alone. Activity only follows when it's showing one month.
   Listeners live on the persistent view containers — wired once. */
const SWIPE_IGNORE = '.txn-filters, .cat-chips, .type-pills, .amt-pad, .cal, input, textarea, .split-side';
export function monthSwipeAllowed(view){
  if (view === 'txns') return txnFilters.month === 'current' && !txnFilters.dateFrom && !txnFilters.dateTo;
  return view === 'home' || view === 'bills';
}
export async function stepMonth(delta){
  let { year, month } = state.selected;
  month += delta;
  if (month > 12){ month = 1; year++; }
  if (month < 1){ month = 12; year--; }
  state.selected = { year, month };
  haptic(6);
  await saveSelected();
  renderAll();
}
function wireMonthSwipes(){
  if (!('ontouchstart' in window)) return;
  for (const view of ['home', 'bills', 'txns']){
    const el = $(`#view-${view}`);
    if (!el) continue;
    let sx = 0, sy = 0, tracking = false;
    el.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      tracking = t.clientX > 24 && t.clientX < window.innerWidth - 24 && !e.target.closest(SWIPE_IGNORE);
      sx = t.clientX; sy = t.clientY;
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (!monthSwipeAllowed(view) || isSheetOpen()) return;
      stepMonth(dx < 0 ? 1 : -1);
    }, { passive: true });
  }
}

/* ─── Navigation ─────────────────────────── */
export function renderCurrent(){
  if (state.view === 'home')       renderHome();
  else if (state.view === 'bills') renderBills();
  else if (state.view === 'add')   renderAdd();
  else if (state.view === 'txns')  renderTxns();
  else if (state.view === 'debts') renderDebts();
  else if (state.view === 'more')  renderMore();
  updateBadge();                   // NEW(v3.1): app-icon badge follows every change
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
      // A pre-v3 seed carries month-by-month balances; a v3 seed, openings.
      if (state.startingBalances.length) await migrateLegacyBalances();
      else { state.flags.anchorsV3 = true; await saveFlags(); }
      dismiss();
    } catch(e){
      console.warn('Seed load failed:', e);
      toast('Could not load sample data');
    }
  });
  $('#fr-empty', el).addEventListener('click', dismiss);
}

/* ─── NEW(v3.1): launch parameters ─────────────────────────────
   Long-press shortcuts on the app icon (manifest "shortcuts") open
   ./index.html?action=add&type=Expense, ?view=bills, ?action=reconcile …
   The query is consumed once and removed from the address so a reload
   doesn't repeat it. (?share=1 — files shared into Ledger — item 20.) */
const LAUNCH_VIEWS = new Set(['home', 'bills', 'txns', 'more', 'add', 'debts']);
const ADD_TYPES = new Set(['Expense','Income','Refund','Investment','Transfer','CC Payment','Loan Payment','Balance Transfer']);
export async function handleLaunchParams(search){
  const p = new URLSearchParams(search || '');
  if (![...p.keys()].length) return;
  try { history.replaceState(history.state, '', location.pathname); } catch(e){}
  const action = p.get('action'), view = p.get('view');
  if (p.get('share') === '1'){ await receiveSharedFile(); return; }
  if (action === 'add'){
    const type = ADD_TYPES.has(p.get('type')) ? p.get('type') : 'Expense';
    resetAddForm({ type });
    navigate('add');
    requestAnimationFrame(() => $('#f-amount')?.focus());
  } else if (action === 'reconcile'){
    navigate('more');
    openReconcileSheet();
  } else if (view && LAUNCH_VIEWS.has(view)){
    navigate(view);
  }
}

/* ─── NEW(v3.1): Share to Ledger ─────────────────────────────
   sw.js parks a file shared from Android's share sheet in the
   'ledger-share-inbox' cache and opens ?share=1. A statement CSV opens
   Reconcile with the file loaded; a backup JSON offers to restore. */
const SHARE_CACHE = 'ledger-share-inbox', SHARE_KEY = 'shared-file';
export async function receiveSharedFile(){
  let res = null, text = '', name = 'shared-file';
  try {
    const cache = await caches.open(SHARE_CACHE);
    res = await cache.match(SHARE_KEY);
    if (res){
      name = decodeURIComponent(res.headers.get('X-File-Name') || name);
      text = await res.text();
      await cache.delete(SHARE_KEY);
    }
  } catch(e){ console.warn('Reading the shared file failed', e); }
  if (!res){ toast('Nothing to import from that share'); return; }
  navigate('more');
  const looksJson = /\.json$/i.test(name) || /^\s*[{[]/.test(text);
  if (looksJson) await restoreFromText(text, name, renderAll);
  else openReconcileWithFile(name, text);
}

/* ─── Init ─────────────────────────── */
async function init(){
  await loadState();

  // NEW(v3.0): one-time upgrade from stored month-by-month balances to
  // derived balances + pinned openings. Runs before the first paint so the
  // very first render already uses the new model. On failure the flag stays
  // unset and it simply retries next launch.
  try { await ensureAnchorsMigrated(); } catch(e){ console.warn('Balance migration failed', e); }

  applyTheme();                  // NEW(v3.1): dark / pure black
  if (isFreshInstall()) showFirstRun();
  else lockNow();                // NEW(v3.1): app lock — no-op unless turned on
  setupAutoLock();

  initSheet();
  applyLayoutClasses();          // NEW(v3.1): folded / unfolded / posture on <body>
  setupLayoutChanges();          // NEW(v3.1): fold ↔ unfold continuity
  wireMonthSwipes();             // v3.1: Home + Bills + Activity
  setupPrivacy();                // NEW(v3.1): blur amounts (before the first render, so it's caught)
  renderAll();
  // NEW(v3.1): app-icon shortcuts, shared files and the reminder wait for the
  // lock — nothing opens on top of a locked app.
  const afterUnlock = async () => {
    if (!isFreshInstall()) await handleLaunchParams(location.search);
    remindOnOpen().catch(e => console.warn('Reminder failed', e));    // foreground fallback
  };
  if (isLocked()) whenUnlocked().then(afterUnlock);
  else await afterUnlock();

  // NEW(v2.0): opportunistic monthly net-worth snapshot + trash purge.
  // Both run after the first paint so they never block startup; failures
  // are non-fatal.
  maybeAutoSnapshot().catch(e => console.warn('Auto snapshot failed', e));
  purgeTrash();
  purgeTombstones();                 // NEW(v2.3)
  scrubLegacyData().catch(e => console.warn('Scrub failed', e)); // NEW(v2.3): one-time
  setupTabSync();                    // NEW(v2.3)
  setupErrorSurfacing();             // NEW(v2.3)
  maybeBackupNudge().catch(e => console.warn('Backup nudge failed', e)); // NEW(v2.9.2)
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
  $('#splash').innerHTML = '<div style="color:#e89954;text-align:center;padding:20px;">Error loading: '+esc(e.message)+'</div>';
});
