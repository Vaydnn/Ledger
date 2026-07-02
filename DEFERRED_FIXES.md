# Deferred Fixes — documented in v1.2.0, not implemented

These came out of the v1.2 audit but were intentionally deferred, either because they'd touch more than 3 files (per the fix policy) or because the "fix" is debatable / cosmetic. Each entry has a suggested approach so a future version can pick it up cleanly.

---

## 1. Full HTML-escaping sweep of every remaining `innerHTML` site
**Severity:** Medium · **Why deferred:** >3 files

v1.2 added `esc()` in `util.js` and applied it everywhere user-entered strings flow into the highest-traffic templates (account names, category names, merchant suggestions, picker options, bill/plan names, event labels). However, a handful of lower-traffic render paths still interpolate user strings into `innerHTML` unescaped (e.g. some secondary list rows and detail cards across `home.js`, `txns.js`, `breakdown.js`, `insights.js`, `manage.js`).

Practical risk is low — this is a single-user app and the strings are your own — but a description like `<img src=x onerror=...>` would still execute.

**Approach:** mechanical pass: grep every `innerHTML` assignment and template literal, wrap each `${...}` that originates from a transaction/account/category/bill/plan field in `esc()`. No logic changes. Alternatively, introduce a tiny `html` tagged-template helper that auto-escapes interpolations and migrate templates to it over time.

## 2. Year-view heatmap cells below 44px tap target
**Severity:** Low · **Why deferred:** inherent to the design

A 7×~53 calendar grid at 375px width yields ~11px cells; there is no way to hit 44px without abandoning the GitHub-style year heatmap entirely. Cells aren't primary actions (the month rows below carry the same data), so this is accepted.

**Approach if ever needed:** tap on a heatmap cell opens a small tooltip/sheet for that day rather than navigating, and the tooltip's actions are full-size.

## 3. Stale `DEFAULT_CATEGORIES.CCPayment` seed list — ✅ RESOLVED in v2.9.1
**Severity:** Low · **Status:** `DEFAULT_CATEGORIES` genericized (privacy: the old lists were real personal categories in a public repo) and `seed.json` replaced with synthetic demo data that matches.

## 4. Category delete orphans existing transaction labels — ✅ RESOLVED in v2.0.0
**Severity:** Medium · **Status:** implemented as delete-with-reassignment (transactions move, budgets merge month-by-month). Account delete still orphans by name, as before.

Deleting a category in Manage leaves historical transactions pointing at the now-nonexistent label. They still render (the label is stored on the txn), but breakdown/budget grouping treats them as their own orphan bucket. Account delete behaves the same way and already warns about it; v1.2 added *rename* cascades (which is the common case), but delete-with-reassignment is a bigger UX flow.

**Approach:** on delete, prompt "Reassign N transactions to…" with a picker (reusing `openPicker`), then batch-update transactions, budgets, and bills before removing the category. Same flow would work for accounts.

## 5. `home.js` hero cosmetic no-op — ✅ RESOLVED in v2.9.1
**Severity:** Low · **Status:** all seven `.replace('$','$')` no-ops removed (home, networth, debts, yearview).
