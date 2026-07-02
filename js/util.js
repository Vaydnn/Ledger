/* ============================================================
   util.js — shared constants, formatters, DOM + date helpers.
   No imports. Every other module depends on this one.
   ============================================================ */

// v2.9.3 — hotfix: the Add Budget form's Type/Category pickers stranded the
// user on the picker (callbacks mutated a detached node, never re-rendered).
// Form state moved to a module object; pickers re-render the sheet.
export const APP_VERSION = '2.9.3';

// Hard-coded baseline category lists. Used for:
//   (1) Auto-restore on load if a list is empty but the user has existing data
//   (2) The "Restore defaults" button in the Categories sheet
// FIX(v2.9.1): genericized. The old lists were the user's real personal
// categories (specific banks, subscriptions, family items) sitting in a
// public repo — and the stale CCPayment set was already flagged in
// DEFERRED_FIXES #3. Live devices keep their own lists in IndexedDB; these
// only seed fresh installs and backfill emptied lists.
export const DEFAULT_CATEGORIES = {
  Expense: ['Education','Gas','Groceries','Health','Misc','Phone Bill','Rent','Restaurants','Shopping','Subscriptions','Travel','Utilities'],
  Income: ['Cash Back','Gifts','Other Income','Salary'],
  Refund: ['Cashback','Credit','Other Refund','Purchase Refund','Reimbursement','Return'],
  Investment: ['Brokerage','Other Investment','Roth IRA'],
  CCPayment: ['CC Payment'],
  LoanPayment: ['Loan Payment'],
  Transfer: ['Transfer'],
  BalanceTransfer: ['Balance Transfer']
};

export const monthAbbr = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

/* ─── DOM shortcuts ─────────────────────────── */
export const $ = (s, root=document) => root.querySelector(s);
export const $$ = (s, root=document) => Array.from(root.querySelectorAll(s));

/* ─── Money formatters ─────────────────────────── */
// FIX(v1.2): added integer-cents money helpers — raw float accumulation across
// 1000+ transactions produces drift (e.g. 5723.6900000000005) and the backup
// even contained sub-cent amounts (15.876) saved straight from parseFloat.
// All aggregation paths now sum in cents and round at the boundary.
export const toCents = (n) => Math.round((Number(n) || 0) * 100);
export const fromCents = (c) => c / 100;
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
// Sum an array (optionally via a value-extractor) in integer cents, return dollars.
export const sumMoney = (arr, getter) => {
  let c = 0;
  for (const x of arr) c += toCents(getter ? getter(x) : x);
  return fromCents(c);
};
// FIX(v1.2): parse user-typed amounts safely. parseFloat('1,234.56') silently
// returned 1 and stored the wrong amount; '$12.50' returned NaN. Strips
// currency symbols / thousands separators / spaces and rounds to cents.
// Returns NaN for anything that still isn't a clean number.
export const parseAmount = (raw) => {
  if (typeof raw === 'number') return round2(raw);
  const s = String(raw ?? '').replace(/[$,\s]/g, '');
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return NaN;
  return round2(parseFloat(s));
};

/* ─── HTML escaping ───────────────────────────────
   FIX(v1.2): user-entered strings (descriptions, merchant names, account and
   category names) were interpolated into innerHTML raw — a description like
   "<b>lunch" broke the layout. esc() is now applied at render-time at the
   user-string injection points. */
export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const fmt = (n, sign=false) => {
  if (n == null || isNaN(n)) n = 0;
  const v = Math.abs(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  if (sign) return (n < 0 ? '−' : '+') + '$' + v;
  return (n < 0 ? '−$' : '$') + v;
};
export const fmtShort = (n) => {
  if (n == null || isNaN(n)) n = 0;
  const v = Math.abs(n).toLocaleString('en-US', {maximumFractionDigits:0});
  return (n < 0 ? '−$' : '$') + v;
};

/* ─── Date helpers ───────────────────────────────
   All dates in this app are treated as LOCAL calendar dates, never UTC.
   A transaction logged at 10 PM on April 17 in Texas should save as
   "2026-04-17", not "2026-04-18" which is what toISOString() would give. */
export const toLocalISO = (d) => {
  return d.getFullYear() + '-' +
    String(d.getMonth()+1).padStart(2,'0') + '-' +
    String(d.getDate()).padStart(2,'0');
};
export const today = () => toLocalISO(new Date());
// Parse a "YYYY-MM-DD" string as local midnight (not UTC — avoids timezone-shift bugs)
export const parseLocalDate = (iso) => new Date(iso + 'T00:00:00');
export const monthKey = (iso) => iso.slice(0,7); // 'YYYY-MM'
export const monthName = (m, short=false) => {
  const names = short
    ? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    : ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return names[m-1];
};
// daysBetween receives "YYYY-MM-DD" strings — parse as local midnight so DST doesn't skew the count
export const daysBetween = (a, b) => Math.round((parseLocalDate(b) - parseLocalDate(a)) / 86400000);

/* ─── Misc helpers ─────────────────────────── */
// FIX(v1.2): uid() could collide inside tight loops (seed/restore put 1000+
// records inside one Date.now() millisecond; 5 random base36 chars gave a
// non-trivial birthday-collision chance, and IndexedDB put() silently
// overwrites on key collision). A monotonic counter now guarantees uniqueness
// within a session.
let _uidCounter = 0;
export const uid = () => Date.now().toString(36) + (_uidCounter++ % 1296).toString(36).padStart(2,'0') + Math.random().toString(36).slice(2,7);
// FIX(v1.2): calendar-safe day stepping. Adding N*86400000 ms to a local-midnight
// Date duplicates/skips a calendar day across the fall-back DST transition
// (user is in US Central). The Date(y, m, d+n) constructor handles DST correctly.
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const alphaSort = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity:'base' });
export const alphaSortBy = (key) => (a, b) => alphaSort(a[key], b[key]);

/* ─── Toast ─────────────────────────── */
let _toastTimer = null;
export const toast = (msg) => {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
};

/* ─── NEW(v2.2): native-feel helpers ─────────────────────────── */
// Haptic feedback. Silent no-op where unsupported (iOS Safari, desktop).
// Conventions: 6 = selection tick, 15 = action confirmed, [10,30,10] = destructive.
export const haptic = (pattern = 10) => {
  try { navigator.vibrate && navigator.vibrate(pattern); } catch(e){}
};

// Material-style ripple, one delegated listener for the whole app.
// Spawns on press for the interactive classes below; the element gets
// position/overflow handling from the .has-ripple CSS.
// FIX(v2.4): ripples removed from anything that lives inside a scrollable
// list (picker options, menu items, chips, txn rows) — spawning ripples and
// transforms mid-scroll made list scrolling feel clunky. Discrete buttons only.
// FIX(v2.4.3): tabs removed entirely. The bottom nav repeatedly glitched on
// Samsung Internet (tabs jumping out of the bar) — injecting ripple spans and
// toggling overflow inside a backdrop-filtered position:fixed element is
// exactly the kind of compositing stress that triggers it. The nav is now a
// zero-DOM-mutation, zero-transform zone.
const RIPPLE_SEL = '.btn, .type-pill, .seg-btn, .qa-btn';
export function initRipples(){
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest(RIPPLE_SEL);
    if (!el || el.disabled) return;
    el.classList.add('has-ripple');
    const rect = el.getBoundingClientRect();
    const d = Math.max(rect.width, rect.height) * 2;
    const r = document.createElement('span');
    r.className = 'ripple';
    r.style.width = r.style.height = d + 'px';
    r.style.left = (e.clientX - rect.left - d/2) + 'px';
    r.style.top  = (e.clientY - rect.top  - d/2) + 'px';
    el.appendChild(r);
    r.addEventListener('animationend', () => r.remove());
    // Safety net if animationend never fires (display:none mid-animation)
    setTimeout(() => r.remove(), 700);
  }, { passive: true });
}

// NEW(v2.0): toast with an inline action button (used for "Deleted · Undo").
// Longer timeout than the plain toast so the user has time to react.
export const toastAction = (msg, label, onAction, ms = 6000) => {
  const t = $('#toast');
  if (!t) return;
  t.innerHTML = `${esc(msg)} <button id="toast-act" style="margin-left:10px;background:none;border:none;color:var(--ember);font:inherit;font-weight:600;letter-spacing:.04em;cursor:pointer;padding:4px 2px;">${esc(label)}</button>`;
  t.classList.add('show');
  $('#toast-act').addEventListener('click', () => {
    clearTimeout(_toastTimer);
    t.classList.remove('show');
    onAction();
  });
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), ms);
};
