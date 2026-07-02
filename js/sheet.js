/* ============================================================
   sheet.js — bottom-sheet primitives + the generic value picker.

   v2.2 NATIVE-FEEL REWRITE — two big behaviors:

   1. ANDROID BACK GESTURE closes the sheet instead of exiting the
      app. openSheet() pushes a history entry; the popstate listener
      closes the sheet visually; closeSheet() consumes the entry via
      history.back() so programmatic and gesture closes stay in sync.
      One entry per open sheet, never stacked — a picker opened over
      an existing sheet reuses the same entry (back closes the sheet,
      which is the predictable thing).

   2. DRAG TO DISMISS. The sheet follows the finger once a downward
      drag starts (from the handle zone, or anywhere when the sheet's
      content is scrolled to the top), with the backdrop dimming
      proportionally. Past a distance OR velocity threshold it
      dismisses; otherwise it springs back.

   Picker contract is unchanged from v1.1: openPicker() does NOT
   close the sheet on select — view-level callers call closeSheet()
   themselves; sheet-level callers just re-render the sheet body.
   ============================================================ */

import { $, $$, esc, haptic } from './util.js';

const sheetState = {
  open: false,
  inHistory: false,    // we own a history entry for the current open sheet
  ignoreNextPop: false,
  repushAfterPop: false // a sheet opened while a close's history.back() was in flight
};

export function openSheet(){
  const sheet = $('#sheet');
  $('#backdrop').classList.add('open');
  sheet.classList.add('open');
  sheet.style.transform = '';            // clear any leftover drag offset
  sheet.scrollTop = 0;
  if (!sheetState.open){
    sheetState.open = true;
    if (sheetState.ignoreNextPop){
      // A previous close's history.back() hasn't landed yet. Don't push on
      // top of an entry that's about to pop — re-push once it does.
      sheetState.repushAfterPop = true;
      sheetState.inHistory = true;
    } else {
      // One history entry per open sheet so the back gesture closes it.
      try {
        history.pushState({ ledgerSheet: true }, '');
        sheetState.inHistory = true;
      } catch(e){ sheetState.inHistory = false; }
    }
  }
}

function closeSheetVisual(){
  $('#backdrop').classList.remove('open');
  const sheet = $('#sheet');
  sheet.classList.remove('open');
  sheet.style.transform = '';
  sheetState.open = false;
  // NEW(v2.3): lets app.js apply deferred cross-tab refreshes the moment
  // the user is no longer mid-interaction.
  try { window.dispatchEvent(new CustomEvent('ledger:sheetclosed')); } catch(e){}
}

// NEW(v2.3): app.js needs to know whether refreshing the UI right now would
// yank a sheet out from under the user.
export function isSheetOpen(){ return sheetState.open; }

export function closeSheet(){
  if (!sheetState.open){ closeSheetVisual(); return; }
  if (sheetState.inHistory){
    // Let the popstate handler do the visual close, exactly as if the
    // user had swiped back — keeps history balanced.
    sheetState.inHistory = false;
    sheetState.ignoreNextPop = true;
    closeSheetVisual();
    try { history.back(); } catch(e){}
  } else {
    closeSheetVisual();
  }
}

// Wires backdrop click, back gesture, Esc, and drag-to-dismiss. Once, on boot.
export function initSheet(){
  $('#backdrop').addEventListener('click', closeSheet);

  window.addEventListener('popstate', () => {
    if (sheetState.ignoreNextPop){
      sheetState.ignoreNextPop = false;
      if (sheetState.repushAfterPop){
        sheetState.repushAfterPop = false;
        if (sheetState.open){
          try { history.pushState({ ledgerSheet: true }, ''); sheetState.inHistory = true; }
          catch(e){ sheetState.inHistory = false; }
        }
      }
      return;
    }
    if (sheetState.open){
      // Back gesture with a sheet open: close it. The entry was consumed
      // by the navigation itself.
      sheetState.inHistory = false;
      closeSheetVisual();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheetState.open) closeSheet();
  });

  initDragToDismiss();
}

/* ─── Drag to dismiss ─────────────────────────────────────────────
   FIX(v2.4.1): drags now start ONLY from the grab handle (sticky at the
   sheet's top, so it never scrolls away). The previous "anywhere when
   scrolled to top" rule had a nasty failure: scrolling back UP a long
   list would hit scrollTop 0 mid-gesture and convert the scroll into a
   dismissal — the category/account pickers kept closing under people's
   fingers. Content scrolling can never dismiss now; the sheet closes
   only via handle-drag, backdrop tap, back gesture, or Escape. */
function initDragToDismiss(){
  const sheet = $('#sheet');
  const backdrop = $('#backdrop');
  if (!sheet || !('ontouchstart' in window)) return;

  let startY = 0, startT = 0, dy = 0, dragging = false, eligible = false;

  sheet.addEventListener('touchstart', (e) => {
    if (!sheetState.open) return;
    const t = e.touches[0];
    startY = t.clientY; startT = e.timeStamp; dy = 0; dragging = false;
    eligible = !!e.target.closest('.sheet-handle');
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (!sheetState.open || !eligible) return;
    const t = e.touches[0];
    dy = t.clientY - startY;
    if (!dragging){
      if (dy > 6){
        dragging = true;
        sheet.style.transition = 'none';
        backdrop.style.transition = 'none';
      } else {
        return;
      }
    }
    e.preventDefault(); // we own this gesture now
    const off = Math.max(0, dy);
    sheet.style.transform = sheetTransform(off);
    backdrop.style.opacity = String(Math.max(0, 1 - off / (sheet.offsetHeight || 400)));
  }, { passive: false });

  const end = (e) => {
    if (!dragging){ eligible = false; return; }
    dragging = false; eligible = false;
    sheet.style.transition = '';
    backdrop.style.transition = '';
    backdrop.style.opacity = '';
    const dt = Math.max(1, (e.timeStamp - startT));
    const velocity = dy / dt;                 // px per ms
    if (dy > 130 || velocity > 0.55){
      haptic(8);
      sheet.style.transform = '';
      closeSheet();
    } else {
      sheet.style.transform = '';             // spring back via CSS transition
    }
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
}

// At >=560px the sheet is centered with translateX(-50%); preserve it while dragging.
function sheetTransform(off){
  const centered = window.matchMedia('(min-width: 560px)').matches;
  return centered ? `translate(-50%, ${off}px)` : `translateY(${off}px)`;
}

/* ─── Generic bottom-sheet picker ──────────────────────────────── */
// Replaces native <select> for Category / Account / From in the Add form
// and for pickers inside Budgets / Balances sheets. Native <select> popups
// can misbehave in standalone PWA mode on Samsung Internet on foldables —
// a sheet-based picker is more reliable and friendlier to tap on.
export function openPicker(title, options, current, onSelect){
  const opts = (options || []).filter(o => o != null && o !== '');
  $('#sheetBody').innerHTML = `
    <h2>${title}</h2>
    ${opts.length === 0
      ? `<div class="muted small" style="padding:16px 0;">No options available.</div>`
      : `<div class="picker-list">
          ${opts.map(o => {
            // FIX(v1.2): options are user-entered names — fully escape for both
            // the attribute and the visible label (entities decode back to the
            // original string when read via dataset.v).
            const v = esc(o);
            const isCur = o === current;
            return `<button class="picker-option ${isCur?'selected':''}" data-v="${v}">
              <span>${esc(o)}</span>
              ${isCur ? '<span class="picker-check">✓</span>' : ''}
            </button>`;
          }).join('')}
        </div>`
    }
    <button class="btn ghost" id="picker-cancel" style="margin-top:14px;">Cancel</button>
  `;
  openSheet();
  $$('.picker-option').forEach(b => b.addEventListener('click', () => {
    const val = b.dataset.v;
    haptic(6);
    // NOTE: we intentionally do NOT closeSheet() here — see module header.
    onSelect(val);
  }));
  $('#picker-cancel').addEventListener('click', closeSheet);
}
