/* ============================================================
   reconcile.js — NEW(v2.0): CSV statement reconciliation.

   Pick an account, choose the bank's CSV export, and the ledger is diffed
   against the statement:

     ✓ Matched        — same amount to the cent, dates within the tolerance
                        window (statement posting dates drift from purchase
                        dates); a looser ±14d amount-only pass catches lag
     ⚠ Statement only — on the statement, missing from the ledger → one tap
                        adds it right here
     ⚠ Ledger only    — logged here, not on the statement → tap to open

   v3.0 — built around statements with RAW bank descriptions (Citi-style
   "BURGER BARN #01234 SOMETOWN TX null XXXXXXXXXXXX0000", no Type column),
   which used to add every row as Misc with the bank string as the
   description, and the card payment as a Refund:
   - Descriptions are cleaned (masked card numbers, processor prefixes like
     "SQ *" / "PY *", store numbers, city + state) to a merchant name.
   - Rows that DID match teach the sheet your names: if statement
     "BURGER BARN …" matched your "Burger Barn · Restaurants", unmatched
     Burger Barn rows are added exactly that way. What's learned is kept
     (flags.stmtMerchants) so next month's statement benefits too. Then
     merchant memory (fuzzy), then the account's dominant category.
   - Payment rows are detected from the description when there's no Type
     column, and add as CC/Loan Payment from your usual pay-from account.
   - Checking-account statements: deposits add as Income, not Refund.
   - Every unmatched row previews what it will be added as.
   - CSV parsing is built in (SheetJS — 950 KB — is gone with Excel
     export), and the file picker no longer filters by type: Android greyed
     out Citi's uppercase ".CSV" downloads.
   ============================================================ */

import { $, $$, fmt, toast, toastAction, esc, toCents, fromCents, round2, toLocalISO, daysBetween, sumMoney, uid, haptic, squash, busyGuard, CSV_ACCEPT } from './util.js';
import { state, dbPut, dbDel, saveFlags } from './db.js';
import { acctTypeMap, txnEffectsCents } from './effects.js';
import { openSheet, closeSheet, openPicker } from './sheet.js';
import { invalidateMerchantCache, lookupMerchant, findMerchantFuzzy } from './merchants.js';
import { resetAddForm } from './add.js';
import { navigate } from './app.js';
import { openTxnSheet } from './txns.js';

const recState = {
  account: null,
  window: 3,          // ± days date tolerance
  flipSigns: false,   // user override for charge-sign detection
  rows: null,         // parsed CSV rows
  fileName: ''
};

export function openReconcileSheet(){
  const debts = state.accounts.filter(a => a.active && (a.type === 'Credit Card' || a.type === 'Loan'));
  const all = state.accounts.filter(a => a.active);
  const options = [...debts, ...all.filter(a => !debts.includes(a))]; // debt accounts first
  if (!options.length){ toast('No accounts to reconcile'); return; }
  if (!recState.account || !options.find(a => a.name === recState.account)){
    // FIX(v2.9.1): default to the busiest account (no personal names in code).
    const usage = {};
    for (const t of state.transactions){
      if (t.account) usage[t.account] = (usage[t.account] || 0) + 1;
    }
    recState.account = [...options].sort((a, b) => (usage[b.name] || 0) - (usage[a.name] || 0))[0].name;
  }
  renderSetup(options);
  openSheet({ wide: true }); // v3.1: centered dialog unfolded (side-by-side columns)
}

function renderSetup(options){
  $('#sheetBody').innerHTML = `
    <h2>Reconcile CSV</h2>
    <div class="muted small" style="margin-bottom:14px;line-height:1.55;">
      Compare a bank/card CSV export against your ledger. Amounts must match to the cent; dates can drift by the tolerance below (statements post a few days late).
    </div>
    <div class="field">
      <label>Account</label>
      <button class="input picker-btn" id="rc-acct" type="button">
        <span class="picker-val">${esc(recState.account)}</span>
        <span class="picker-chev">▾</span>
      </button>
    </div>
    <div class="field">
      <label>Date tolerance</label>
      <div class="seg" id="rc-win" role="tablist">
        ${[1,3,5,7].map(d => `<button type="button" class="seg-btn ${recState.window===d?'active':''}" data-w="${d}">±${d}d</button>`).join('')}
      </div>
    </div>
    <button class="btn" id="rc-file">Choose CSV file…</button>
    ${recState.rows ? `<button class="btn secondary" id="rc-rerun" style="margin-top:10px;">Re-run on ${esc(recState.fileName)}</button>` : ''}
  `;

  $('#rc-acct').addEventListener('click', () => {
    openPicker('Account', options.map(a => a.name), recState.account, (val) => {
      recState.account = val;
      renderSetup(options);
    });
  });
  $$('.seg-btn', $('#rc-win')).forEach(b => b.addEventListener('click', () => {
    recState.window = Number(b.dataset.w);
    $$('.seg-btn', $('#rc-win')).forEach(x => x.classList.toggle('active', x === b));
  }));
  $('#rc-file').addEventListener('click', pickFile);
  $('#rc-rerun')?.addEventListener('click', () => renderResults());
}

function pickFile(){
  const input = document.createElement('input');
  input.type = 'file';
  // FIX(v3.0→3.1): Android maps extensions to MIME types case-sensitively,
  // so with accept=".csv" Citi's "Date range.CSV" was greyed out. v3.0 dropped
  // the filter entirely — which made Android offer Camera / Sound recorder
  // too. The broad list includes octet-stream (what unknown/uppercase files
  // report), so every statement stays selectable; the parser validates.
  input.accept = CSV_ACCEPT;
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const rows = parseStatementCSV(text);
      if (!rows.length){ toast('No transactions found in that file'); return; }
      recState.rows = rows;
      recState.fileName = file.name;
      recState.flipSigns = false;
      renderResults();
    } catch(e){
      console.error(e);
      toast('Could not read that file: ' + (e.message || 'unknown error'));
    }
  };
  input.click();
}

/* ─── CSV parsing ─────────────────────────── */
// NEW(v3.0): RFC-4180-style parser — quoted fields, "" escapes, CR/LF, BOM;
// the delimiter (comma / semicolon / tab) is sniffed from the first line.
export function parseCSV(text){
  let s = String(text || '');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  const firstLine = s.slice(0, s.search(/\r?\n|$/));
  const delim = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < s.length; i++){
    const ch = s[i];
    if (inQ){
      if (ch === '"'){
        if (s[i + 1] === '"'){ field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim){ row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r'){
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

export function parseStatementCSV(text){
  const grid = parseCSV(text);
  // Find the header row: first row with a date-ish and an amount-ish label.
  let headerIdx = -1, cols = null;
  for (let i = 0; i < Math.min(grid.length, 10); i++){
    const cands = detectColumns(grid[i]);
    if (cands){ headerIdx = i; cols = cands; break; }
  }
  if (headerIdx < 0) throw new Error('no Date/Amount header row found');

  const rows = [];
  for (let i = headerIdx + 1; i < grid.length; i++){
    const r = grid[i];
    if (!r || !r.length) continue;
    // Declined/failed/reversed rows never touched the balance — skip them or
    // they show up as phantom "statement only" duplicates.
    const status = cols.status != null ? String(r[cols.status] ?? '').trim() : '';
    if (/declin|fail|cancel|revers/i.test(status)) continue;
    const date = parseCSVDate(r[cols.date]);
    if (!date) continue;
    let amount;
    if (cols.amount != null){
      amount = parseCSVAmount(r[cols.amount]);
    } else {
      // Separate Debit / Credit columns: debits are charges (positive),
      // credits are payments/refunds (negative), whatever sign they carry.
      const d = parseCSVAmount(r[cols.debit]);
      const c = parseCSVAmount(r[cols.credit]);
      amount = !isNaN(d) && d !== 0 ? Math.abs(d) : (!isNaN(c) && c !== 0 ? -Math.abs(c) : NaN);
    }
    if (isNaN(amount) || amount === 0) continue;
    const desc = cols.desc != null ? String(r[cols.desc] ?? '').trim() : '';
    rows.push({
      date, amount: round2(amount), desc,
      pending: /pending/i.test(status),
      rtype: cols.type != null ? String(r[cols.type] ?? '').trim() : ''
    });
  }
  return rows;
}

function detectColumns(row){
  if (!row) return null;
  const find = (re) => row.findIndex(c => re.test(String(c).trim()));
  const date = find(/^(trans(action)?\s*)?date$|posted\s*date|^date\b/i);
  if (date < 0) return null;
  const amount = find(/^amount$|^amt$|transaction\s*amount/i);
  const debit = find(/^debit/i);
  const credit = find(/^credit/i);
  if (amount < 0 && (debit < 0 || credit < 0)) return null;
  // Merchant before Description: card exports with both (Robinhood) put the
  // clean name in Merchant and leave Description empty.
  let desc = find(/^merchant/i);
  if (desc < 0) desc = find(/description|^name$|payee|^memo$|details/i);
  const status = find(/^status$/i);
  const type = find(/^type$|transaction\s*type/i);
  return {
    date,
    amount: amount >= 0 ? amount : null,
    debit: debit >= 0 ? debit : null,
    credit: credit >= 0 ? credit : null,
    desc: desc >= 0 ? desc : null,
    status: status >= 0 ? status : null,   // pending / declined
    type: type >= 0 ? type : null          // purchase / payment / refund
  };
}

function parseCSVDate(v){
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);           // YYYY-MM-DD, YYYY/M/D
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);                 // M/D/YY[YY]
  if (m){
    let y = Number(m[3]); if (y < 100) y += 2000;
    return `${y}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  }
  if (/^\d{5}$/.test(s)){                                            // Excel serial
    const d = new Date(Math.round((Number(s) - 25569) * 86400000));
    return d.toISOString().slice(0,10);
  }
  const d = new Date(s);                                             // "Oct 08, 2026"
  return isNaN(d) ? null : toLocalISO(d);
}

function parseCSVAmount(v){
  if (v == null || v === '') return NaN;
  let s = String(v).trim().replace(/[$,\s]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)){ neg = true; s = s.slice(1, -1); }   // (12.34) accounting style
  if (/^-/.test(s) && /-$/.test(s)) s = s.slice(1);
  if (/-$/.test(s)){ neg = true; s = s.slice(0, -1); }          // 12.34- trailing minus
  const n = parseFloat(s);
  if (isNaN(n)) return NaN;
  return neg ? -n : n;
}

/* ─── NEW(v3.0): statement descriptions → merchant names ─────────────── */
const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
// Payment processors that prefix the real merchant ("SQ *CORNER CAFE").
const PROCESSOR = /^(PY|SQ|TST|SP|PP|BT|DD|CKO|IC|IN|GOOGLE|PAYPAL|APPLE\.COM\/BILL|AMZN\s*MKTP\s*US|AMZN)\s*\*\s*/i;

function cleanParts(raw){
  let s = String(raw || '')
    .replace(/\bnull\b/gi, ' ')
    .replace(/X{4,}\d*/gi, ' ')           // masked card numbers
    .replace(/\s+/g, ' ').trim();
  const unprefixed = s.replace(PROCESSOR, '');
  let toks = unprefixed.split(' ').filter(Boolean);
  // Everything from the first token containing a digit (store #, phone) on
  // is location noise: "PIZZA PALACE 555-0101 SOMETOWN TX" → "PIZZA PALACE".
  const cut = toks.findIndex((t, i) => i > 0 && /\d/.test(t));
  let tail = [];
  if (cut > 0){ tail = toks.slice(cut + 1); toks = toks.slice(0, cut); }
  if (toks.length > 1 && US_STATES.has(toks[toks.length - 1])) toks.pop();
  if (tail.length && US_STATES.has(tail[tail.length - 1])) tail.pop();
  return { name: toks.join(' '), city: tail.join(' ').toUpperCase(), withPrefix: s };
}

// Cities appear after the store number on most rows of a statement; learn
// them there, then strip them from rows that had no store number
// ("SQ *CORNER CAFE Sometown TX" → "CORNER CAFE").
function learnCities(rows){
  const cities = new Set();
  for (const r of rows){ const c = cleanParts(r.desc).city; if (c && c.length >= 3) cities.add(c); }
  return [...cities].sort((a, b) => b.length - a.length);
}
function merchantName(raw, cities){
  let { name } = cleanParts(raw);
  const up = name.toUpperCase();
  for (const c of cities){
    if (up.endsWith(' ' + c) && up.length > c.length + 1){ name = name.slice(0, name.length - c.length - 1).trim(); break; }
  }
  return name.replace(/[\s,.\-*]+$/, '');
}
const stmtKey = (raw, cities) => squash(merchantName(raw, cities)) || squash(raw);
const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (m, p, c) => p + c.toUpperCase());

// Payment rows: the Type column when the export has one (Robinhood), else
// the description (Citi: "ONLINE PAYMENT, THANK YOU").
const isPaymentRow = (r) => /payment/i.test(r.rtype || '') ||
  (!r.rtype && /\b(payment|autopay|auto pay|thank you)\b/i.test(r.desc || ''));

/* ── Learned statement names (persisted) ── */
const LEARN_CAP = 400;
// Recent entries outweigh old ones (half-life ~3 months), so re-filing a
// merchant (Steam: Entertainment → Steam) takes effect quickly.
const recency = (date) => Math.pow(0.5, Math.max(0, (Date.now() - new Date(date + 'T00:00:00')) / 86400000) / 90) || 0.0001;
function learnFromMatches(pairs, cities){
  const book = { ...(state.flags.stmtMerchants || {}) };
  const tally = {};
  for (const { csv, txn } of pairs){
    if (!['Expense','Refund','Income'].includes(txn.type) || !csv.desc) continue;
    const key = `${txn.type}|${stmtKey(csv.desc, cities)}`;
    const t = tally[key] || (tally[key] = { cats:{}, descs:{} });
    const w = recency(txn.date);
    if (txn.category) t.cats[txn.category] = (t.cats[txn.category] || 0) + w;
    const d = String(txn.description || '').trim();
    if (d) t.descs[d] = (t.descs[d] || 0) + w;
  }
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  let changed = false;
  for (const [key, t] of Object.entries(tally)){
    const entry = { c: top(t.cats), d: top(t.descs), at: Date.now() };
    const prev = book[key];
    if (!prev || prev.c !== entry.c || prev.d !== entry.d){ book[key] = entry; changed = true; }
    else prev.at = entry.at;
  }
  const keys = Object.keys(book);
  if (keys.length > LEARN_CAP){
    keys.sort((a, b) => (book[b].at || 0) - (book[a].at || 0)).slice(LEARN_CAP).forEach(k => delete book[k]);
    changed = true;
  }
  state.flags.stmtMerchants = book;
  if (changed) saveFlags().catch(e => console.warn('Saving learned statement names failed', e));
}

/* ── What an unmatched row would be added as ── */
function buildContext(isCharge, rows){
  const acct = state.accounts.find(a => a.name === recState.account);
  const acctType = acct?.type || 'Credit Card';
  const isDebtAcct = acctType === 'Credit Card' || acctType === 'Loan';
  const cities = learnCities(rows);
  // Usual pay-from account for payments to this card/loan.
  const from = {};
  for (const t of state.transactions){
    if ((t.type === 'CC Payment' || t.type === 'Loan Payment') && t.account === recState.account && t.fromAccount){
      from[t.fromAccount] = (from[t.fromAccount] || 0) + 1;
    }
  }
  const activeCash = state.accounts.filter(a => a.active && (a.type === 'Checking' || a.type === 'Savings')).map(a => a.name);
  const payFrom = Object.entries(from).filter(([n]) => activeCash.includes(n)).sort((a, b) => b[1] - a[1])[0]?.[0] || activeCash[0] || null;
  // The account's usual category over the last 120 days, per type — the
  // fallback for merchants we've never seen (a Restaurants card). Used when
  // it's a clear front-runner: ≥30% of the account's entries.
  const cutoff = toLocalISO(new Date(Date.now() - 120 * 86400000));
  const prior = {};
  for (const type of ['Expense', 'Income']){
    const counts = {}; let n = 0;
    for (const t of state.transactions){
      if (t.type !== type || t.account !== recState.account || !t.category || (t.date || '') < cutoff) continue;
      counts[t.category] = (counts[t.category] || 0) + 1; n++;
    }
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    prior[type] = best && best[1] / n >= 0.3 ? best[0] : null;
  }
  return { acctType, isDebtAcct, isCharge, cities, payFrom, prior, book: state.flags.stmtMerchants || {} };
}

function guessRow(r, ctx){
  const charge = ctx.isCharge(r);
  if (isPaymentRow(r)){
    if (ctx.isDebtAcct && !charge){
      const type = ctx.acctType === 'Loan' ? 'Loan Payment' : 'CC Payment';
      const cats = state.categories[type === 'Loan Payment' ? 'LoanPayment' : 'CCPayment'] || [];
      return { kind: ctx.payFrom ? 'inline' : 'form', type, category: cats[0] || type, description: '', fromAccount: ctx.payFrom };
    }
    if (!ctx.isDebtAcct && charge) return { kind: 'form', type: 'CC Payment' };  // checking paying some card
  }
  const type = charge ? 'Expense' : (ctx.isDebtAcct ? 'Refund' : 'Income');
  const catKey = type === 'Expense' ? 'Expense' : type;
  const list = state.categories[catKey] || [];
  const valid = (c) => c && list.includes(c);
  const name = merchantName(r.desc, ctx.cities);
  const learned = ctx.book[`${type}|${stmtKey(r.desc, ctx.cities)}`];
  let category = null, description = null, source = null;
  if (learned){
    if (valid(learned.c)) category = learned.c;
    description = learned.d;
    source = 'learned';
  }
  if (!category || !description){
    const m = lookupMerchant(name) || findMerchantFuzzy(name) || findMerchantFuzzy(r.desc);
    if (m){
      const mc = type === 'Expense' ? m.expenseCategory : (m.type === type ? m.category : null);
      if (!category && valid(mc)){ category = mc; source = source || 'merchant'; }
      if (!description) description = m.display;
    }
  }
  if (!category){
    if (type === 'Expense' && valid(ctx.prior.Expense)){ category = ctx.prior.Expense; source = source || 'account'; }
    else if (type === 'Income' && valid(ctx.prior.Income)) category = ctx.prior.Income;
    else if (type === 'Refund') category = ['Return', 'Purchase Refund'].find(valid) || list[0];
    else category = valid('Misc') ? 'Misc' : list[0];
  }
  if (!description) description = titleCase(name || r.desc || '');
  return { kind: 'inline', type, category, description, source };
}

/* ─── Diff ─────────────────────────── */
// Posting-date lag: a LOOSE second pass matches on amount alone within
// ±LOOSE_WIN days — wide enough for slow merchants (real data showed an
// 11-day lag), narrow enough that a $20 monthly subscription can't match
// across billing cycles.
const LOOSE_WIN = 14;

function runDiff(){
  const win = recState.window;
  const rows = recState.rows || [];
  if (!rows.length) return null;

  // Charge-sign detection: most rows on a statement are charges/debits, so
  // the majority sign = charges. flipSigns inverts the call.
  const pos = rows.filter(r => r.amount > 0).length;
  let chargesPositive = pos >= rows.length - pos;
  if (recState.flipSigns) chargesPositive = !chargesPositive;
  const isCharge = (r) => chargesPositive ? r.amount > 0 : r.amount < 0;

  const dates = rows.map(r => r.date).sort();
  const stmtFrom = dates[0], stmtTo = dates[dates.length - 1];
  const pad = Math.max(win, LOOSE_WIN);
  const from = shiftISO(stmtFrom, -pad);
  const to = shiftISO(stmtTo, pad);

  // Ledger side: every txn touching this account in the padded range.
  // Unmatched ledger txns are only *reported* inside the unpadded range.
  const ledger = state.transactions.filter(t =>
    t.date && t.date >= from && t.date <= to &&
    (t.account === recState.account || t.fromAccount === recState.account)
  );

  // Per |amount| bucket, both sides by date; each CSV row takes the EARLIEST
  // unused ledger txn within the window (earliest-eligible, not nearest —
  // nearest-first breaks chains of identical small charges).
  const buckets = new Map();
  for (const t of ledger){
    const k = Math.abs(toCents(t.amount));
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(t);
  }
  for (const list of buckets.values()) list.sort((a,b) => a.date.localeCompare(b.date));

  const takeWithin = (r, tolerance) => {
    const k = Math.abs(toCents(r.amount));
    const list = buckets.get(k) || [];
    for (const t of list){
      if (Math.abs(daysBetween(t.date, r.date)) <= tolerance){
        buckets.set(k, list.filter(x => x !== t));
        return t;
      }
    }
    return null;
  };

  const matched = [], loose = [];
  const remaining = [];
  for (const r of [...rows].sort((a,b) => a.date.localeCompare(b.date))){
    const hit = takeWithin(r, win);
    if (hit) matched.push({ csv: r, txn: hit });
    else remaining.push(r);
  }
  let csvOnly = [];
  for (const r of remaining){
    const hit = win >= LOOSE_WIN ? null : takeWithin(r, LOOSE_WIN);
    if (hit) loose.push({ csv: r, txn: hit, lag: daysBetween(hit.date, r.date) });
    else csvOnly.push(r);
  }

  // Cancel-pair collapse: a charge and its refund (same |amount|, opposite
  // sign, ≤45 days) that BOTH lack a ledger match net to zero.
  const canceled = [];
  {
    const sorted = csvOnly.slice().sort((a,b) => a.date.localeCompare(b.date));
    const used = new Set();
    for (let i = 0; i < sorted.length; i++){
      if (used.has(i)) continue;
      for (let j = i + 1; j < sorted.length; j++){
        if (used.has(j)) continue;
        const a = sorted[i], b = sorted[j];
        if (Math.abs(toCents(a.amount)) === Math.abs(toCents(b.amount)) &&
            isCharge(a) !== isCharge(b) && !isPaymentRow(a) && !isPaymentRow(b) &&
            Math.abs(daysBetween(a.date, b.date)) <= 45){
          canceled.push({ charge: isCharge(a) ? a : b, refund: isCharge(a) ? b : a });
          used.add(i); used.add(j);
          break;
        }
      }
    }
    csvOnly = sorted.filter((_, i) => !used.has(i));
  }
  const ledgerOnly = [...buckets.values()].flat()
    .filter(t => t.date >= stmtFrom && t.date <= stmtTo)
    .sort((a,b) => (a.date||'').localeCompare(b.date||''));

  // Totals check: statement net vs the ledger's balance movement for this
  // account over the same period (sign-aware via txnEffects).
  let stmtNetC = 0;
  for (const r of rows) stmtNetC += toCents(chargesPositive ? r.amount : -r.amount);
  const aType = acctTypeMap();
  const isDebtAcct = ['Credit Card', 'Loan'].includes(aType[recState.account]);
  let ledgerNetC = 0;
  for (const t of state.transactions){
    if (!t.date || t.date < stmtFrom || t.date > stmtTo) continue;
    const eff = txnEffectsCents(t, aType);
    if (eff[recState.account]) ledgerNetC += eff[recState.account];
  }
  // Cash accounts: a charge LOWERS the balance, so compare money-out terms.
  if (!isDebtAcct) ledgerNetC = -ledgerNetC;
  const totals = { stmtNet: fromCents(stmtNetC), ledgerNet: fromCents(ledgerNetC), diff: fromCents(stmtNetC - ledgerNetC) };

  // NEW(v3.0): learn names from everything that matched, then guess.
  learnFromMatches([...matched, ...loose], learnCities(rows));
  const ctx = buildContext(isCharge, rows);
  const guesses = new Map(csvOnly.map(r => [r, guessRow(r, ctx)]));

  return { matched, loose, csvOnly, ledgerOnly, canceled, from: stmtFrom, to: stmtTo, isCharge, chargesPositive, totals, ctx, guesses };
}

function shiftISO(iso, days){
  const d = new Date(iso + 'T00:00:00');
  return toLocalISO(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}

/* ─── Corrections ─────────────────────────────
   fixDate: aligns a loose-matched ledger txn's date to the statement's
   posted date, so it strict-matches forever after.
   addPair: logs both sides of a canceled charge+refund pair. Balances are
   derived (v3.0), so neither needs any balance repair. */
async function fixDate(m){
  m.txn.date = m.csv.date;
  await dbPut('transactions', m.txn);
  state.transactions.sort((a,b) => (b.date||'').localeCompare(a.date||''));
}

async function addFromRow(r, guess, categoryOverride){
  const txn = {
    id: uid(),
    date: r.date,
    type: guess.type,
    account: recState.account,
    category: categoryOverride || guess.category,
    description: guess.description || '',
    amount: round2(Math.abs(r.amount)),
    fromAccount: guess.fromAccount || null
  };
  await dbPut('transactions', txn);
  state.transactions.push(txn);
  state.transactions.sort((a,b) => (b.date||'').localeCompare(a.date||''));
  invalidateMerchantCache();
  return txn;
}

async function undoInlineAdd(txn){
  await dbDel('transactions', txn.id);
  state.transactions = state.transactions.filter(t => t.id !== txn.id);
  invalidateMerchantCache();
}

async function addPair(p, ctx){
  const g1 = guessRow(p.charge, ctx);
  const g2 = { ...guessRow(p.refund, ctx), description: g1.description };
  for (const [side, g] of [[p.charge, g1], [p.refund, g2]]){
    const t = {
      id: uid(), date: side.date, type: g.type, account: recState.account,
      category: g.category, description: g.description || '',
      amount: round2(Math.abs(side.amount)), fromAccount: null
    };
    // The refund gives back to the charge's budget category.
    if (t.type === 'Refund' && g1.type === 'Expense') t.offsetCategory = g1.category;
    await dbPut('transactions', t);
    state.transactions.push(t);
  }
  state.transactions.sort((a,b) => (b.date||'').localeCompare(a.date||''));
}

const guessLabel = (g) => {
  if (g.kind === 'form') return 'payment · opens the Add form';
  if (g.type === 'CC Payment' || g.type === 'Loan Payment') return `${g.type} from ${g.fromAccount}`;
  return `${g.type} · ${g.category}${g.description ? ' · “' + g.description + '”' : ''}`;
};

function renderResults(){
  const diff = runDiff();
  const options = state.accounts.filter(a => a.active);
  if (!diff){ renderSetup(options); return; }
  const { matched, loose, csvOnly, ledgerOnly, canceled, from, to, isCharge, totals, ctx, guesses } = diff;
  const csvOnlySum = sumMoney(csvOnly, r => Math.abs(r.amount));
  const ledgerOnlySum = sumMoney(ledgerOnly, t => t.amount);
  const clean = csvOnly.length === 0 && ledgerOnly.length === 0;
  const totalsClean = Math.abs(totals.diff) < 0.005;
  const inlineRows = csvOnly.filter(r => guesses.get(r).kind === 'inline');

  $('#sheetBody').innerHTML = `
    <h2>Reconcile · ${esc(recState.account)}</h2>
    <div class="muted small" style="margin-bottom:10px;">
      ${esc(recState.fileName)} · ${recState.rows.length} statement rows · ledger ${from} → ${to} · ±${recState.window}d
    </div>

    <div class="rec-stats">
      <div class="rec-stat"><div class="v" style="color:var(--green);">${matched.length}${loose.length ? `<span style="font-size:13px;">+${loose.length}</span>` : ''}</div><div class="l">Matched</div></div>
      <div class="rec-stat"><div class="v" style="color:${csvOnly.length ? 'var(--amber)' : 'var(--text)'};">${csvOnly.length}</div><div class="l">Statement only</div></div>
      <div class="rec-stat"><div class="v" style="color:${ledgerOnly.length ? 'var(--amber)' : 'var(--text)'};">${ledgerOnly.length}</div><div class="l">Ledger only</div></div>
    </div>

    <div class="card" style="margin-bottom:12px;padding:12px 14px;">
      <div class="rb-row" style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;"><span class="muted">Statement net (${ctx.isDebtAcct ? 'charges − credits' : 'money out − in'})</span><span class="mono">${fmt(totals.stmtNet)}</span></div>
      <div class="rb-row" style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;"><span class="muted">Ledger net, same period</span><span class="mono">${fmt(totals.ledgerNet)}</span></div>
      <div class="rb-row" style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;border-top:1px solid var(--line);margin-top:4px;padding-top:7px;"><span style="font-weight:500;">Difference</span><span class="mono" style="color:${totalsClean ? 'var(--green)' : 'var(--amber)'};">${totalsClean ? '✓ $0.00' : fmt(totals.diff)}</span></div>
      ${!totalsClean ? `<div class="muted small" style="margin-top:8px;line-height:1.5;">The unmatched lists below usually explain a difference. Charges that straddle the statement boundary (logged in this period, posted in the next) contribute too — they show as ledger-only here and match next cycle.</div>` : ''}
    </div>

    ${clean ? `<div class="debt-good" style="margin-bottom:12px;">✓ Fully reconciled — every statement row has a ledger match.</div>` : ''}

    ${csvOnly.length || ledgerOnly.length ? `<div class="rc-pair">
    <div class="rc-col">
    ${csvOnly.length ? `
      <div class="section-label">On statement, not in ledger · ${fmt(csvOnlySum)}</div>
      <div class="muted small" style="margin-bottom:8px;line-height:1.5;"><b>Add</b> logs it as shown (names and categories learned from rows you've already matched). Tap the row to pick a different category.</div>
      ${csvOnly.map((r, i) => {
        const g = guesses.get(r);
        return `
        <div class="rec-row rc-pickcat" data-i="${i}" style="cursor:pointer;">
          <div style="min-width:0;flex:1;">
            <div style="font-size:13.5px;font-weight:500;">${fmt(Math.abs(r.amount))} <span class="muted small">· ${isCharge(r) ? (ctx.isDebtAcct ? 'charge' : 'debit') : (ctx.isDebtAcct ? 'credit' : 'deposit')}${r.pending ? ' · pending' : ''}</span></div>
            <div class="muted small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.date)}${r.desc ? ' · ' + esc(r.desc) : ''}</div>
            <div class="rc-guess">→ ${esc(guessLabel(g))}</div>
          </div>
          <button class="btn secondary rc-add" data-i="${i}" style="width:auto;padding:8px 14px;font-size:12px;flex-shrink:0;">Add</button>
        </div>`;
      }).join('')}
      ${inlineRows.length > 1 ? `<button class="btn ghost" id="rc-add-all" style="margin-top:4px;margin-bottom:6px;font-size:12.5px;padding:10px;">Add all ${inlineRows.length} as shown</button>` : ''}
    ` : `<div class="section-label">On statement, not in ledger</div><div class="muted small">None.</div>`}
    </div>
    <div class="rc-col">
    ${ledgerOnly.length ? `
      <div class="section-label">In ledger, not on statement · ${fmt(ledgerOnlySum)}</div>
      <div class="muted small" style="margin-bottom:8px;line-height:1.5;">Pending charges that haven't posted yet often land here — widen the tolerance or re-check after the statement updates. A wrong amount shows up as one row on each side.</div>
      ${ledgerOnly.map(t => `
        <div class="rec-row rc-jump" data-id="${esc(t.id)}" style="cursor:pointer;">
          <div style="min-width:0;flex:1;">
            <div style="font-size:13.5px;font-weight:500;">${fmt(t.amount)} <span class="muted small">· ${esc(t.type)}</span></div>
            <div class="muted small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(t.date)} · ${esc(t.category || '')}${t.description ? ' · ' + esc(t.description) : ''}</div>
          </div>
          <span class="arrow">›</span>
        </div>
      `).join('')}
    ` : `<div class="section-label">In ledger, not on statement</div><div class="muted small">None.</div>`}
    </div>
    </div>` : ''}

    ${loose.length ? `
      <div class="section-label">Matched on amount only · posting lag</div>
      <div class="muted small" style="margin-bottom:8px;line-height:1.5;">Same amount, dates further apart than ±${recState.window}d — normal when a charge posts late. <b>Fix date</b> sets the ledger entry to the statement's posted date so it matches cleanly next time.</div>
      ${loose.map((m, i) => `
        <div class="rec-row">
          <div style="min-width:0;flex:1;">
            <div style="font-size:13.5px;font-weight:500;">${fmt(Math.abs(m.csv.amount))} <span class="muted small">· logged ${esc(m.txn.date)}, posted ${esc(m.csv.date)} (${Math.abs(m.lag)}d)</span></div>
            <div class="muted small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m.csv.desc || m.txn.description || m.txn.category || '')}</div>
          </div>
          <button class="btn secondary rc-fixdate" data-i="${i}" style="width:auto;padding:8px 12px;font-size:12px;flex-shrink:0;">Fix date</button>
        </div>
      `).join('')}
      ${loose.length > 1 ? `<button class="btn ghost" id="rc-fix-all" style="margin-top:4px;margin-bottom:6px;font-size:12.5px;padding:10px;">Fix all ${loose.length} dates</button>` : ''}
    ` : ''}

    ${canceled.length ? `
      <div class="section-label">Canceled out on statement · ${canceled.length} pair${canceled.length===1?'':'s'}</div>
      <div class="muted small" style="margin-bottom:8px;line-height:1.5;">Charge + refund pairs that net to zero — returned purchases that were never logged. <b>Add</b> logs both sides so the ledger mirrors the statement; balances don't change.</div>
      ${canceled.map((p, i) => `
        <div class="rec-row">
          <div style="min-width:0;flex:1;">
            <div style="font-size:13px;">${fmt(Math.abs(p.charge.amount))} on ${esc(p.charge.date)} ↺ refunded ${esc(p.refund.date)}</div>
            <div class="muted small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(p.charge.desc || p.refund.desc || '')}</div>
          </div>
          <button class="btn secondary rc-addpair" data-i="${i}" style="width:auto;padding:8px 12px;font-size:12px;flex-shrink:0;">Add</button>
        </div>
      `).join('')}
      ${canceled.length > 1 ? `<button class="btn ghost" id="rc-addpair-all" style="margin-top:4px;margin-bottom:6px;font-size:12.5px;padding:10px;">Add all ${canceled.length} pairs (${canceled.length*2} transactions)</button>` : ''}
    ` : ''}

    ${matched.length ? `<button class="btn ghost" id="rc-show-matched" style="margin-top:12px;">Show ${matched.length} matched</button><div id="rc-matched"></div>` : ''}

    <div style="display:flex;gap:8px;margin-top:14px;">
      <button class="btn ghost" id="rc-flip" style="flex:1;font-size:12.5px;padding:10px;">Charges look wrong? Flip signs</button>
      <button class="btn ghost" id="rc-back" style="width:auto;padding:10px 16px;font-size:12.5px;">Back</button>
    </div>
  `;

  const openFormFor = (r, g) => {
    resetAddForm({
      type: g.type || 'CC Payment',
      date: r.date,
      amount: Math.abs(r.amount).toFixed(2),
      ...(ctx.isDebtAcct ? { account: recState.account, accountTouched: true } : { fromAccount: recState.account })
    });
    closeSheet();
    navigate('add');
    toast('Pre-filled from statement');
  };
  const addOne = async (r, category) => {
    const g = guesses.get(r);
    if (g.kind === 'form'){ openFormFor(r, g); return; }
    const txn = await addFromRow(r, g, category);
    haptic(15);
    renderResults();
    toastAction(`Added ${fmt(txn.amount)} · ${txn.category}`, 'Undo', async () => {
      await undoInlineAdd(txn);
      renderResults();
    });
  };

  $$('.rc-add').forEach(b => b.addEventListener('click', busyGuard(async (e) => {
    e.stopPropagation(); // the row underneath opens the category picker
    const r = csvOnly[Number(b.dataset.i)];
    if (r) await addOne(r);
  })));
  // Row tap: pick the category yourself, still without leaving the sheet.
  $$('.rc-pickcat').forEach(el => el.addEventListener('click', () => {
    const r = csvOnly[Number(el.dataset.i)];
    if (!r) return;
    const g = guesses.get(r);
    if (g.kind === 'form' || g.type === 'CC Payment' || g.type === 'Loan Payment'){ addOne(r); return; }
    const cats = state.categories[g.type] || [];
    if (!cats.length) return;
    openPicker(`Category · ${r.desc ? r.desc.slice(0, 30) : fmt(Math.abs(r.amount))}`, cats, g.category, busyGuard((cat) => addOne(r, cat)));
  }));
  $('#rc-add-all')?.addEventListener('click', busyGuard(async () => {
    if (!confirm(`Add ${inlineRows.length} transactions exactly as shown?\n\nEdit any of them later from Activity.`)) return;
    const added = [];
    for (const r of inlineRows) added.push(await addFromRow(r, guesses.get(r)));
    haptic(15);
    renderResults();
    toastAction(`Added ${added.length} transactions`, 'Undo', async () => {
      for (const t of added) await undoInlineAdd(t);
      renderResults();
    });
  }));
  $$('.rc-jump').forEach(el => el.addEventListener('click', () => {
    openTxnSheet(el.dataset.id); // re-uses the sheet; Back not preserved by design
  }));
  $$('.rc-fixdate').forEach(b => b.addEventListener('click', busyGuard(async () => {
    const m = loose[Number(b.dataset.i)];
    if (!m) return;
    await fixDate(m);
    invalidateMerchantCache();
    haptic(15);
    toast(`Date set to ${m.csv.date}`);
    renderResults();
  })));
  $('#rc-fix-all')?.addEventListener('click', busyGuard(async () => {
    if (!confirm(`Set ${loose.length} ledger dates to their statement posted dates?`)) return;
    for (const m of loose) await fixDate(m);
    invalidateMerchantCache();
    haptic(15);
    toast(`Fixed ${loose.length} dates`);
    renderResults();
  }));
  $$('.rc-addpair').forEach(b => b.addEventListener('click', busyGuard(async () => {
    const p = canceled[Number(b.dataset.i)];
    if (!p) return;
    await addPair(p, ctx);
    invalidateMerchantCache();
    haptic(15);
    toast('Added charge + refund');
    renderResults();
  })));
  $('#rc-addpair-all')?.addEventListener('click', busyGuard(async () => {
    if (!confirm(`Add ${canceled.length} charge + refund pairs (${canceled.length*2} transactions)?\n\nAmounts cancel, so balances don't change. Edit any of them later.`)) return;
    for (const p of canceled) await addPair(p, ctx);
    invalidateMerchantCache();
    haptic(15);
    toast(`Added ${canceled.length*2} transactions`);
    renderResults();
  }));
  $('#rc-show-matched')?.addEventListener('click', () => {
    const host = $('#rc-matched');
    // v3.1: statement side ↔ your side, aligned (two columns unfolded).
    host.innerHTML = `<div class="rc-match-head"><span>Statement</span><span>Your ledger</span></div>` + matched.map(m => `
      <div class="rec-row rc-match-row" style="opacity:.75;">
        <div class="rc-side">
          <div style="font-size:13px;">${fmt(Math.abs(m.csv.amount))} · ${esc(m.csv.date)}</div>
          <div class="muted small rc-ell">${esc(m.csv.desc || '—')}</div>
        </div>
        <div class="rc-side">
          <div style="font-size:13px;">${esc(m.txn.date)} · ${esc(m.txn.category || m.txn.type)}</div>
          <div class="muted small rc-ell">${esc(m.txn.description || '—')}</div>
        </div>
        <span style="color:var(--green);flex-shrink:0;">✓</span>
      </div>
    `).join('');
    $('#rc-show-matched').style.display = 'none';
  });
  $('#rc-flip').addEventListener('click', () => {
    recState.flipSigns = !recState.flipSigns;
    renderResults();
  });
  $('#rc-back').addEventListener('click', () => renderSetup(options));
}
