# Ledger PWA · v2.9.3

Personal financial tracker PWA. Installs on iOS/Android home screen, works offline, **data never leaves the device** — this repo contains code, a synthetic demo seed, and synthetic test fixtures only.

**Deploying / installing / updating: see [DEPLOY.md](DEPLOY.md).**

## What's new in v2.9.3 — Add Budget hotfix

Adding a new budget was broken: picking a Type or Category opened the picker **over the form in the same sheet**, and selecting an option wrote the value onto the now-replaced form and never returned — you were stranded on the picker. (Long-standing bug, not a v2.9.2 regression; the copy-forward flow masked it.) The new-budget form now keeps its state in a module object (same pattern as the bill editor), so picks re-render the form with the selection applied. New regression suite drives the full add flow: `tests/addbudget.test.mjs`.

---

## What's new in v2.9.2 — day-to-day QoL release

### Reconcile: add missing transactions without leaving the sheet

The old flow bounced through the full Add form and landed on Home — a More → Reconcile → re-run round trip **per missing row**. Now:

- **Add** on a statement-only row logs it instantly, right in the sheet: date/amount/account come from the statement, category from merchant memory. The diff re-runs in place and the row jumps to Matched. Undo on the toast.
- **Tap the row** (instead of Add) to pick the category first — still without leaving the sheet.
- **Add all N with smart categories** for statement-heavy months, with a single bulk Undo.
- CC-payment rows keep the full-form flow (they need a pay-from account).

### Faster logging & browsing

- **Category chips on the Add form** — your ~6 most-used categories for the current type as one-tap chips; the picker stays for the long tail.
- **Recent card on Home** — last 5 transactions, tap to view/edit/delete without switching to Activity.
- **Swipe left/right on Home** to step a month forward/back (edge touches ignored so the Android back gesture doesn't collide; picker stays for jumping far).
- **Tap an account row on Home** → Activity pre-filtered to that account.

### Safety & polish

- **Backup age is visible**: exports (JSON and xlsx) stamp `lastBackupAt`, the More footer shows "last backup Nd ago", and a toast nudges (at most weekly) when the newest backup is 30+ days old or missing.
- **Duplicate insight is dismissable** — a × remembers the pair, so a false positive (two real identical charges) no longer pins the top insight slot all month.
- **Undo instead of confirm()** for deleting transactions, bills, goals, and debt plans — immediate action plus an Undo toast (transactions additionally keep their 30-day trash). Big destructive operations (reset, restore, import, empty trash) keep their confirmations.

---

# Ledger PWA · v2.9.1 (previous)

## What's new in v2.9.1 — integrity & privacy release

### Privacy (the important one)

- **`seed.json` is now synthetic demo data.** It previously contained real financial history in a public repo; the git history was rewritten to purge it. The manifest app name and hardcoded personal defaults (preferred account, category lists, placeholders) were genericized too — the Add form now pre-selects your *most-used* account from history instead of a hardcoded name, so live-device behavior is unchanged.
- **First-run is now an explicit choice** (Restore backup / Load sample data / Start empty). The old silent auto-seed fired whenever the accounts store read empty and **cleared every store first** — indistinguishable from data loss, and destructive if only part of the data had survived. Seeding/restore also no longer wipes `meta` (device settings), `trash` (undo buffer), or `tombstones` (sync groundwork).
- **`.gitignore` blocks `ledger-backup-*.json` / `ledger-export-*.xlsx`** so a real backup can't be committed by accident.

### Correctness

- **Year-boundary carryover fixed.** The first transaction of a new year created that year's starting-balance record with January = 0, silently dropping every account's carried December balance until something re-cascaded the old year. New records now inherit the prior year's computed December ending, and a fresh record cascades the whole year. Regression suite: `tests/carryover.test.mjs`.
- **`parseAmount` everywhere.** Starting balances, budget cells, net-worth fields, and debt-plan fields still used raw `parseFloat` — typing `1,234.56` stored `$1.00` with no error (and a wrong opening cascaded through every later month).
- **One "Real available".** Home and Bills computed it independently (Bills ignored the configured card deduction) and could disagree. Both now render from `computeRealAvailable()` in `bills.js`.
- **Auto-cc bills in past months** now show the linked card's balance *as of that month* (`balanceAt`) instead of leaking today's live balance into historical views.
- **Un-paying a bill soft-deletes** the payment transaction (trash + Undo toast) instead of hard-deleting it — an auto-cc payment records the balance at pay time and couldn't be recreated by re-paying.
- Delete + tombstone now share one IndexedDB transaction (no resurrection window for future sync); month picker survives dateless records; duplicate detector uses local-date parsing like the rest of the app.

### PWA / offline

- **SheetJS vendored** (`js/vendor/`, precached). Export/import/reconcile now work offline, and no third-party CDN script runs in a page holding financial data.
- **Cache-only core + update toast.** The SW no longer background-revalidates individual files into the live cache (which could mix modules from two deploys into one torn app). A release is picked up atomically via the `VERSION` bump, and the app shows "Update ready — Reload" when the new version has installed.
- Manifest no longer locks portrait orientation; pinch-zoom re-enabled (`user-scalable=no` removed).

### Performance

- `detectInsights`, `computePace`, and `detectRecurring` are memoized on the data version + calendar day (they re-ran dozens of full-history scans on every Home render). Merchant memory keys on the data version too. `bills`/`budgets` writes now bump the data version so these caches can't go stale.

---

# Ledger PWA · v2.9.0 (previous)

## What's new in v2.9.0 — the repo release

No app behavior changes. Ledger is now a proper GitHub-ready project:

- **Tests live in the repo.** All nine suites (~300 checks) moved into `tests/`, rebuilt to run against **deterministic synthetic fixtures** (`tests/fixtures.mjs`: 14 months of generated activity — bi-weekly salary with a regime change, a subscription price hike, variable spending, CC/loan payments, plus a statement-CSV generator with posting lags, planted fakes, and a declined row). `npm install && npm test` verifies everything; no personal data required or included.
- **`package.json` + `.gitignore`** at root; shared test bootstrap in `tests/_env.mjs`; sequential runner in `tests/run.mjs`.
- **`DEPLOY.md`** — complete GitHub Pages setup, phone install, data migration, and per-release update workflow.
- All app paths were already relative (`./`), so the app works unchanged under a `github.io/ledger/` subpath — verified, zero code changes needed.
- `sw.js` cache `ledger-v2.9.0`. Repo-only files (tests, docs) are not precached.

---

# Ledger PWA · v2.8.0 (previous)

## What's new in v2.8.0 — smarter Insights

### New detectors

- **Possible duplicate** — same amount, same account, within 2 days (bill-logged txns excluded). Catches a double-log the day it happens instead of a month later at reconcile time. Highest weight: data integrity beats commentary.
- **Early budget breach** — a budgeted category already over its target with ≥5 days left in the month (late-month breaches are visible on the budget card anyway).
- **Subscription price change** — surfaces a recent detected price hike/drop as an insight, not just a badge in the Subscriptions sheet.
- **Bill cluster** — 2+ unpaid bills totaling $200+ due in the next 7 days.
- **Top-5% expense** — the month's biggest single expense when it lands in your personal all-time 95th percentile.

### Smarter algorithm

- **Partial-month-aware outliers.** The old detector compared a *partial* live month against full-month medians — on day 8 everything looked like "only 30% of typical" (noise) and real overspend hid until late month. Live-month highs now fire only when partial spend *already* exceeds the full-month median ×1.2 (a certainty, not a projection); lows are suppressed until day 24. Closed months keep the original comparison.
- **Pace-powered burn rate.** The naive `spent ÷ days × month` projection is replaced by the v2.6 pace engine (fixed/variable split, recurring-aware), with the known-bills component called out in the detail line.
- **Causal suppression.** A price-change insight *explains* the same category's spending outlier; a budget breach is the more actionable version of the same fact — in both cases the redundant outlier is dropped so the slot says something new.
- **Kind diversity** — at most one insight per kind in the final cut.

### Fixes found by testing

- A single stray charge in a recurring category no longer fakes a "price change" (the two most recent charges must agree with each other before a new price level is declared).
- A live-month 1.2–1.5× outlier no longer falls into the "low spend" branch ("only 144% of typical").

Validated on the live dataset — first run surfaced a real possible duplicate (2× $21.00 on RH CC, same day) alongside the Phone Bill outlier and a Restaurants budget breach, with suppression keeping all three slots distinct.

### Files touched

`js/insights.js`, `js/subscriptions.js` (price-change consistency gate), `sw.js` (cache `ledger-v2.8.0`).

---

# Ledger PWA · v2.7.1 (previous)

## What's new in v2.7.1

- **FIX (display honesty):** spending against a budget whose amount isn't set for the current month used to render as a ratio against $0 ("$540 / $0", empty bar) — which read as "the transaction isn't being counted." It always was; the month's target was just unset. That state now says exactly that — **"$540.03 spent · no June budget set →"** — and tapping the row opens the Budgets sheet to fix it.

## What's new in v2.7.0

### Real Available, configurable

The Home card used to be fixed at cash − bills. It's now **cash − bills − the debt balances you choose**. Tap the ⚙ on the card to check which cards/loans count against your cash: a month-to-month daily driver (RH CC) belongs in; a long-horizon 0% promo balance you're paying down on schedule stays out. Each checked account gets its own breakdown line, the subtitle names what's included, and the selection persists.

**No double counting:** an auto-CC tracking bill whose linked card is checked is automatically excluded from the bills side — the card balance and the bill were the same money. (This also means you no longer need auto-CC bills *just* to make Real Available honest; check the card directly instead.)

Covered by a 10-check behavior suite: baseline math, the double-count guard (selecting a card with an auto-cc bill leaves the total unchanged — proof the guard works), per-card breakdown lines, multi-select, uncheck-restore, and flag persistence.

### Files touched

`js/home.js`, `sw.js` (cache `ledger-v2.7.0`).

---

# Ledger PWA · v2.6.0 (previous)

## What's new in v2.6.0

### Month-End Pace (Home card, live month only)

A smart projection of where the month lands, not a naive `spent ÷ days × month` extrapolation (which double-projects rent and whipsaws early in the month). The model:

- **Fixed costs** — unpaid bills due from today onward, plus detected recurring expenses whose next occurrence lands before month-end (de-duplicated against the bills store) — added once at face value, never extrapolated.
- **Variable spend** — everything else, projected from a daily rate that blends this month's actual rate with the median daily variable rate of the last three complete months. The blend slides with elapsed days (history speaks early, actuals by week three).
- **Income** — actuals plus remaining occurrences of detected income streams. Detection clusters recent income by **amount** before checking cadence, so a pay regime change (intern weekly → full-time bi-weekly after a promotion) is recognized within two paychecks — category-level detection returned nothing on exactly this real case.

The card shows spent-vs-projected with a today marker, projected income and net, a budget over/under line when budgets exist, and its own assumptions ("$X in known bills still to hit · variable ~$Y/day, blended with 3-mo habits"). Validated against the live dataset: smart $5,118 vs naive $5,852 for the same month-to-date, with the salary stream correctly projected.

### Subscription price-change alerts

Recurring-expense rows in the Subscriptions sheet now flag price changes ("↑ $340.45 → $430.46") — the median of the two most recent charges vs the prior series. Gated on the prior series being *stable* (≥80% of charges within ±8% of median), so variable categories that merely bounce around their average can't false-flag. On the live dataset this surfaced exactly one change — a real one.

### Files touched

New: `js/pace.js`. Modified: `js/home.js`, `js/subscriptions.js`, `index.html` (pace card + badge CSS), `sw.js` (cache `ledger-v2.6.0`, pace.js precached).

---

# Ledger PWA · v2.5.0 (previous)

## What's new in v2.5.0 — pure optimization release

No features, no visual changes, no schema changes. Measured against the live 1,010-transaction dataset:

| Path | Before | After | |
|---|---|---|---|
| Render math (Home: all account balances + month totals + 12 month-nets) | 5.60 ms | **0.23 ms** | ~24× |
| Save path (transaction save → full balance cascade) | 0.49 ms | **0.26 ms** | ~2× |

(Node timings; multiply ~5–10× for mobile CPU. These costs previously grew linearly with history — ~1,000 transactions/year — and now barely grow at all.)

### Version-keyed derived-math index (`effects.js`)

Every balance/total function used to scan all transactions per call — and Home alone made a dozen such calls per render. One pass now builds an index (account→month→net effect in cents, plus month KPI totals) keyed on a monotonic **data version** that `db.js` bumps only when `transactions` or `accounts` change. All public functions became O(1) lookups with identical semantics — verified by a 200-check equivalence suite comparing indexed results against brute-force scans for every account × month × year in the real dataset, plus a cache-invalidation check. Scoping the version bump matters: the balance cascade writes `startingBalances` right after reading the index, and an unscoped bump made every save invalidate the cache it had just built (caught by benchmarking, fixed before release).

### Activity list render cap

"All months" was building 1,000+ DOM rows on every visit — layout cost dwarfs JS math on mobile, and it doubled yearly. The list now renders the newest 150 rows with a one-tap "Show all N" to render the rest; the cap resets whenever any filter changes. Search input is also debounced (140 ms) — it previously re-filtered and rebuilt the full list on every keystroke.

### Files touched

`js/effects.js` (index rewrite), `js/db.js` (scoped data version), `js/txns.js` (render cap + debounce), `sw.js` (cache `ledger-v2.5.0`).

---

# Ledger PWA · v2.4.3 (previous)

## What's new in v2.4.3

- **FIX: tabs jumping out of the bottom bar — nuclear option.** A screenshot showed a tab element itself displaced above the bar, pointing at the v2.2 decorations attached to the nav: ripple `<span>` injection (with overflow toggling), the M3 pill's animated `::before`, springy icon scale transforms — all inside a `backdrop-filter`-blurred `position:fixed` bar, a known compositing stress combination on Samsung Internet. The nav is now a **zero-motion zone**: no ripples, no pseudo-element animations, no transforms at any width (the ≥560px centering switched from `translateX(-50%)` to auto margins), no DOM mutations. Active state is color; pressed state is color; the FAB brightens on press instead of scaling. Nothing on the bottom bar can move, by construction.

---

# Ledger PWA · v2.4.2 (previous)

## What's new in v2.4.2

- **FIX: the bottom-bar "pop" is actually gone this time.** The bar (`position:fixed`) never moved — it's translucent with a 20px blur, and every view entered with a 4px slide-up animation, so the content visibly slid upward *through* the frosted bar on each tab switch. The Add tab was the only one that looked fine because the short form renders nothing beneath the bar. The view entrance animation (which predates v2.2) is removed entirely: tab switches are instant, and the only remaining vertical motion in the app is the bottom sheet and the toast — both intentional. 

---

# Ledger PWA · v2.4.1 (previous)

## What's new in v2.4.1

All four items from field testing on the Fold:

- **Quick log redesigned.** The merchant chips are gone. Home now shows three type buttons — **Expense / Income / Refund** — and tapping one opens a picker of your most-used categories for that type (last 12 months, frequency-ranked, padded with configured-but-unused categories so the list is never artificially short). Picking a category lands on the Add form pre-filled with the type, the category, your usual account *for that specific type+category combo* (falling back to your usual account for the type), and today's date — cursor already in the amount field.
- **Bottom bar pop eliminated.** View Transitions are fully removed: the snapshot-based animation included the fixed bottom nav, and differing scroll heights between tabs made it visibly jump on every switch. The original per-view content fade (which never touched the chrome) remains.
- **Pickers no longer close while scrolling up.** Root cause: drag-to-dismiss allowed a drag to begin "anywhere when scrolled to top," so scrolling back up a long category/account list hit the top mid-gesture and converted your scroll into a dismissal. Dismiss-by-drag now works **only from the grab handle**, which is now sticky at the sheet's top (it previously scrolled away with the content). Content scrolling can never close a sheet; backdrop tap, back gesture, handle drag, and Escape all still do.
- **Add button no longer clipped.** The ripple system applies `overflow:hidden` to ripple hosts; after the first tap on the Add tab this clipped the raised FAB. The Add tab is excluded from ripples (it has its own press animation) and carries an explicit overflow guard.

### Files touched

`js/home.js` (quick-log v2 + category/account ranking), `js/sheet.js` (handle-only drag), `js/app.js` (view transitions removed), `js/util.js` (ripple scope), `index.html` (sticky handle, FAB guard, type-button styles, VT CSS removed), `sw.js` (cache `ledger-v2.4.1`).

---

# Ledger PWA · v2.4.0 (previous)

## What's new in v2.4.0

### Quick-log chips on Home

Your most frequent action — logging an expense — drops from five inputs to two taps. A horizontal row of chips under the hero shows your genuine habits (merchants logged 3+ times with activity in the last 90 days, frequency-then-recency ranked, Expense type only). Tapping one pre-fills type, account, category, description, and today's date, lands you on the Add form with the cursor already in the amount field. Type the number, Save, done. The row hides itself until at least two habitual merchants exist.

### Touch-feel fix: scrollable lists stop fighting your finger

Scrolling the category picker (and every other list) felt clunky because v2.2's ripples and scale transforms fired on *every touch*, including scroll touches. Fixed by scoping the feedback correctly: ripples and press-scales now live only on discrete buttons (save buttons, tabs, type pills, segmented controls, quick-log chips); list items — picker options, menu items, filter chips, transaction/bill rows — get a plain background tint on press and otherwise stay out of the way. The sheet also gained `overscroll-behavior: contain` so list scrolling can't chain into or bounce the page behind it.

### Files touched

`js/home.js`, `js/merchants.js` (+`topMerchants`), `js/add.js` (date prefill path), `js/util.js` (ripple scope), `index.html` (press states, quick-log CSS, sheet scroll containment), `sw.js` (cache `ledger-v2.4.0`).

---

# Ledger PWA · v2.3.1 (previous)

## What's new in v2.3.1

- **FIX:** tab switches no longer "pop upward" — the view-transition vertical drift is gone, replaced by a fast plain cross-fade (~120ms).
- Storage persistence requested (`navigator.storage.persist()`) so the browser can't evict the ledger's IndexedDB under storage pressure.

## What's new in v2.3.0 — sync groundwork

Invisible day-to-day, but this release lays the rails so v3.0 (cross-device sync) is purely transport work. The database upgrades v3 → v4 (one additive store). Full design decisions for sync live in `SYNC_DESIGN.md`.

### Change tracking

- Every write now stamps **`updatedAt`** (epoch ms) — the backbone of last-write-wins sync. Bulk operations (seed, backup restore) preserve an existing stamp, because restoring isn't editing.
- Every hard delete writes a **tombstone** (`store + id + deletedAt`) to a new `tombstones` store, so sync can distinguish "deleted here" from "never seen there". Restores naturally win (newer stamp). Tombstones age out after 180 days; `meta`/`trash` deletions are exempt.

### Write-boundary normalization + one-time scrub

The v2.1 numeric-description bug proved malformed data gets in and lurks; once sync exists, it would *replicate*. `dbPut` now repairs records on the way in — amounts coerced to numbers and rounded to cents, descriptions and reference fields coerced to strings — and a one-time scrub (flag-gated, runs once per device) re-saves any pre-v2.3 transaction that fails the guard.

### Multi-tab coherence

Two tabs share IndexedDB but each holds its own in-memory state — on a PC, the stale tab would silently stomp the fresh one. Writes now announce on a `BroadcastChannel`; other tabs reload state, **politely**: never while a sheet is open or the Add form might hold half-typed input — those defer until the sheet closes or you navigate away. This same machinery is what a sync pull will drive in v3.0.

### Silent failures surface

An exception inside an async click handler used to vanish into the console while the button just "did nothing" (exactly how the v2.1 bug presented). Global handlers now catch unhandled errors and rejections and show a throttled "Something went wrong" toast.

### Verified

14 new groundwork tests (stamping, normalization, tombstone write/aging/restore-wins, bulk-preserve, scrub idempotence, live cross-tab refresh through a real BroadcastChannel) plus full regression: reconcile end-to-end 587/587 and all 9 sheet-history tests, zero errors.

### Files touched

`js/db.js` (schema v4, stamping, tombstones, normalization, scrub, write announcements), `js/app.js` (tab sync, error surfacing), `js/sheet.js` (close event + open-state export), `sw.js` (cache `ledger-v2.3.0`). New: `SYNC_DESIGN.md`.

---

# Ledger PWA · v2.2.0 (previous)

## What's new in v2.2.0 — the native-feel release

No new features; every change is about making the app feel like an Android app instead of a web page. Zero data or schema changes.

### Android back gesture finally works

The single biggest "this is a website" tell is gone: swiping back with a sheet or picker open now **closes the sheet** instead of exiting the app. Each open sheet owns one history entry; programmatic closes consume it so gesture and code stay in sync, Escape closes on desktop, and a close-then-reopen race (a sheet opened while a previous close's `history.back()` is still in flight) self-heals by re-pushing after the pop lands. Covered by 9 dedicated history-behavior tests.

### Drag-to-dismiss bottom sheet

The sheet follows your finger: drag down from the handle zone (now a 44px grab target) or from anywhere once the content is scrolled to the top, with the backdrop dimming proportionally. Release past ~130px or with a quick flick and it dismisses (with a soft haptic); otherwise it springs back. Upward scrolls inside the sheet are never hijacked. The entrance animation got springier (`cubic-bezier(.32,.72,.25,1)`) and the backdrop now blurs what's behind it.

### View transitions + scroll memory

Tab switches animate as a soft cross-fade with vertical drift via the View Transitions API (Samsung Internet supports it; graceful instant fallback elsewhere, and `prefers-reduced-motion` is respected). Each tab also **remembers its scroll position** — switch from halfway down Activity to Home and back, and you're still halfway down Activity, like a native bottom-nav app. The Add form always opens at the top.

### Material touch layer

- **Ripples** on every tappable surface (buttons, chips, menu items, tabs, picker options, segmented controls) via one delegated listener — no per-element wiring.
- **Press states** everywhere: chips/menu items/pickers scale down under the finger, transaction and bill rows brighten, tab icons squish with a springy pop, the FAB compresses.
- **Haptics** at the moments that matter: a tick on picker selection, a firm pulse on save/pay/goal-save/reconcile actions, a destructive double-buzz on transaction delete, a soft tap on drag-dismiss. Silent no-op where unsupported.
- **Material 3 active-tab pill** — a soft pill stretches in behind the active tab's icon.
- Long-press no longer selects button labels; keyboard focus rings only appear for keyboard users (`:focus-visible`); input focus got a calmer themed ring; the toast now respects gesture-nav safe areas and lands with snackbar physics.

### Files touched

`js/sheet.js` (rewritten), `js/app.js`, `js/util.js` (+`haptic`, +`initRipples`), haptic call-sites in `js/add.js`, `js/txns.js`, `js/bills.js`, `js/reconcile.js`, `js/goals.js`, `index.html` (native-feel CSS layer), `sw.js` (cache `ledger-v2.2.0`).

---

# Ledger PWA · v2.1.0 (previous)

## What's new in v2.1.0

### Reconcile: one-tap corrections

- **Fix date** on every posting-lag ("matched on amount only") row sets the ledger entry to the statement's posted date — approve once and it strict-matches forever after. **Fix all N dates** does the batch with one confirm. Balances re-cascade automatically when a date change crosses a month boundary.
- **Add** on every canceled charge+refund pair logs both sides (Expense + Refund, same amounts) so the ledger mirrors the statement; net balance effect is zero. **Add all N pairs** batches it. Categories come from merchant memory when the merchant is recognized, with Misc/Return fallbacks — editable later. Note: a pair that spans months correctly shifts the in-between month-end balance (the debt really was higher before the refund posted).
- Loose-match window widened ±10 → ±14 days (real data showed an 11-day merchant lag).

### Bugfix: non-string descriptions crashed merchant memory

Three Excel-era transactions had numeric descriptions (hours-worked values like `40.15`), and `merchants.js` called `.trim()` on them — which threw inside every merchant-memory consumer. The visible symptom: the canceled-pair **Add** button silently did nothing (its category guess routes through merchant lookup); description autocomplete and Activity text search could also break in sessions where the cache rebuilt. Fixed by coercing descriptions to strings in `merchants.js`, the Activity search filter, and the edit form, plus the reconcile category guess is now wrapped so a lookup failure can never abort an add.

Verified end-to-end in a DOM + IndexedDB integration harness driving the real modules with the real 594-row Robinhood export: Add pair +2 transactions, Add-all +16, Fix-all dates → 587/587 strict-matched, zero residuals, zero errors.

### Files touched

`js/reconcile.js`, `js/merchants.js`, `js/txns.js`, `js/add.js`, `js/util.js`, `sw.js` (cache `ledger-v2.1.0`).

---

# Ledger PWA · v2.0.0 (previous)

## What's new in v2.0.0

Major feature release. The database upgrades automatically (v2 → v3, additive only — two new stores, nothing existing is touched). JSON backups from any earlier version restore cleanly.

### CSV Reconciliation (More → Reconcile CSV)

Replaces the monthly compare-the-CSV-by-hand ritual. Pick an account (defaults to RH CC), choose the bank's CSV export, and the statement is diffed against your ledger:

- **Matched** — same amount to the cent, dates within an adjustable ±1/3/5/7-day tolerance (statement posting dates drift from purchase dates).
- **On statement, not in ledger** — each row has an **Add** button that pre-fills the Add form (date, amount, account, description; charges → Expense, credits → Refund).
- **In ledger, not on statement** — tap to open the transaction. Pending charges that haven't posted yet commonly land here.

Built for the log-instantly workflow: ledger dates are purchase dates, statement dates are posting dates, and they rarely agree. Three layers absorb that:

1. **Strict pass** — amount equal to the cent, dates within the chosen window.
2. **Loose pass** — leftovers match on amount alone within ±14 days, shown separately with the posting lag (e.g. "logged 05-13, posted 05-19 (6d)"). Each row has a **Fix date** button (plus **Fix all**) that sets the ledger entry to the statement's posted date — approve once and it strict-matches forever after. ±14 covers slow merchants (real data showed an 11-day lag) while staying well clear of monthly billing cycles.
3. **Totals check** — statement net (charges − credits) vs the ledger's sign-aware balance movement over the same period, with the difference highlighted. Even when row-level dates are messy, this answers "do the totals tie out?" at a glance.

Two more layers handle real export quirks: **declined/failed/reversed rows are skipped** (Robinhood's export includes declined retries, which would otherwise appear as phantom duplicates), and **charge + refund pairs that both lack a ledger match collapse into a "canceled out on statement" group** (same amount, opposite sign, within 45 days) — returned purchases that were never logged. Each pair has an **Add** button (plus **Add all**) that logs both sides as Expense + Refund with one approval; amounts cancel so balances are unchanged, and categories come from merchant memory with Misc/Return fallbacks. Pending rows are kept (you log instantly, so they match) and labeled. The Add prefill reads the export's Type column: payment rows pre-fill as CC Payment instead of Expense/Refund.

Column detection is automatic (Date / Amount / Description headers, or Debit+Credit pairs; Status and Type columns are used when present; handles `$1,234.56`, accounting-style `(12.34)`, `M/D/YY`, and Excel serial dates). The charge sign convention is auto-detected from the majority sign with a manual **Flip signs** override. Strict matching pairs each statement row with the earliest unused same-amount ledger transaction inside the window — this handles runs of identical small charges correctly where nearest-date matching would mis-chain. Validated against a real 594-row Robinhood CC export spanning nine months, diffed against the live ledger: 7 declined rows filtered, 569 matched (563 strict + 6 loose, including bills logged on the 1st that posted in the prior month), 9 charge/refund pairs collapsed, totals difference $0.00. Applying Fix-all-dates + Add-all-pairs produced a fully clean reconcile: 587/587 statement rows strict-matched, zero residuals.

### Debt Payoff Projections (Debts & Loans)

- Each card/loan with an APR and minimum payment on its plan now shows an estimated payoff date, time-to-payoff, total interest at minimums, and a balance curve. 0% promo periods accrue no interest until the promo end date. A payment that doesn't cover interest is called out as never paying off.
- A new **Payoff Strategy** card compares **Avalanche** (highest APR first) vs **Snowball** (smallest balance first) across every planned debt, with an "extra toward debt each month" input (persisted). A cleared debt's minimum rolls into the extra automatically, and the card shows how much interest avalanche saves.
- All projections are labeled estimates — monthly compounding, while real card interest accrues daily.

### Automatic Net Worth Snapshots

On the first app open of each calendar month, a snapshot is captured automatically from live balances (Checking, Savings, CC Debt, Loans → Other Debt; Investments carry forward from the last snapshot). Skipped if any snapshot already exists that month. Toggle it off in the snapshot sheet. Bonus fix: the manual snapshot's Investments field now prefills from the last snapshot instead of 0.

### Budget Copy-Forward

When the selected year is missing budgets that exist in the previous year, the Budgets sheet offers one tap to copy them over with all twelve monthly amounts intact — no more rebuilding budgets every January.

### Trash & Undo

Deleting a transaction is no longer a one-way door. Deletes move to a Trash store (More → Trash) with 30-day retention and automatic purge; the delete toast has an inline **Undo**. Restoring re-runs the balance cascade. (A restored bill payment shows the bill as unpaid — re-tap Pay to re-link.)

### Savings Goals (More → Savings Goals + Home card)

Named targets (emergency fund, baby fund…) with progress bars on Home. Two tracking modes: **linked** to a Checking/Savings account (progress = live balance) or **manual** with a quick "+ Add to goal" action. Optional target date shows the monthly pace needed. Goals are archivable, included in JSON backup (now `version: 2`) and the xlsx export/import (new Goals sheet), and account renames cascade into linked goals.

### Activity Search: Amount & Date Filters

Two new filter chips. **Amount** matches an exact value to the cent (the "did I log that $77.18 charge?" check), or a min/max range. **Dates** filters an arbitrary range and overrides the month chip while active. Active filters show their values on the chip.

### Category Merge & Reassign

Deleting a category that's in use now prompts for a replacement and moves every transaction over; budgets merge month-by-month if the target already has one, or are relabeled if not. Unused categories still delete directly. This closes deferred item #4 from v1.2.

### Under the hood

- IndexedDB v3: new `goals` and `trash` stores (additive).
- New modules `js/reconcile.js`, `js/goals.js`, `js/trash.js`; all three added to the service-worker precache. Cache version `ledger-v2.0.0`.
- New `toastAction()` util (toast with inline action button).
- JSON backup `version: 2` (adds `goals`); v1 backups restore fine.

### Files touched

New: `js/reconcile.js`, `js/goals.js`, `js/trash.js`. Modified: `js/util.js`, `js/db.js`, `js/txns.js`, `js/debts.js`, `js/networth.js`, `js/budgets.js`, `js/manage.js`, `js/home.js`, `js/more.js`, `js/app.js`, `index.html`, `sw.js`.

---

# Ledger PWA · v1.2.0 (previous)

## What's new in v1.2.0

Full-codebase audit release. No new features — this version is entirely correctness, data-integrity, and mobile-polish fixes. Items intentionally deferred are documented in `DEFERRED_FIXES.md`.

### Critical

- **Integer-cents money math everywhere.** All monetary aggregation (account balances, month totals, budgets, breakdown, insights, year-view daily nets, bills totals, forecast, subscriptions, net worth) now accumulates in integer cents and rounds once for display. Raw float accumulation was producing visible drift (e.g. a month summing to `5723.6900000000005`). New helpers in `util.js`: `toCents`, `fromCents`, `round2`, `sumMoney`.
- **Safe amount parsing.** `parseAmount()` replaces raw `parseFloat` on the Add form and Bill form — `parseFloat('1,234.56')` silently saved **1**. Strips `$`, commas, spaces; rejects junk; rounds to cents (live data contained stored sub-cent amounts like `15.876`).
- **Single cached IndexedDB connection.** Every `dbAll`/`dbPut`/`dbDel` previously opened a brand-new connection that was never closed; now one shared connection promise with `onversionchange` invalidation.
- **`uid()` collision fix.** Bulk loops (seed/restore of 1,000+ records) could mint duplicate ids inside the same millisecond; a monotonic counter suffix makes ids unique.

### High

- **`balanceLatest` used the *selected* year.** Auto-CC bill amounts and Forecast starting cash went stale whenever you browsed a past year; they now always reflect the current calendar year.
- **xlsx import round-trip data loss.** The exporter wrote Bills, Net Worth, and Debt Plans sheets but the importer silently dropped them; all three now import.
- **Rename cascades.** Renaming an account now updates transactions (`account`/`fromAccount`), starting balances, bills (including `linkedAccount` / auto-pay source), and debt plans, with a toast reporting the record count. Renaming a category cascades through transactions and budgets. Previously a rename silently orphaned history.
- **Net-worth snapshot prefill** ignored Savings accounts (always 0) and omitted Loan balances from Other Debt, overstating net worth; both included now.
- **DST-safe date stepping.** Forecast and subscriptions stepped days by adding `86,400,000 ms`, which duplicated/skipped a calendar day across DST transitions; replaced with calendar-safe `addDays()`.
- **Service worker precache fixed.** `seed.json` was missing from CORE — an offline first run could not seed. Cache version bumped to `ledger-v1.2.0`; the manifest now exactly matches the file list (verified programmatically).
- **No more native `<select>`s.** The Bill sheet (six selects) and the Debt Plan / Edit Account sheets were rebuilt on `openPicker()` + segmented controls, with form state preserved across re-renders — native selects break on Samsung Internet.

### Medium

- **Legacy-refund banner false positive.** The migration heuristic flagged *any* Income on a debt account, including intentional "Cash Back" income on RH CC; it now only matches refund-named categories.
- **Edit return navigation.** Finishing an edit started from Activity bounced to Home; it now returns to Activity.
- **Migration-dismissed flag** moved from `localStorage` to the IndexedDB meta store (one-time port, old key removed) — honoring the IndexedDB-only persistence rule.
- **HTML escaping** (`esc()` in `util.js`) applied to user-entered strings in the highest-traffic templates: merchant suggestions, picker options (with safe round-trip via `dataset`), account/category/bill/plan names, forecast event labels.
- **Hand-edited backup resilience.** Date sorts and effects guards no longer crash on records missing a `date`.
- **Hardcoded-year fallback** in `seedFromJSON` replaced with the current calendar year.

### Low / polish

- `APP_VERSION` was stale at `1.1.4` while the app shipped as 1.1.5; now sourced correctly (`1.2.0`).
- `-webkit-overflow-scrolling: touch` added to the bottom sheet, merchant suggestion list, and transaction filter row (momentum scrolling on Samsung Internet).
- Filter chips enlarged to a 40px minimum tap height.

### Files touched

`js/util.js`, `js/db.js`, `js/effects.js`, `js/balances.js`, `js/add.js`, `js/home.js`, `js/txns.js`, `js/bills.js`, `js/manage.js`, `js/debts.js`, `js/networth.js`, `js/forecast.js`, `js/subscriptions.js`, `js/breakdown.js`, `js/budgets.js`, `js/insights.js`, `js/yearview.js`, `js/sheet.js`, `sw.js`, `index.html`. New: `DEFERRED_FIXES.md`.

---

# Ledger PWA · v1.1.5 (previous)

## What's new in v1.1.5

### Default account on the Add form

The Account picker now pre-selects **RH CC** on a fresh transaction whenever it's a valid option for the chosen type (Expense, Refund, CC Payment, Balance Transfer). For types where RH CC isn't applicable (Income, Transfer, Investment, Loan Payment), it falls back to the first option as before. Merchant autocomplete still wins — picking a remembered merchant overrides the default with that merchant's usual account — and any manual selection within a session is preserved.

### Files touched

`add.js` (`PREFERRED_ACCOUNT` constant + default-account fallback), `sw.js` (version bump).

---

# Ledger PWA · v1.1.4 (previous)

## What's new in v1.1.4

### Restore from JSON

**More → Restore from JSON** is the counterpart to **Backup as JSON**, which until now was download-only — there was no way to load a backup back in. Restore reads a backup file produced by this app, validates it, and replaces all current data on the device. Categories (stored in the backup as an object keyed by type) are rehydrated into per-type records; every other store is restored directly. A confirmation prompt makes clear the restore is destructive.

### Bug fixes

- **Deleting a bill's payment transaction no longer orphans the bill.** Paying a bill auto-logs a transaction and records its id in the bill's `paidMonths`. Deleting that transaction from the Activity tab used to leave the bill flagged "Paid" with no backing transaction — and for standard bills that made "Real available" overstate by the bill's amount. The Activity delete handler now clears any bill paid-flag pointing at the deleted transaction.
- **Debt plans with no target/promo date no longer render `NaN`.** A plan saved with neither a Target Payoff Date nor a Promo End Date produced "NaN mo" and "$NaN / month needed" (Invalid Date math). The debt card now detects a missing target, shows "—" for the time-based stats, and prompts you to set a date.
- **Cross-year balance carryover now works.** The starting-balance cascade stopped at December within a single year, so editing a December transaction never updated the following January's opening balance. December's ending balance now flows into next January's opening (only when a record for the next year already exists, preserving the mid-year-opening rule).
- **Removed a duplicated DOM block.** The bottom tab bar, sheet, backdrop, and toast were accidentally duplicated in `index.html` (duplicate element ids). Harmless in practice because `querySelector` returns the first match, but invalid markup and a latent footgun — now deduplicated.

### Files touched

`manage.js` (restoreJSON), `more.js` (menu item + dispatch), `txns.js` (clear orphaned bill paid-flag on delete), `debts.js` (NaN guard), `balances.js` (cross-year cascade), `index.html` (removed duplicate block), `util.js` and `sw.js` (version bumps).

---

# Ledger PWA · v1.1.3 (previous)

## What's new in v1.1.3

### Auto-tracked credit card bills (pay-in-full workflow)

Bills now have a third recurrence option: **Auto (CC)**. Pick a credit card account to track, set the statement close day and grace period, and the bill's amount becomes the live running balance of that card — recomputed on every render. This is built specifically for the pay-in-full workflow where the "amount you owe" changes every time you tap the card.

Concretely, this fixes the core problem with treating an RH-style pay-in-full card as a normal monthly bill: the amount isn't known until statement close, but in the meantime, every charge you make is real money you'll need to clear. Real-available cash should reflect that, and now it does.

#### How it works

The bill's amount = `balanceLatest(linkedAccount)`, clamped to ≥0. Add a charge, refresh, the bill amount goes up. Pay it down, the bill amount drops. The "Real available" calc on the Bills tab and the Home tab both subtract this live amount from your cash, so you always see what you'd have left if you cleared the card today.

Marking the bill paid logs a CC Payment for the current live amount from your configured "Pay From" account → the linked CC, which zeros out the balance. The "Paid" status badge appears on the row, but the amount displayed continues to track the live running balance — so if you swipe the card again right after paying, you immediately see the new balance and your real-available drops accordingly. (The badge is a "you've made a payment this month" indicator, not a "this month's done" claim.)

The due day is computed from `(closeDay + graceDays) mod 30`. With close=15 and grace=21 that's day 6 — which matches typical statement-due timing for a card whose statements close on the 15th.

#### The math note

For standard bills, `unpaid = total - paid`: once a bill is marked paid, it stops contributing to real-available because the cash already left. For auto-cc bills, that's wrong — paying just zeroes out the current balance, but new charges immediately re-accrue and still need to come out of cash. So auto-cc bills always contribute their **live amount** to the unpaid total, regardless of paid badge status. The badge is decoration; the math is live.

This is also why the upcoming-bills preview on Home now treats auto-cc bills slightly differently: a paid auto-cc bill with a live balance > $0 still shows up, because there's still real money owed.

#### Forecast

Cashflow Forecast projects auto-cc bills as a single event at the next statement-due date with the current live balance. We can't predict future card spending, so projecting one event is the most honest approximation — it'll under-estimate if you keep charging, but won't fabricate.

#### Schema additions

```
{
  ...,
  recurrence: 'auto-cc',
  linkedAccount: 'RH CC',  // name of the CC account to track
  closeDay: 15,            // 1-31, statement close day
  graceDays: 21,           // days from close to due, default 21
  // amount, dueDay, type, account, category — auto-derived, ignored
}
```

`type` is forced to `'CC Payment'`, `account` to `linkedAccount`, `category` to `'CC Payment'`. `dueDay` is recomputed on save for sort fallback purposes.

### Files touched

`bills.js` (helpers, render math, form, payBill), `home.js` (live-amount math + sort), `forecast.js` (auto-cc projection helper), `manage.js` (XLSX export columns), `index.html` (CSS for `.bill-auto-tag` and `.seg-3`), `util.js` and `sw.js` (version bumps).

---

## What's new in v1.1.2

### One-time bills

Bills used to be exclusively recurring monthly. Now each bill has a **Recurrence** toggle in the edit sheet — pick **Monthly** (the default, what bills did before) or **One-time**. One-time bills get a full date picker for "Due Date" instead of a day-of-month, and they only appear in the views for their target month — they don't follow you forward into June if they were dated for May.

This matters for "real available" accuracy. If you know a $450 car repair is hitting on the 15th, you can add it as a one-time bill and the Bills tab's `Cash − Unpaid bills = Available` calculation will reflect it immediately. Previously the only way to do this was to log a future-dated transaction (which would mess with monthly stats) or to mentally subtract it (which is what "real available" exists to avoid).

The bill row shows a small "Once" tag so one-time and monthly bills are visually distinguishable. Status logic (overdue / due today / due in N days) works the same way for both kinds.

If a one-time bill is saved with a date in a different month than the one currently being viewed, the toast tells you where it landed (e.g. "Saved · shows in July 2026"), so you don't think the save vanished.

### Where it shows up

- **Bills tab:** filters to applicable bills only. Totals (Bills total / Paid / Remaining) and the "Real available" calc all key off the filter.
- **Home tab:** the upcoming-bills preview likewise filters to bills applicable to the selected month.
- **Cashflow Forecast:** monthly bills project forward via dueDay as before; one-time bills land as a single occurrence on their dueDate (or skip if outside the 90-day window).
- **XLSX export:** the Bills sheet has two new columns, `Recurrence` and `Due Date`, so round-trip exports are lossless.

### Schema notes

Each bill now optionally has `recurrence: 'monthly' | 'once'` and `dueDate: 'YYYY-MM-DD'`. Old bills with neither field are treated as monthly — no migration needed. `dueDay` is still maintained on both kinds (for one-time bills it's derived from `dueDate.slice(8,10)`), so any existing code that reads `dueDay` for sorting or display still works.

### Files touched

`bills.js`, `home.js`, `forecast.js`, `manage.js` (XLSX export), `index.html` (CSS for `.seg` segmented control and `.bill-once-tag`), `util.js` and `sw.js` (version bumps).

---

## What's new in v1.1.1

A single bug fix, but a substantial one.

### Fix: starting balances now auto-cascade on every transaction change

In v1.1.0 (and earlier), the cascade that propagates a starting-balance change to subsequent months only fired when you manually edited a row in the Starting Balances sheet. It did **not** fire when you added, edited, or deleted a regular transaction. So if you set May's starting balance once back in March, then later logged a chunky April expense, May's stored starting was now stale — and the Home view showed nonsense like a credit card with a negative (credit) balance even though you'd just made a normal purchase.

Concretely: with my own data, an April 16 "Other Usage" charge of $2,576.80 was logged after May's starting had been cascaded based on April activity through the 14th. May's stored start stayed at $4,230.13 instead of updating to $6,795.15. After a May 1 balance transfer of $6,600 onto that stale base, Home showed Citi CC at -$2,369.87 (impossible — the card can't owe me money).

**Fix:** new `cascadeForChange(oldTxn, newTxn)` helper in `js/balances.js`. It computes the union of (account, year) pairs touched by the change, finds the earliest affected month for each, and re-cascades from there. Wired into all four mutation sites:

- `js/add.js` `saveTransaction()` — captures pre-edit snapshot before overwriting state, so date/account moves cascade across both the old and new positions
- `js/txns.js` delete handler
- `js/bills.js` `payBill` and `unpayBill`
- `js/home.js` Income→Refund migration intentionally skips this — the two types have identical effects in `txnEffects()`, so no balance moves

Cascading from earliest-affected-month rather than January preserves manually-set opening balances for accounts that started mid-year (the Affirm-loan tip in the Balances sheet still works correctly).

### Bonus: "Recompute Balances" action in More

For users upgrading from ≤ v1.1.0 with already-stale data, **More → Recompute Balances** does a one-shot pass over every (account, year) pair containing transactions, cascading from each one's earliest-txn month. Same preservation rule as above. After tapping this once, all your stored starts match reality. Going forward, you shouldn't ever need to use it — the auto-cascade has it covered.

### Files touched

`balances.js`, `add.js`, `txns.js`, `bills.js`, `home.js`, `manage.js`, `more.js`, `util.js` (version bump), `sw.js` (cache version bump).

---

## What's new in v1.1.0

Five new features + a refactor + a bug fix.

### Monthly Breakdown

**More → Monthly Breakdown.** For the selected month, shows every category under each transaction type (Income / Expenses / Investments / Refunds) — sorted by amount, with a percent-of-section bar and a month-over-month delta ("+$45 vs Mar"). Tap any row to drill into that category's individual transactions for the month.

### Year View (calendar heatmap)

**More → Year View.** All 365 days of the selected year as a heatmap: 12 mini-month calendars, each cell shaded by that day's net (green = money in, red = money out). Also surfaces best/worst day and YTD net. Tap any day for its transactions.

### Cashflow Forecast

**More → Cashflow Forecast.** 90-day projection of your checking balance, starting from today's cash position. Pulls events from three sources: detected recurring Income (paychecks, Prolific, etc.), detected recurring Expenses (subscriptions), and your configured Bills. Renders as a line chart plus a chronological list of upcoming events. Warns if the projection dips below 20% of starting cash.

### Smart Insights (on Home)

A new card on the Home screen auto-detects up to three observations about the current month. Examples of what it surfaces:

- "Restaurants is 185% of your 6-month median" (warn — spending outlier)
- "3 months in the green" (good — positive streak)
- "On pace for $2,400 in expenses — $320 above avg" (warn — burn rate)
- "Income is 125% of 6-mo avg" (good — income up)
- "Biggest category: Groceries · $420 · 22% of expenses" (neutral — fallback)

Detectors use your own 6-month history as the baseline, so insights stay relevant as your patterns shift.

### Merchant Memory (autocomplete in Add)

Start typing a description in the Add form and you'll see up to 5 past merchants matching what you typed, ranked by how often you've used them. Tapping a suggestion fills the description AND auto-sets the category and account based on your historical usage — so "Star" → taps "Starlink" and the whole form is already configured for Utilities → Chase Checking.

### Bug fix: picker inside sheets

In v1.0.5, changing the account inside the **Starting Balances** sheet (and actually also inside the Budgets sheet — you probably hadn't noticed) would close the sheet and require you to reopen it. Root cause was in `openPicker`: it called `closeSheet()` before the caller's re-render, which worked when the picker was opened over a plain view but broke when opened from inside another sheet. Fix: `openPicker` no longer auto-closes; the three callers in the Add form now close explicitly, and sheet-to-sheet callers simply re-render in place. The fix is documented in `js/sheet.js`.

### Architecture: split into 21 ES modules

The old single-file `index.html` ballooned to 3,416 lines. v1.1.0 splits it:

```
index.html           (shell + CSS — still single file for CSS)
sw.js
seed.json
manifest.webmanifest
icon-192.png, icon-512.png
js/
├── app.js           entry — init, navigate, month picker
├── util.js          constants, formatters, DOM, date helpers, toast
├── db.js            IndexedDB + state + loadState + seedFromJSON
├── effects.js       txnEffects, balanceAt, monthTotals, monthNetForAccount
├── sheet.js         openSheet / closeSheet / openPicker (bug fix lives here)
├── home.js          Home view + migration banner + budgets card
├── bills.js         Bills view + bill sheet + pay/unpay
├── add.js           Add form + merchant autocomplete wiring
├── txns.js          Activity view + txn sheet
├── debts.js         Debts view + debt plan sheet
├── more.js          More tab menu + action dispatcher
├── budgets.js       Budgets sheet
├── balances.js      Starting Balances sheet
├── networth.js      Net worth chart + snapshot sheet
├── subscriptions.js Recurring detector + sheet
├── manage.js        Accounts + Categories + Import/Export + About
├── merchants.js     Merchant memory (pure logic, no UI)
├── insights.js      Smart insights engine + home card
├── breakdown.js     Monthly Breakdown sheet (NEW)
├── yearview.js      Year View sheet (NEW)
└── forecast.js      Cashflow Forecast sheet (NEW)
```

Loaded via `<script type="module" src="js/app.js">`. No build step. The service worker caches all 21 modules on first install.

## Files

- `index.html` — shell + inline CSS
- `js/*.js` — the 21 ES modules
- `seed.json` — pre-seeded data (loaded only on fresh install / reset)
- `manifest.webmanifest` — PWA install metadata
- `sw.js` — service worker (offline + updated cache list)
- `icon-192.png` / `icon-512.png` — app icons

## Deploy

PWAs require HTTPS to install.

### Netlify Drop (~30 seconds, no account needed)
1. Go to https://app.netlify.com/drop
2. Drag the entire folder in
3. Open the URL on your phone
4. Install via "Add to Home Screen"

### GitHub Pages
```bash
gh repo create ledger-pwa --public --source=. --push
gh api repos/:owner/ledger-pwa/pages -f source[branch]=main -f source[path]=/
```

### Local test
```bash
python3 -m http.server 8000
```
Then visit `http://localhost:8000`. ES modules need to load over HTTP(S), not `file://`.

## Install on phone

- **iOS:** Safari → Share → Add to Home Screen
- **Android:** Chrome → menu → Install app

## Updating from v1.0.5

Just redeploy over the existing URL. The service worker auto-updates on next launch — the `VERSION` constant in `sw.js` bumped from `ledger-v1.0.5` to `ledger-v1.1.0` so the new cache supersedes the old one. Your IndexedDB data persists; no migration needed beyond the existing Refund banner from v1.0.5.

If the update doesn't land, More → About → **Check for updates** will force-refresh the cache.
