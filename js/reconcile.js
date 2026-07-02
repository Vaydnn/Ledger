/* ============================================================
   reconcile.js — NEW(v2.0): CSV statement reconciliation.

   Replaces the monthly "compare the JSON and the CSV by hand"
   ritual. Pick an account (defaults to RH CC), drop in the bank's
   CSV export, and the ledger is diffed against the statement:

     ✓ Matched        — same amount (to the cent), dates within the
                        tolerance window (default ±3 days, adjustable
                        — CC posting dates drift from purchase dates)
     ⚠ Statement only — on the statement, missing from the ledger
                        → one tap pre-fills the Add form
     ⚠ Ledger only    — logged here, not on the statement
                        → tap to open the transaction

   Matching is greedy on |amount| in cents, nearest-date-first, each
   row matched at most once. Sign convention is auto-detected (most
   rows on a CC statement are charges) and can be flipped manually.

   CSV parsing rides on SheetJS (already loaded for xlsx import), so
   quoted fields, BOMs, and weird delimiters are handled for free.
   Columns are auto-detected from the header row: date, amount (or
   debit/credit pair), and description/merchant.
   ============================================================ */

import { $, $$, fmt, toast, esc, toCents, fromCents, round2, toLocalISO, daysBetween, sumMoney, uid, haptic } from './util.js';
import { state, dbPut } from './db.js';
import { acctTypeMap, txnEffectsCents } from './effects.js';
import { openSheet, closeSheet, openPicker } from './sheet.js';
import { cascadeForChange } from './balances.js';
import { invalidateMerchantCache, lookupMerchant } from './merchants.js';
import { addForm } from './add.js';
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
  const ccs = state.accounts.filter(a => a.active && (a.type === 'Credit Card' || a.type === 'Loan'));
  const all = state.accounts.filter(a => a.active);
  const options = [...ccs, ...all.filter(a => !ccs.includes(a))]; // debt accounts first
  if (!options.length){ toast('No accounts to reconcile'); return; }
  if (!recState.account || !options.find(a => a.name === recState.account)){
    // FIX(v2.9.1): default to the busiest account instead of a hardcoded
    // personal account name (this repo is public).
    const usage = {};
    for (const t of state.transactions){
      if (t.account) usage[t.account] = (usage[t.account] || 0) + 1;
    }
    recState.account = [...options].sort((a, b) => (usage[b.name] || 0) - (usage[a.name] || 0))[0].name;
  }
  renderSetup(options);
  openSheet();
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
  $('#rc-rerun')?.addEventListener('click', () => renderResults(options));
}

function pickFile(){
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv';
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
      const opts = state.accounts.filter(a => a.active);
      renderResults(opts);
    } catch(e){
      console.error(e);
      toast('Could not read that CSV: ' + (e.message || 'unknown error'));
    }
  };
  input.click();
}

/* ─── CSV parsing ─────────────────────────── */
function parseStatementCSV(text){
  if (typeof XLSX === 'undefined') throw new Error('parser not loaded');
  const wb = XLSX.read(text, { type:'string', raw:true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(ws, { header:1, raw:true, defval:'' });

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
    // Declined/failed/reversed rows appear in some exports (Robinhood
    // includes declined retries) but never touched the balance — skip them
    // or they show up as phantom "statement only" duplicates.
    const status = cols.status != null ? String(r[cols.status] ?? '').trim() : '';
    if (/declin|fail|cancel|revers/i.test(status)) continue;
    const date = parseCSVDate(r[cols.date]);
    if (!date) continue;
    let amount;
    if (cols.amount != null){
      amount = parseCSVAmount(r[cols.amount]);
    } else {
      // Separate Debit / Credit columns: debits are charges (positive),
      // credits are payments/refunds (negative).
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
  let desc = find(/description|merchant|^name$|payee|^memo$|details/i);
  return {
    date,
    amount: amount >= 0 ? amount : null,
    debit: debit >= 0 ? debit : null,
    credit: credit >= 0 ? credit : null,
    desc: desc >= 0 ? desc : null,
    status: find(/^status$/i) >= 0 ? find(/^status$/i) : null,   // pending / declined
    type: find(/^type$|transaction\s*type/i) >= 0 ? find(/^type$|transaction\s*type/i) : null // purchase / payment / refund
  };
}

function parseCSVDate(v){
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return toLocalISO(v);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);                 // YYYY-MM-DD
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);            // M/D/YY[YY]
  if (m){
    let y = Number(m[3]); if (y < 100) y += 2000;
    return `${y}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  }
  if (typeof v === 'number' && v > 30000 && v < 60000){        // Excel serial
    const d = new Date(Math.round((v - 25569) * 86400000));
    return d.toISOString().slice(0,10);
  }
  return null;
}

function parseCSVAmount(v){
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/[$,\s]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)){ neg = true; s = s.slice(1, -1); }   // (12.34) accounting style
  const n = parseFloat(s);
  if (isNaN(n)) return NaN;
  return neg ? -n : n;
}

/* ─── Diff + results ─────────────────────────── */
// Posting-date lag: charges logged instantly in the ledger can post to the
// statement days later. The strict pass uses the user-picked window; anything
// left over gets a LOOSE second pass that matches on amount alone within
// ±LOOSE_WIN days — wide enough for slow merchants (real data showed an
// 11-day lag), narrow enough that a $20 monthly subscription can't match
// across billing cycles.
const LOOSE_WIN = 14;

function runDiff(){
  const win = recState.window;
  const rows = recState.rows || [];
  if (!rows.length) return null;

  // Charge-sign detection: on a CC statement most rows are charges, so the
  // majority sign = charges. flipSigns inverts the call.
  const pos = rows.filter(r => r.amount > 0).length;
  let chargesPositive = pos >= rows.length - pos;
  if (recState.flipSigns) chargesPositive = !chargesPositive;
  const isCharge = (r) => chargesPositive ? r.amount > 0 : r.amount < 0;

  const dates = rows.map(r => r.date).sort();
  const stmtFrom = dates[0], stmtTo = dates[dates.length - 1];
  const pad = Math.max(win, LOOSE_WIN);
  const from = shiftISO(stmtFrom, -pad);
  const to = shiftISO(stmtTo, pad);

  // Ledger side: every txn touching this account in the padded range. The
  // padding exists so statement rows near the cycle edges can still match;
  // unmatched ledger txns are only *reported* if they fall inside the
  // unpadded statement range (margin txns belong to the adjacent cycle).
  const ledger = state.transactions.filter(t =>
    t.date && t.date >= from && t.date <= to &&
    (t.account === recState.account || t.fromAccount === recState.account)
  );

  // Matching, per |amount| bucket: both sides sorted by date, each CSV row
  // takes the EARLIEST unused ledger txn within the window. Earliest-eligible
  // (not nearest) is what makes this optimal — with same-amount clusters
  // (e.g. a string of identical small charges), nearest-first steals a txn
  // that a later row needed and breaks the chain.
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
  let remaining = [];
  // Pass 1: strict (amount + date window)
  for (const r of [...rows].sort((a,b) => a.date.localeCompare(b.date))){
    const hit = takeWithin(r, win);
    if (hit) matched.push({ csv: r, txn: hit });
    else remaining.push(r);
  }
  // Pass 2: loose (amount only, within ±LOOSE_WIN) — catches posting-date
  // lag beyond the strict window. Surfaced separately so a glance confirms
  // the pairing is sane.
  let csvOnly = [];
  for (const r of remaining){
    const hit = win >= LOOSE_WIN ? null : takeWithin(r, LOOSE_WIN);
    if (hit) loose.push({ csv: r, txn: hit, lag: daysBetween(hit.date, r.date) });
    else csvOnly.push(r);
  }

  // Pass 3: cancel-pair collapse. A charge and its refund (same |amount|,
  // opposite sign, within 45 days) that BOTH have no ledger match net to
  // zero — typically a returned purchase that was deliberately never logged.
  // Pull them out of the action list into their own group.
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
            isCharge(a) !== isCharge(b) &&
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

  // Totals check — the part that matters even when row-level dates are messy:
  // statement net (charges − credits) vs what the ledger says this account's
  // balance moved over the same period (sign-aware via txnEffects).
  let stmtNetC = 0;
  for (const r of rows) stmtNetC += toCents(chargesPositive ? r.amount : -r.amount);
  const aType = acctTypeMap();
  let ledgerNetC = 0;
  for (const t of state.transactions){
    if (!t.date || t.date < stmtFrom || t.date > stmtTo) continue;
    const eff = txnEffectsCents(t, aType);
    if (eff[recState.account]) ledgerNetC += eff[recState.account];
  }
  const totals = {
    stmtNet: fromCents(stmtNetC),
    ledgerNet: fromCents(ledgerNetC),
    diff: fromCents(stmtNetC - ledgerNetC)
  };

  return { matched, loose, csvOnly, ledgerOnly, canceled, from: stmtFrom, to: stmtTo, isCharge, chargesPositive, totals };
}

function shiftISO(iso, days){
  const d = new Date(iso + 'T00:00:00');
  return toLocalISO(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}

/* ─── NEW: one-tap corrections ─────────────────────────────
   fixDate: aligns a loose-matched ledger txn's date to the statement's
   posted date, so it strict-matches forever after. Balances re-cascade
   (a date change can move the txn across a month boundary).
   addPair: logs both sides of a canceled charge+refund pair — Expense +
   Refund, same amounts — so the ledger mirrors the statement. Net balance
   effect is zero. Categories come from merchant memory when it knows the
   merchant, otherwise sensible defaults (Misc / Return); editable later. */
async function fixDate(m){
  const old = { ...m.txn };
  m.txn.date = m.csv.date;
  await dbPut('transactions', m.txn);
  state.transactions.sort((a,b) => (b.date||'').localeCompare(a.date||''));
  await cascadeForChange(old, m.txn);
}

function defaultCat(type, desc){
  if (type === 'Expense'){
    // FIX(v2.1): merchant lookup is a nice-to-have for the category guess —
    // never let it abort the add (one malformed ledger row used to throw
    // here and the Add button silently did nothing).
    let m = null;
    try { m = desc ? lookupMerchant(desc) : null; } catch(e){ console.warn('merchant lookup failed', e); }
    const list = state.categories.Expense || [];
    if (m?.category && list.includes(m.category)) return m.category;
    return list.includes('Misc') ? 'Misc' : (list[0] || 'Misc');
  }
  const list = state.categories.Refund || [];
  if (list.includes('Return')) return 'Return';
  if (list.includes('Purchase Refund')) return 'Purchase Refund';
  return list[0] || 'Return';
}

async function addPair(p){
  const mk = (side, type) => ({
    id: uid(),
    date: side.date,
    type,
    account: recState.account,
    category: defaultCat(type, side.desc),
    description: (side.desc || '').trim(),
    amount: round2(Math.abs(side.amount)),
    fromAccount: null
  });
  for (const t of [mk(p.charge, 'Expense'), mk(p.refund, 'Refund')]){
    await dbPut('transactions', t);
    state.transactions.push(t);
    await cascadeForChange(null, t);
  }
  state.transactions.sort((a,b) => (b.date||'').localeCompare(a.date||''));
}

function renderResults(options){
  const diff = runDiff();
  if (!diff){ renderSetup(options); return; }
  const { matched, loose, csvOnly, ledgerOnly, canceled, from, to, isCharge, totals } = diff;
  const csvOnlySum = sumMoney(csvOnly, r => Math.abs(r.amount));
  const ledgerOnlySum = sumMoney(ledgerOnly, t => t.amount);
  const clean = csvOnly.length === 0 && ledgerOnly.length === 0;
  const totalsClean = Math.abs(totals.diff) < 0.005;

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
      <div class="rb-row" style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;"><span class="muted">Statement net (charges − credits)</span><span class="mono">${fmt(totals.stmtNet)}</span></div>
      <div class="rb-row" style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;"><span class="muted">Ledger net, same period</span><span class="mono">${fmt(totals.ledgerNet)}</span></div>
      <div class="rb-row" style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;border-top:1px solid var(--line);margin-top:4px;padding-top:7px;"><span style="font-weight:500;">Difference</span><span class="mono" style="color:${totalsClean ? 'var(--green)' : 'var(--amber)'};">${totalsClean ? '✓ $0.00' : fmt(totals.diff)}</span></div>
      ${!totalsClean ? `<div class="muted small" style="margin-top:8px;line-height:1.5;">The unmatched lists below usually explain a difference. Charges that straddle the statement boundary (logged in this period, posted in the next) contribute too — they show as ledger-only here and match next cycle.</div>` : ''}
    </div>

    ${clean ? `<div class="debt-good" style="margin-bottom:12px;">✓ Fully reconciled — every statement row has a ledger match.</div>` : ''}

    ${loose.length ? `
      <div class="muted small" style="text-transform:uppercase;letter-spacing:.14em;margin:14px 0 8px;">Matched on amount only · posting lag</div>
      <div class="muted small" style="margin-bottom:8px;line-height:1.5;">Same amount, dates further apart than ±${recState.window}d — normal when a charge posts late. <b>Fix date</b> sets the ledger entry to the statement's posted date so it matches cleanly next time.</div>
      ${loose.map((m, i) => `
        <div class="rec-row">
          <div style="min-width:0;flex:1;">
            <div style="font-size:13.5px;font-weight:500;">${fmt(Math.abs(m.csv.amount))} <span class="muted small">· logged ${m.txn.date}, posted ${m.csv.date} (${Math.abs(m.lag)}d)</span></div>
            <div class="muted small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m.csv.desc || m.txn.description || m.txn.category || '')}</div>
          </div>
          <button class="btn secondary rc-fixdate" data-i="${i}" style="width:auto;padding:8px 12px;font-size:12px;flex-shrink:0;">Fix date</button>
        </div>
      `).join('')}
      ${loose.length > 1 ? `<button class="btn ghost" id="rc-fix-all" style="margin-top:4px;margin-bottom:6px;font-size:12.5px;padding:10px;">Fix all ${loose.length} dates</button>` : ''}
    ` : ''}

    ${csvOnly.length ? `
      <div class="muted small" style="text-transform:uppercase;letter-spacing:.14em;margin:14px 0 8px;">On statement, not in ledger · ${fmt(csvOnlySum)}</div>
      ${csvOnly.map((r, i) => `
        <div class="rec-row">
          <div style="min-width:0;flex:1;">
            <div style="font-size:13.5px;font-weight:500;">${fmt(Math.abs(r.amount))} <span class="muted small">· ${isCharge(r) ? 'charge' : 'credit'}${r.pending ? ' · pending' : ''}</span></div>
            <div class="muted small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${r.date}${r.desc ? ' · ' + esc(r.desc) : ''}</div>
          </div>
          <button class="btn secondary rc-add" data-i="${i}" style="width:auto;padding:8px 14px;font-size:12px;flex-shrink:0;">Add</button>
        </div>
      `).join('')}
    ` : ''}

    ${canceled.length ? `
      <div class="muted small" style="text-transform:uppercase;letter-spacing:.14em;margin:14px 0 8px;">Canceled out on statement · ${canceled.length} pair${canceled.length===1?'':'s'}</div>
      <div class="muted small" style="margin-bottom:8px;line-height:1.5;">Charge + refund pairs that net to zero — returned purchases that were never logged. <b>Add</b> logs both sides (Expense + Refund, same amounts) so the ledger mirrors the statement; balances don't change.</div>
      ${canceled.map((p, i) => `
        <div class="rec-row">
          <div style="min-width:0;flex:1;">
            <div style="font-size:13px;">${fmt(Math.abs(p.charge.amount))} on ${p.charge.date} ↺ refunded ${p.refund.date}</div>
            <div class="muted small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(p.charge.desc || p.refund.desc || '')}</div>
          </div>
          <button class="btn secondary rc-addpair" data-i="${i}" style="width:auto;padding:8px 12px;font-size:12px;flex-shrink:0;">Add</button>
        </div>
      `).join('')}
      ${canceled.length > 1 ? `<button class="btn ghost" id="rc-addpair-all" style="margin-top:4px;margin-bottom:6px;font-size:12.5px;padding:10px;">Add all ${canceled.length} pairs (${canceled.length*2} transactions)</button>` : ''}
    ` : ''}

    ${ledgerOnly.length ? `
      <div class="muted small" style="text-transform:uppercase;letter-spacing:.14em;margin:14px 0 8px;">In ledger, not on statement · ${fmt(ledgerOnlySum)}</div>
      <div class="muted small" style="margin-bottom:8px;line-height:1.5;">Pending charges that haven't posted yet often land here — widen the tolerance or re-check after the statement updates. A wrong amount shows up as one row on each side.</div>
      ${ledgerOnly.map(t => `
        <div class="rec-row rc-jump" data-id="${t.id}" style="cursor:pointer;">
          <div style="min-width:0;flex:1;">
            <div style="font-size:13.5px;font-weight:500;">${fmt(t.amount)} <span class="muted small">· ${esc(t.type)}</span></div>
            <div class="muted small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${t.date} · ${esc(t.category || '')}${t.description ? ' · ' + esc(t.description) : ''}</div>
          </div>
          <span class="arrow">›</span>
        </div>
      `).join('')}
    ` : ''}

    ${matched.length ? `<button class="btn ghost" id="rc-show-matched" style="margin-top:12px;">Show ${matched.length} matched</button><div id="rc-matched"></div>` : ''}

    <div style="display:flex;gap:8px;margin-top:14px;">
      <button class="btn ghost" id="rc-flip" style="flex:1;font-size:12.5px;padding:10px;">Charges look wrong? Flip signs</button>
      <button class="btn ghost" id="rc-back" style="width:auto;padding:10px 16px;font-size:12.5px;">Back</button>
    </div>
  `;

  $$('.rc-add').forEach(b => b.addEventListener('click', () => {
    const r = csvOnly[Number(b.dataset.i)];
    if (!r) return;
    // Pre-fill the Add form. The export's Type column wins when it says
    // payment (→ CC Payment, with the form's default source account);
    // otherwise charges → Expense, credits → Refund.
    const isPay = /payment/i.test(r.rtype || '');
    Object.assign(addForm, {
      type: isPay ? 'CC Payment' : (isCharge(r) ? 'Expense' : 'Refund'),
      date: r.date,
      account: recState.account,
      category: null,
      description: isPay ? '' : (r.desc || ''),
      amount: Math.abs(r.amount).toFixed(2),
      fromAccount: null,
      editingId: null
    });
    closeSheet();
    navigate('add');
    toast('Pre-filled from statement');
  }));
  $$('.rc-jump').forEach(el => el.addEventListener('click', () => {
    openTxnSheet(el.dataset.id); // re-uses the sheet; Back not preserved by design
  }));
  // NEW: date corrections — single + bulk. The diff re-runs after, so fixed
  // rows migrate into the strict-matched count.
  $$('.rc-fixdate').forEach(b => b.addEventListener('click', async () => {
    const m = loose[Number(b.dataset.i)];
    if (!m) return;
    await fixDate(m);
    invalidateMerchantCache();
    haptic(15); /* NEW(v2.2) */
    toast(`Date set to ${m.csv.date}`);
    renderResults(options);
  }));
  $('#rc-fix-all')?.addEventListener('click', async () => {
    if (!confirm(`Set ${loose.length} ledger dates to their statement posted dates?`)) return;
    for (const m of loose) await fixDate(m);
    invalidateMerchantCache();
    haptic(15);
    toast(`Fixed ${loose.length} dates`);
    renderResults(options);
  });
  // NEW: log canceled charge+refund pairs — single + bulk.
  $$('.rc-addpair').forEach(b => b.addEventListener('click', async () => {
    const p = canceled[Number(b.dataset.i)];
    if (!p) return;
    await addPair(p);
    invalidateMerchantCache();
    haptic(15);
    toast('Added charge + refund');
    renderResults(options);
  }));
  $('#rc-addpair-all')?.addEventListener('click', async () => {
    if (!confirm(`Add ${canceled.length} charge + refund pairs (${canceled.length*2} transactions)?\n\nAmounts cancel, so balances don't change. Categories default to merchant memory / Misc / Return — edit any of them later.`)) return;
    for (const p of canceled) await addPair(p);
    invalidateMerchantCache();
    haptic(15);
    toast(`Added ${canceled.length*2} transactions`);
    renderResults(options);
  });
  $('#rc-show-matched')?.addEventListener('click', () => {
    const host = $('#rc-matched');
    host.innerHTML = matched.map(m => `
      <div class="rec-row" style="opacity:.65;">
        <div style="min-width:0;flex:1;">
          <div style="font-size:13px;">${fmt(Math.abs(m.csv.amount))} · ${m.csv.date} ↔ ${m.txn.date}</div>
          <div class="muted small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m.csv.desc || m.txn.description || m.txn.category || '')}</div>
        </div>
        <span style="color:var(--green);flex-shrink:0;">✓</span>
      </div>
    `).join('');
    $('#rc-show-matched').style.display = 'none';
  });
  $('#rc-flip').addEventListener('click', () => {
    recState.flipSigns = !recState.flipSigns;
    renderResults(options);
  });
  $('#rc-back').addEventListener('click', () => renderSetup(options));
}
