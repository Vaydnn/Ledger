/* ============================================================
   tags.js — NEW(v3.1): tags on transactions (#trip, #work, #wedding…).

   A tag cuts across categories and months: everything for one trip, one
   project, one person. Stored as t.tags = ['trip', …] (lowercase, no '#').
   Activity filters by a tag and totals it; More → Tags lists them all.
   ============================================================ */

import { $, $$, fmt, esc, sumMoney } from './util.js';
import { state } from './db.js';
import { openSheet, closeSheet } from './sheet.js';
import { navigate } from './app.js';
import { txnFilters, resetRenderCap } from './txns.js';

export function normalizeTag(s){
  return String(s ?? '').trim().replace(/^#+/, '').toLowerCase()
    .replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 24);
}
// Splits "#trip, work  beach" into clean, unique tags.
export function parseTags(text){
  return [...new Set(String(text ?? '').split(/[\s,]+/).map(normalizeTag).filter(Boolean))];
}

// [{ tag, count, spent, last }] most-used first.
export function allTags(){
  const m = new Map();
  for (const t of state.transactions){
    for (const tag of t.tags || []){
      const e = m.get(tag) || { tag, count: 0, list: [], last: '' };
      e.count++; e.list.push(t);
      if ((t.date || '') > e.last) e.last = t.date;
      m.set(tag, e);
    }
  }
  return [...m.values()].map(e => ({ tag: e.tag, count: e.count, last: e.last, spent: tagSpent(e.list) }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// Spending under a tag: expenses less refunds.
export function tagSpent(list){
  return sumMoney(list, t => t.type === 'Expense' ? t.amount : t.type === 'Refund' ? -t.amount : 0);
}

export function showTagInActivity(tag){
  txnFilters.tag = tag;
  txnFilters.search = '';
  txnFilters.month = 'all';            // a trip spans months
  resetRenderCap();
  navigate('txns');
}

export function openTagsSheet(){
  const tags = allTags();
  $('#sheetBody').innerHTML = `
    <h2>Tags</h2>
    <div class="muted small" style="margin-bottom:12px;line-height:1.5;">Tag transactions in the Add form (#trip, #work…) to total them across categories and months. Tap a tag to see its transactions.</div>
    ${tags.length ? tags.map(t => `
      <button type="button" class="menu-item tag-row" data-tag="${esc(t.tag)}">
        <span class="l"><span class="tag on">#${esc(t.tag)}</span><span class="muted small">${t.count} transaction${t.count === 1 ? '' : 's'}</span></span>
        <span class="mono">${fmt(t.spent)}</span>
      </button>`).join('')
      : '<div class="empty"><div class="big">No tags yet.</div>Add one under Description when you log a transaction.</div>'}
  `;
  openSheet();
  $$('.tag-row').forEach(b => b.addEventListener('click', () => { closeSheet(); showTagInActivity(b.dataset.tag); }));
}
