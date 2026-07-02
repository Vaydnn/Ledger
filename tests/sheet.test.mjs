import { bootEnv, makeChecker, tick } from './_env.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const $ = s => dom.window.document.querySelector(s);
const $$ = s => Array.from(dom.window.document.querySelectorAll(s));
const { openSheet, closeSheet, initSheet } = await import('../js/sheet.js');
initSheet();
const isOpen = () => $('#sheet').classList.contains('open');
// 1. open pushes history; back gesture closes the sheet (not the page)
const len0 = dom.window.history.length;
openSheet();
check('open visual', isOpen());
check('history pushed', dom.window.history.length === len0 + 1);
dom.window.history.back();           // simulate Android back gesture
await tick();
check('back gesture closed sheet', !isOpen());

// 2. programmatic close consumes the entry (no stale state)
openSheet();
closeSheet();
await tick();
check('programmatic close', !isOpen());
openSheet();                          // open again — should push cleanly
check('reopen after close', isOpen());
dom.window.history.back();
await tick();
check('back closes again (entry not stale)', !isOpen());

// 3. race: close then immediately reopen before the back() lands
openSheet();
closeSheet();
openSheet();                          // back() still in flight
await tick(60);                       // pop lands; repushAfterPop should heal
check('sheet survived the race', isOpen());
dom.window.history.back();            // back gesture must close the sheet, not exit
await tick();
check('post-race back closes sheet', !isOpen());

// 4. Escape key closes
openSheet();
dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key:'Escape' }));
await tick();
check('Escape closes', !isOpen());
done('sheet history tests');
