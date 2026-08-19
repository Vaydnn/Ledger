/* Shared test environment: jsdom + fake IndexedDB + globals, app booted. */
import 'fake-indexeddb/auto';
import fs from 'fs';
import { JSDOM } from 'jsdom';
import * as XLSXmod from 'xlsx';
globalThis.XLSX = XLSXmod; // app loads this from CDN in production

export async function bootEnv(){
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    .replace(/<script[^>]*src=[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://ledger.test/' });
  for (const k of ['window','document','HTMLElement','Node','CustomEvent','File']) globalThis[k] = dom.window[k];
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
