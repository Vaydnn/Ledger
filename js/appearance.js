/* ============================================================
   appearance.js — NEW(v3.1): theme + privacy mode.

   Theme: 'dark' (default) or 'black' — pure #000 surfaces, which the
   Fold's OLED panels switch off entirely.

   Privacy mode: dollar amounts are blurred until tapped (one tap reveals
   that amount; the eye button in the top bar reveals all of them until
   Ledger goes to the background). Amounts are found in the rendered text
   — any "$1,234.56", "−$12", "$1.2k" — so every screen and sheet is
   covered without touching each renderer. Bill notifications drop their
   amounts too (remind-core summary).
   Both are device-local flags (flags.theme, flags.privacy).
   ============================================================ */

import { $ } from './util.js';
import { state, saveFlags } from './db.js';

/* ── theme ── */
const THEME_COLOR = { dark: '#0f0e0c', black: '#000000' };
export const theme = () => state.flags.theme === 'black' ? 'black' : 'dark';
export function applyTheme(){
  const t = theme();
  if (t === 'black') document.documentElement.dataset.theme = 'black';
  else delete document.documentElement.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[t]);
}
export async function setTheme(t){
  state.flags.theme = t === 'black' ? 'black' : 'dark';
  await saveFlags();
  applyTheme();
}

/* ── privacy ── */
export const MONEY_RE = /[−+-]?\$\s?\d[\d,]*(?:\.\d+)?[kKmM]?/g;
const SKIP = 'script,style,textarea,input,.amt-calc,.toast,#lock,[data-nopv]';
const SVG_NS = 'http://www.w3.org/2000/svg';
let observer = null;

export const privacyOn = () => !!state.flags.privacy;
export async function setPrivacy(on){
  state.flags.privacy = !!on;
  await saveFlags();
  applyPrivacy();
}

// Wraps every amount under `root` in <span class="pv">. SVG text can't hold
// HTML spans, so the <text> element itself gets the class.
export function maskAmounts(root){
  if (!root) return 0;
  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const hits = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()){
    const p = n.parentElement;
    if (!p || p.closest('.pv') || p.closest(SKIP)) continue;
    MONEY_RE.lastIndex = 0;
    if (MONEY_RE.test(n.data)) hits.push(n);
  }
  for (const n of hits){
    const p = n.parentElement;
    if (p.namespaceURI === SVG_NS){ p.classList.add('pv'); continue; }
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of n.data.matchAll(MONEY_RE)){
      if (m.index > last) frag.append(n.data.slice(last, m.index));
      const s = doc.createElement('span');
      s.className = 'pv';
      s.textContent = m[0];
      frag.append(s);
      last = m.index + m[0].length;
    }
    if (last < n.data.length) frag.append(n.data.slice(last));
    n.replaceWith(frag);
  }
  return hits.length;
}

const roots = () => [$('main'), $('#sheetBody')].filter(Boolean);

export function applyPrivacy(){
  const on = privacyOn();
  document.body.classList.toggle('privacy', on);
  if (!on){ document.body.classList.remove('pv-all'); observer?.disconnect(); observer = null; return; }
  for (const r of roots()) maskAmounts(r);
  if (!observer && typeof MutationObserver !== 'undefined'){
    observer = new MutationObserver(muts => {
      for (const m of muts){
        for (const node of m.addedNodes){
          if (node.nodeType === 1) maskAmounts(node);
          else if (node.nodeType === 3 && node.parentElement) maskAmounts(node.parentElement);
        }
        if (m.type === 'characterData' && m.target.parentElement) maskAmounts(m.target.parentElement);
      }
    });
    for (const r of roots()) observer.observe(r, { childList: true, subtree: true, characterData: true });
  }
}

export function revealAll(on){
  document.body.classList.toggle('pv-all', on);
  const eye = $('#privacyEye');
  if (eye){ eye.setAttribute('aria-pressed', String(on)); eye.setAttribute('aria-label', on ? 'Hide amounts' : 'Show amounts'); }
}

export function setupPrivacy(){
  // First tap on a blurred amount reveals it — and only that; the tap
  // doesn't also open the row underneath.
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('privacy') || document.body.classList.contains('pv-all')) return;
    const pv = e.target.closest?.('.pv');
    if (!pv || pv.classList.contains('pv-show')) return;
    pv.classList.add('pv-show');
    e.preventDefault();
    e.stopPropagation();
  }, true);
  $('#privacyEye')?.addEventListener('click', () => revealAll(!document.body.classList.contains('pv-all')));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    revealAll(false);
    document.querySelectorAll('.pv-show').forEach(el => el.classList.remove('pv-show'));
  });
  applyPrivacy();
}
