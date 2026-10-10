/* v3.0 reconcile for raw-description statements (Citi-style export:
   Status,Date,Description,Debit,Credit — no Type column, credits negative,
   "MERCHANT #store CITY ST null XXXXXXXXXXXX1234" descriptions, uppercase
   .CSV). Unmatched rows must be added with YOUR names and categories, the
   payment row as a CC Payment, and the built-in CSV parser must cope with
   the usual export quirks. Synthetic data only. */
import { bootEnv, makeChecker, tick } from './_env.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const $ = s => dom.window.document.querySelector(s);
const $$ = s => Array.from(dom.window.document.querySelectorAll(s));
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));
globalThis.confirm = () => true;

const { state, dbPut, loadState } = await import('../js/db.js');
await import('../js/app.js'); await tick(150);
const rec = await import('../js/reconcile.js');

// ── Parser quirks ──
const g = rec.parseCSV('﻿Date;Description;Amount\r\n"10/01/2026";"A ""quoted"" name; with semicolon";"1,234.56"\r\n\r\n10/02/2026;Plain;-5\n');
check('BOM + semicolon delimiter + CRLF', g.length === 3 && g[0][0] === 'Date');
check('quoted field with "" escape and delimiter inside', g[1][1] === 'A "quoted" name; with semicolon');
check('blank lines dropped', g[2][1] === 'Plain');

// ── Ledger: dining card history the way a person logs it ──
await dbPut('accounts', { id:'a1', name:'Dining Card', type:'Credit Card', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'Checking', type:'Checking', active:true, order:1 });
await dbPut('categories', { id:'Expense', list:['Misc','Restaurants','Shopping'] });
await dbPut('categories', { id:'Refund', list:['Purchase Refund','Return'] });
await dbPut('categories', { id:'CCPayment', list:['CC Payment'] });
const mine = [
  ['2026-09-02','Burger Barn',9.10], ['2026-09-03','Pizza Palace',14.25], ['2026-09-05','Taco Stand',6.75],
  ['2026-09-09','Burger Barn',11.20], ['2026-09-12','Pizza Palace',16.40], ['2026-09-15','Noodle Hut',21.30],
  ['2026-09-18','Taco Stand',12.50], ['2026-09-20','Burger Barn',9.10]
];
let id = 0;
for (const [date, d, amt] of mine) await dbPut('transactions', { id:'m'+(id++), date, type:'Expense', account:'Dining Card', category:'Restaurants', amount:amt, description:d, fromAccount:null });
// Earlier card payments came from Checking.
await dbPut('transactions', { id:'p0', date:'2026-08-30', type:'CC Payment', account:'Dining Card', fromAccount:'Checking', category:'CC Payment', amount:200, description:'' });
await loadState();
state.flags.anchorsV3 = true;

const row = (date, desc, debit, credit = '') => `Cleared,${date},"${desc}",${debit},${credit}`;
const csv = [
  'Status,Date,Description,Debit,Credit',
  // matched — teach the names
  row('09/02/2026','BURGER BARN #01234 SOMETOWN TX null XXXXXXXXXXXX0000','9.10'),
  row('09/03/2026','PIZZA PALACE 555-0101 SOMETOWN TX','14.25'),
  row('09/05/2026','TACO STAND 000123 OTHERTOWN TX null XXXXXXXXXXXX0000','6.75'),
  row('09/09/2026','BURGER BARN #01234 SOMETOWN TX null XXXXXXXXXXXX0000','11.20'),
  row('09/12/2026','PIZZA PALACE 555-0101 SOMETOWN TX','16.40'),
  row('09/15/2026','PY *NOODLE HUT TX 7 SOMETOWN TX null XXXXXXXXXXXX0000','21.30'),
  row('09/18/2026','TACO STAND 000123 OTHERTOWN TX null XXXXXXXXXXXX0000','12.50'),
  row('09/20/2026','BURGER BARN #01234 SOMETOWN TX null XXXXXXXXXXXX0000','9.10'),
  // not in the ledger yet
  row('09/24/2026','BURGER BARN #01234 SOMETOWN TX null XXXXXXXXXXXX1111','10.45'),
  row('09/25/2026','PIZZA PALACE 555-0101 SOMETOWN TX','18.20'),
  row('09/26/2026','PY *NOODLE HUT TX 7 SOMETOWN TX','13.60'),
  row('09/27/2026','WINGS PLACE 9999 SOMETOWN TX','24.00'),
  row('09/28/2026','ONLINE PAYMENT, THANK YOU','', '-300.00'),
  row('09/28/2026','MEMBERSHIP FEE OCT 26-SEP 27','0.00'),
].join('\r\n');

const origCreate = dom.window.document.createElement.bind(dom.window.document);
let acceptSeen = 'unset';
dom.window.document.createElement = function(tag){
  const el = origCreate(tag);
  if (String(tag).toLowerCase() === 'input') el.click = function(){
    acceptSeen = this.accept;
    Object.defineProperty(this, 'files', { value:[{ name:'Date range.CSV', text: async () => csv }] });
    setTimeout(() => this.onchange && this.onchange(), 0);
  };
  return el;
};

rec.openReconcileSheet(); await tick(40);
const pickerBtn = $$('button').find(b => b.querySelector('.picker-val'));
pickerBtn.click(); await tick(40);
$$('.picker-option').find(o => o.querySelector('span').textContent.trim() === 'Dining Card').click(); await tick(60);
$('#rc-file').click(); await tick(500);

check('file picker has no type filter (uppercase .CSV selectable on Android)', !acceptSeen);
const stats = $$('.rec-stat .v').map(e => e.textContent.trim());
check('8 matched, 5 statement-only, $0 fee skipped', parseInt(stats[0]) === 8 && parseInt(stats[1]) === 5, stats.join(' / '));
const guesses = $$('.rc-guess').map(e => e.textContent);
check('preview shows learned name + category', guesses.some(t => t.includes('Restaurants') && t.includes('Burger Barn')), guesses.join(' | '));
check('payment row previews as a CC Payment from Checking', guesses.some(t => t.includes('CC Payment from Checking')), guesses.join(' | '));
check('learned names persisted for next statement', Object.keys(state.flags.stmtMerchants || {}).some(k => k.startsWith('Expense|burgerbarn')));

$('#rc-add-all').click(); await tick(800);
const added = state.transactions.filter(t => t.date >= '2026-09-24').sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
const by = (amt) => added.find(t => Math.abs(t.amount - amt) < 0.001);
check('Burger Barn row (different card mask): your name + Restaurants', by(10.45)?.description === 'Burger Barn' && by(10.45)?.category === 'Restaurants', JSON.stringify(by(10.45)));
check('Pizza Palace row: your name', by(18.20)?.description === 'Pizza Palace' && by(18.20)?.category === 'Restaurants');
check('Noodle Hut (PY * prefix, state code inside the name, no mask) still learned', by(13.60)?.description === 'Noodle Hut', JSON.stringify(by(13.60)));
check('unknown merchant: cleaned name + the card\'s usual category', by(24)?.description === 'Wings Place' && by(24)?.category === 'Restaurants', JSON.stringify(by(24)));
const pay = by(300);
check('payment logged as CC Payment from Checking (not a Refund)', pay?.type === 'CC Payment' && pay?.fromAccount === 'Checking' && pay?.account === 'Dining Card', JSON.stringify(pay));
const stats2 = $$('.rec-stat .v').map(e => e.textContent.trim());
check('statement fully reconciled after Add all', parseInt(stats2[1]) === 0 && parseInt(stats2[2]) === 0, stats2.join(' / '));
check('totals tie out', ($('#sheetBody').textContent || '').includes('✓ $0.00'));

check('zero captured errors', errors.length === 0, errors[0]);
done('citi-style reconcile tests');
