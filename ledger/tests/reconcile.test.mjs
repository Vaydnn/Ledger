/* Reconcile end-to-end through the real UI: synthetic statement CSV with
   posting lags, 2 planted statement-only fakes, 2 dropped (ledger-only)
   rows, and a declined retry that must be filtered. Drives the actual
   sheet: file input interception → diff render → Add / Fix-all clicks. */
import { bootEnv, makeChecker, tick, bulkInsert } from './_env.mjs';
import { ACCOUNTS, CATEGORIES, makeDataset, makeStatementCSV } from './fixtures.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const $ = s => dom.window.document.querySelector(s);
const $$ = s => Array.from(dom.window.document.querySelectorAll(s));

const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));

const { state, dbPut, loadState, openDB } = await import('../js/db.js');
await import('../js/app.js'); await tick(150);

for (const a of ACCOUNTS) await dbPut('accounts', a);
for (const [type, list] of Object.entries(CATEGORIES)) await dbPut('categories', { id: type, list });
const txns = makeDataset();
await bulkInsert(openDB, 'transactions', txns);
await loadState();

const { csv, fakeCount, droppedCount } = makeStatementCSV(txns);

// intercept the file input — "Choose CSV" hands over the synthetic statement
const origCreate = dom.window.document.createElement.bind(dom.window.document);
dom.window.document.createElement = function(tag){
  const el = origCreate(tag);
  if (String(tag).toLowerCase() === 'input'){
    el.click = function(){
      if (this.type === 'file'){
        Object.defineProperty(this, 'files', { value: [{ name:'stmt.csv', text: async () => csv }], configurable: true });
        setTimeout(() => this.onchange && this.onchange(), 0);
      }
    };
  }
  return el;
};

const { openReconcileSheet } = await import('../js/reconcile.js');
openReconcileSheet(); await tick(50);
check('setup sheet rendered', !!$('#rc-file'));

// the statement is for Main CC — select it in the account picker, exactly
// as a user would (the default is whatever account sorts first)
const pickerRow = $$('button').find(b => b.querySelector('.picker-val'));
check('account picker present', !!pickerRow);
pickerRow.click(); await tick(50);
const opt = $$('.picker-option').find(o => o.textContent.includes('Main CC'));
check('Main CC offered', !!opt);
opt.click(); await tick(80);
check('Main CC selected', $('#sheetBody').textContent.includes('Main CC'));

$('#rc-file').click(); await tick(400);

const stats = $$('.rec-stat .v').map(e => e.textContent.trim());
console.log('stats [matched, stmtOnly, ledgerOnly]:', stats);
const matched = stats[0] || '';
check('matches found', parseInt(matched) > 100, matched);
check('statement-only = the planted fakes', parseInt(stats[1]) === fakeCount, stats[1]);
check('ledger-only = the dropped rows', parseInt(stats[2]) === droppedCount, stats[2]);
check('declined row filtered out', !$('#sheetBody').textContent.includes('DECLINED RETRY'));
check('fakes listed for adding', $('#sheetBody').textContent.includes('FAKE WINGS'));

// loose matches (5-day lags) → Fix all
const fixAll = $('#rc-fix-all');
check('loose matches produced a Fix-all', !!fixAll || !matched.includes('+'), 'fixAll=' + !!fixAll);
if (fixAll){ fixAll.click(); await tick(500); }
const statsAfter = $$('.rec-stat .v').map(e => e.textContent.trim());
check('after fix-all: no loose remainder', !String(statsAfter[0]).includes('+'), statsAfter[0]);

// NEW(v2.9.2): inline add — clicking Add on a statement-only row logs the
// transaction right in the sheet (no Add-form round trip) and the diff
// re-runs in place, so the row migrates to Matched.
const before = state.transactions.length;
let addBtn = $('.rc-add');
check('inline Add button present', !!addBtn);
addBtn.click(); await tick(400);
check('transaction added inline', state.transactions.length === before + 1, `${before} → ${state.transactions.length}`);
const stats2 = $$('.rec-stat .v').map(e => e.textContent.trim());
check('statement-only count dropped', parseInt(stats2[1]) === fakeCount - 1, stats2[1]);
addBtn = $('.rc-add');
if (addBtn){ addBtn.click(); await tick(400); }
check('both fakes now in the ledger',
  state.transactions.some(t => t.description === 'FAKE WINGS') &&
  state.transactions.some(t => t.description === 'FAKE GAME'));
const stats3 = $$('.rec-stat .v').map(e => e.textContent.trim());
check('statement-only cleared after inline adds', parseInt(stats3[1]) === 0, stats3[1]);
check('inline adds got a category', state.transactions.filter(t => t.description.startsWith('FAKE')).every(t => !!t.category));

check('zero captured errors', errors.length === 0, errors[0]);
done('reconcile e2e tests');
