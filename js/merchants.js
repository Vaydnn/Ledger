/* ============================================================
   merchants.js — merchant memory / autocomplete engine.

   Analyzes your transaction history to build a map of:
     description (lowercased) → { best-match display form,
                                   most-common category,
                                   most-common account,
                                   most-common type,
                                   count, lastUsed }

   Used by the Add form to:
     (1) Suggest descriptions as you type (prefix or fuzzy match)
     (2) Auto-fill category + account + type when you pick one
   ============================================================ */

import { state, dataVersion } from './db.js';

// Build (and memoize per session) the merchant table.
// FIX(v2.9.1): keyed on dataVersion (bumped by db.js on every transaction
// write) instead of transactions.length — an edit that didn't change the
// count used to keep serving a stale table unless the caller remembered to
// invalidate manually. The manual invalidateMerchantCache() calls scattered
// through the app still work, but they're now just a belt to this suspender.
let _cache = null;
let _cacheStamp = -1;

function buildTable(){
  const groups = {};
  for (const t of state.transactions){
    // FIX(v2.1): descriptions can be non-strings (numeric values imported
    // from Excel-era data, e.g. hours worked logged as 40.15) — calling
    // .trim() on a number threw and killed every merchant-memory consumer
    // (autocomplete, reconcile pair-adds). Coerce first.
    const raw = String(t.description ?? '').trim();
    if (!raw) continue;
    // Only learn from regular transaction types — skip transfers/payments
    // that are account-to-account and don't represent a "merchant".
    if (['Transfer','CC Payment','Loan Payment','Balance Transfer'].includes(t.type)) continue;

    const key = raw.toLowerCase();
    const g = groups[key] || (groups[key] = {
      displayForms: {},   // "WingStop" → count
      categories: {},     // "Restaurants" → count
      accounts: {},       // "Chase Checking" → count
      types: {},          // "Expense" → count
      count: 0,
      lastUsed: ''
    });
    g.displayForms[raw] = (g.displayForms[raw] || 0) + 1;
    if (t.category) g.categories[t.category] = (g.categories[t.category] || 0) + 1;
    if (t.account)  g.accounts[t.account]   = (g.accounts[t.account]   || 0) + 1;
    if (t.type)     g.types[t.type]         = (g.types[t.type]         || 0) + 1;
    g.count += 1;
    if (t.date > g.lastUsed) g.lastUsed = t.date;
  }

  // Collapse each group to single best values
  const mostCommon = (obj) => {
    let best = null, max = -1;
    for (const [k, v] of Object.entries(obj)){
      if (v > max){ max = v; best = k; }
    }
    return best;
  };

  const out = [];
  for (const [key, g] of Object.entries(groups)){
    out.push({
      key,
      display: mostCommon(g.displayForms) || key,
      category: mostCommon(g.categories),
      account: mostCommon(g.accounts),
      type: mostCommon(g.types),
      count: g.count,
      lastUsed: g.lastUsed
    });
  }
  return out;
}

function getTable(){
  if (_cache && _cacheStamp === dataVersion.n) return _cache;
  _cache = buildTable();
  _cacheStamp = dataVersion.n;
  return _cache;
}

// Force invalidate — call after explicit edits if count happens to match.
export function invalidateMerchantCache(){ _cacheStamp = -1; }

/* ─── Public API ─────────────────────────── */

// Return top matches for the given query. Matching strategy:
//   1. Prefix match (case-insensitive): weighted heaviest
//   2. Substring match: included but ranked below prefix matches
//   3. Ties broken by frequency, then by recency (lastUsed)
// Limits to `limit` results (default 5).
export function getMerchantSuggestions(query, limit=5){
  const q = (query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const table = getTable();

  const prefixHits = [];
  const substringHits = [];
  for (const m of table){
    if (m.key === q) continue; // exact match isn't a suggestion — it's already typed
    if (m.key.startsWith(q))      prefixHits.push(m);
    else if (m.key.includes(q))   substringHits.push(m);
  }

  const sortHits = (arr) => arr.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return (b.lastUsed || '').localeCompare(a.lastUsed || '');
  });

  const results = [...sortHits(prefixHits), ...sortHits(substringHits)];
  return results.slice(0, limit);
}

// Given a description (exact match on key), return the memorized bundle.
// Used when the user picks a suggestion — we can auto-fill category/account/type.
export function lookupMerchant(description){
  if (!description) return null;
  const q = description.trim().toLowerCase();
  return getTable().find(m => m.key === q) || null;
}
