/* Shared test environment: jsdom + fake IndexedDB + globals, app booted. */
import 'fake-indexeddb/auto';
import fs from 'fs';
import { JSDOM } from 'jsdom';

/* v3.1: a controllable viewport. jsdom has no layout engine and no
   matchMedia, so this stub evaluates (min-width|max-width: Npx) queries
   against a width the test sets — 411 ≈ Fold cover screen, 860 ≈ unfolded.
   setViewport() fires 'change' listeners like a real fold/unfold. */
const mq = { width: 411, height: 960, posture: 'flat', lists: [] };
function evalQuery(q){
  let ok = true;
  for (const m of q.matchAll(/\((min|max)-(width|height):\s*(\d+)px\)/g)){
    const v = m[2] === 'width' ? mq.width : mq.height;
    if (m[1] === 'min' && !(v >= +m[3])) ok = false;
    if (m[1] === 'max' && !(v <= +m[3])) ok = false;
  }
  // Foldable postures: tabletop = 2 vertical segments, book = 2 horizontal.
  if (/vertical-viewport-segments:\s*2/.test(q)) ok = ok && mq.posture === 'tabletop';
  if (/horizontal-viewport-segments:\s*2/.test(q)) ok = ok && mq.posture === 'book';
  return ok;
}
function refreshLists(){
  for (const l of mq.lists){
    const m = evalQuery(l.media);
    if (m !== l.matches){ l.matches = m; for (const fn of l.listeners) fn({ matches: m, media: l.media }); }
  }
}
export function setPosture(p){ mq.posture = p; refreshLists(); }
function matchMediaStub(q){
  const l = { media: q, matches: evalQuery(q), listeners: [],
    addEventListener(_t, fn){ this.listeners.push(fn); }, removeEventListener(_t, fn){ this.listeners = this.listeners.filter(f => f !== fn); },
    addListener(fn){ this.listeners.push(fn); }, removeListener(fn){ this.listeners = this.listeners.filter(f => f !== fn); } };
  mq.lists.push(l);
  return l;
}
export function setViewport(width, height = mq.height){
  mq.width = width; mq.height = height;
  if (globalThis.window){ window.innerWidth = width; window.innerHeight = height; }
  refreshLists();
  if (globalThis.window) window.dispatchEvent(new window.Event('resize'));
}

export async function bootEnv(opts = {}){
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    .replace(/<script[^>]*src=[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: opts.url || 'https://ledger.test/' });
  for (const k of ['window','document','HTMLElement','Node','CustomEvent','File','MutationObserver']) globalThis[k] = dom.window[k];
  globalThis.localStorage = dom.window.localStorage;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.location = dom.window.location;
  globalThis.history = dom.window.history;
  globalThis.confirm = () => true;
  globalThis.alert = () => {};
  globalThis.prompt = () => null;
  globalThis.fetch = async () => ({ ok: false });
  globalThis.scrollTo = () => {};
  dom.window.scrollTo = () => {};
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  mq.width = opts.width || 411; mq.height = opts.height || 960; mq.posture = 'flat'; mq.lists = [];
  dom.window.innerWidth = mq.width; dom.window.innerHeight = mq.height;
  globalThis.matchMedia = dom.window.matchMedia = matchMediaStub;
  return dom;
}

export function makeChecker(){
  let pass = 0, fail = 0;
  const check = (name, cond, extra='') => { cond ? pass++ : (fail++, console.log('FAIL:', name, extra)); };
  const done = (label) => {
    console.log(`${label}: ${pass} pass, ${fail} fail`);
    process.exit(fail ? 1 : 0);
  };
  return { check, done };
}

export const tick = (ms=60) => new Promise(r => setTimeout(r, ms));

// Bulk-insert directly (fast path for large fixture sets)
export async function bulkInsert(openDB, store, items){
  const db = await openDB();
  await new Promise(res => {
    const tx = db.transaction(store, 'readwrite');
    items.forEach(i => tx.objectStore(store).put({ updatedAt: Date.now(), ...i }));
    tx.oncomplete = res;
  });
}

// v3.1: click helpers shared by the UI-driving suites.
export function domHelpers(dom){
  const $ = s => dom.window.document.querySelector(s);
  const $$ = s => Array.from(dom.window.document.querySelectorAll(s));
  const click = async (el, ms = 60) => { if (!el) throw new Error('click: element not found'); el.click(); await tick(ms); };
  const pick = async (label) => {
    const o = $$('.picker-option').find(x => x.querySelector('span').textContent.trim() === label);
    if (o) await click(o);
    return !!o;
  };
  const type = (sel, v) => { const el = $(sel); el.value = v; el.dispatchEvent(new dom.window.Event('input')); };
  return { $, $$, click, pick, type };
}
