/* ============================================================
   merchants.js — merchant memory / autocomplete engine.

   Analyzes your transaction history to build a map of:
     description (lowercased) → { best-match display form,
                                   most-common category,
                                   most-common EXPENSE category (v3.0),
                                   most-common account,
                                   most-common type,
                                   count, lastUsed }

   Used by:
     (1) the Add form — suggestions as you type, auto-fill on pick
     (2) NEW(v3.0) per-category default accounts (Restaurants → your card)
     (3) NEW(v3.0) refunds offsetting the budget of what they refunded
     (4) NEW(v3.0) Reconcile — fuzzy-matching raw statement names
   ============================================================ */

import { state, dataVersion } from './db.js';
import { squash, parseLocalDate } from './util.js';

// Memoized per dataVersion (bumped by db.js on every transaction write).
let _cache = null;
let _cacheStamp = -1;

// "Refund: Amazon" / "Return - Walmart" / "Rent (auto)" → the merchant part.
export function merchantCore(desc){
  return String(desc ?? '').trim()
    .replace(/\s*\(auto\)\s*$/i, '')
    .replace(/^(refund|return|returned|credit)\s*[:\-–]\s*/i, '')
    .trim();
}

function buildTable(){
  const groups = {};
  const now = Date.now();
  for (const t of state.transactions){
    // FIX(v2.1): descriptions can be non-strings (Excel-era numbers) — coerce.
    const raw = String(t.description ?? '').trim();
    if (!raw) continue;
    // Only learn from regular transaction types — transfers/payments are
    // account-to-account, not merchants.
    if (['Transfer','CC Payment','Loan Payment','Balance Transfer'].includes(t.type)) continue;

    const key = raw.toLowerCase();
    const g = groups[key] || (groups[key] = {
      displayForms: {}, categories: {}, expenseCats: {}, accounts: {}, types: {},
      count: 0, lastUsed: ''
    });
    // NEW(v3.0): category/account votes are recency-weighted (half-life
    // ~6 months) — re-filing a merchant (Steam games: Entertainment →
    // Steam) should win without having to outnumber years of history.
    const age = t.date ? Math.max(0, (now - parseLocalDate(t.date)) / 86400000) : 365;
    const w = Math.pow(0.5, (age || 0) / 180) || 0.0001;
    g.displayForms[raw] = (g.displayForms[raw] || 0) + w;
    if (t.category) g.categories[t.category] = (g.categories[t.category] || 0) + w;
    if (t.category && t.type === 'Expense') g.expenseCats[t.category] = (g.expenseCats[t.category] || 0) + w;
    if (t.account)  g.accounts[t.account]   = (g.accounts[t.account]   || 0) + w;
    if (t.type)     g.types[t.type]         = (g.types[t.type]         || 0) + 1;
    g.count += 1;
    if ((t.date || '') > g.lastUsed) g.lastUsed = t.date;
  }

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
      squashed: squash(key),
      display: mostCommon(g.displayForms) || key,
      category: mostCommon(g.categories),
      expenseCategory: mostCommon(g.expenseCats),
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

// Force invalidate — kept for callers that mutate transactions in place.
export function invalidateMerchantCache(){ _cacheStamp = -1; }

/* ─── Public API ─────────────────────────── */

// Top matches for the given query: prefix matches first, then substring
// matches; ties broken by frequency, then recency.
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
  return [...sortHits(prefixHits), ...sortHits(substringHits)].slice(0, limit);
}

// Exact (case-insensitive) lookup of a description's memorized bundle.
export function lookupMerchant(description){
  if (!description) return null;
  const q = String(description).trim().toLowerCase();
  return getTable().find(m => m.key === q) || null;
}

/* NEW(v3.0): fuzzy lookup for names that don't match exactly — statement
   rows ("BURGER BARN #01234 SOMETOWN TX", "JOES.COFFEE SOMETOWN")
   and refund descriptions ("Refund: Amazon"). Compares letters+digits only:
   the name may START WITH a known merchant ("joescoffeesometown" →
   "joe's coffee") or a known merchant may start with it. Longest
   overlap wins, then frequency. Returns null under 4 matching characters. */
export function findMerchantFuzzy(name, { requireExpense = false } = {}){
  const q = squash(merchantCore(name));
  if (q.length < 4) return null;
  let best = null, bestLen = 0;
  for (const m of getTable()){
    if (requireExpense && !m.expenseCategory) continue;
    const k = m.squashed;
    if (k.length < 4) continue;
    let len = 0;
    if (q === k) len = k.length + 1000;          // exact beats any prefix
    else if (q.startsWith(k)) len = k.length;
    else if (k.startsWith(q) && q.length >= 5) len = q.length;
    if (!len) continue;
    if (len > bestLen || (len === bestLen && m.count > best.count)){ best = m; bestLen = len; }
  }
  return best;
}

/* ── NEW(v3.0): per-category default account ─────────────────────────
   "Restaurants always go on my Citi card." Two layers:
     1. An explicit rule the user set (Categories sheet, or the Add form's
        "Always use…" prompt) — flags.categoryAccounts['Expense|Restaurants'].
     2. Otherwise, learned habit: transactions of this type+category over the
        last 180 days, weighted toward recent ones (half-life ~6 weeks). Used
        only when one account clearly dominates (≥ 55% of the weight), so a
        genuine split doesn't flip the form back and forth.
   validNames limits the answer to accounts the form can actually offer. */
export function categoryRuleKey(type, category){ return `${type}|${category}`; }

export function categoryRule(type, category){
  return (state.flags.categoryAccounts || {})[categoryRuleKey(type, category)] || null;
}

export function preferredAccountFor(type, category, validNames){
  if (!type || !category) return null;
  const ok = (n) => n && (!validNames || validNames.includes(n));
  const rule = categoryRule(type, category);
  if (ok(rule)) return { account: rule, source: 'rule' };
  const now = Date.now();
  const weights = {};
  let total = 0;
  for (const t of state.transactions){
    if (t.type !== type || t.category !== category || !t.account || !t.date) continue;
    const age = (now - parseLocalDate(t.date)) / 86400000;
    if (age > 180 || age < -31) continue;
    const w = Math.pow(0.5, Math.max(0, age) / 42);
    weights[t.account] = (weights[t.account] || 0) + w;
    total += w;
  }
  let best = null, bw = 0;
  for (const [a, w] of Object.entries(weights)) if (w > bw && ok(a)){ best = a; bw = w; }
  if (best && total > 0 && bw / total >= 0.55) return { account: best, source: 'habit' };
  return null;
}

/* ── NEW(v3.0): which budget does a refund give back to? ──────────────
   A Return logged as "Refund: Amazon" should reduce Shopping spend, not sit
   in a separate Refund bucket while the Shopping budget reads over. Explicit
   t.offsetCategory (set on the Add form) wins; otherwise the merchant's usual
   EXPENSE category. 'none' opts a refund out. Returns null when unknown. */
export function refundBudgetCategory(t){
  if (!t || t.type !== 'Refund') return null;
  if (t.offsetCategory) return t.offsetCategory === 'none' ? null : t.offsetCategory;
  const core = merchantCore(t.description);
  if (!core) return null;
  const exact = lookupMerchant(core);
  if (exact?.expenseCategory) return exact.expenseCategory;
  return findMerchantFuzzy(core, { requireExpense: true })?.expenseCategory || null;
}
