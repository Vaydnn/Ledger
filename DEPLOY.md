# Deploying Ledger via GitHub Pages

One-time setup is ~15 minutes. After that, every update is one `git push`.

> **Why the repo must be public:** GitHub Pages is free only on public repos
> (private-repo Pages requires GitHub Pro). That means the repo must contain
> **zero personal financial data** — and as of v2.9.1 it does: `seed.json`
> is synthetic demo data, and the tests run on synthetic fixtures. Your real
> transactions live only in your devices' IndexedDB.
>
> ⚠️ **Never commit a real backup.** JSON backups (`ledger-backup-*.json`)
> and Excel exports contain your entire financial history. Keep them outside
> this folder, or they will end up public on the next `git add -A`.

---

## Part 1 — One-time setup (at the PC)

### 1. Create the GitHub repo
1. Sign in at https://github.com (create an account if needed).
2. Top-right **+** → **New repository**.
3. Name: `ledger`. Visibility: **Public**. Do NOT initialize with a README
   (this folder already has one). → **Create repository**.

### 2. Push this folder
From a terminal inside this folder (Git required — `winget install Git.Git`
on Windows if you don't have it):

```bash
git init
git add -A
git commit -m "Ledger v2.9.1"
git branch -M main
git remote add origin https://github.com/<YOUR-USERNAME>/ledger.git
git push -u origin main
```

GitHub will prompt for login on first push (browser auth).

> **No-terminal fallback:** on the new repo's page click
> **uploading an existing file**, drag the entire folder contents in
> (everything except `node_modules`), and Commit. Works fine; the terminal
> route just makes future updates nicer.

### 3. Turn on GitHub Pages
1. Repo page → **Settings** → **Pages** (left sidebar).
2. Source: **Deploy from a branch**. Branch: **main**, folder: **/ (root)**. Save.
3. Wait ~1 minute, refresh: a banner shows your URL —
   **`https://<YOUR-USERNAME>.github.io/ledger/`**

That URL is now your app, hosted free, forever. Netlify can be retired.

---

## Part 2 — Install on the phone

1. Open `https://<YOUR-USERNAME>.github.io/ledger/` in **Samsung Internet**.
2. Menu (≡) → **Add page to** → **Home screen** (or tap the install banner).
3. Open it from the home screen — standalone, offline-capable, same as before.

### 2b. ⚠️ Migrate your data (don't skip)
The new URL is a **different origin** — its IndexedDB starts EMPTY. Your
data is still safe in the old Netlify app. Move it:

1. Open the **old** (Netlify) app → More → **Backup** → Export JSON.
2. Open the **new** (github.io) app → More → **Restore** → pick that JSON.
3. Verify: balances, transaction count, bills all look right.
4. Only then remove the old home-screen icon. (Keep the JSON file as a
   permanent restore point.)

---

## Part 3 — Updating the app (every release)

When we change things, you'll have a new set of files. From the repo folder:

```bash
# replace the changed files (or the whole folder contents), then:
git add -A
git commit -m "v3.1.0"
git push
```

- Pages redeploys automatically, ~60 seconds after push.
- On the phone, the app shows **"Update ready · Reload"** once the new
  version has installed (the version number in More → About tells you
  what's live).
- **Manifest changes** (v3.1 added app-icon shortcuts and "Share to
  Ledger") reach Android only when it refreshes the installed app, which
  can take a day or more. To get them now: take a backup, remove the
  home-screen app, open the site in the browser, *Add to Home screen*
  again. The data stays (same site), but keep the backup anyway.
- **Permissions** the v3.1 features ask for, the first time you turn
  them on (More → Settings): notifications (bill reminders), fingerprint
  (app lock). Background reminders also depend on the browser's
  Periodic Background Sync, which Chromium grants to installed apps you
  use regularly; when it isn't granted, reminders show when you open Ledger.

**Tiny edits without the PC:** any single file can be edited straight in
the GitHub web UI (open file → pencil icon → commit), including from the
phone's browser. Pages redeploys the same way.

### Tests gate the deploy (v3.0)

`.github/workflows/pages.yml` runs the test suite on every push and only
deploys if it passes — a broken change never reaches the phone. It also
publishes only the app files (no tests/docs). One-time switch:

1. Repo → **Settings** → **Pages** → *Build and deployment* → **Source:
   GitHub Actions** (instead of "Deploy from a branch").
2. Push. The **Actions** tab shows *Test & deploy*: a green `test` job,
   then `deploy`. Same URL as before; nothing on the phone changes.

Until that switch is made, the branch deploy keeps working as before and
the workflow's `deploy` job fails harmlessly (tests still run).

> ⚠️ **Never commit a real backup or statement.** `.gitignore` blocks
> `ledger-backup-*.json` and `*.csv` — keep them outside this folder anyway.

---

## Running the tests (at the PC)

Requires Node 20+ (`winget install OpenJS.NodeJS.LTS` on Windows).

```bash
npm install   # once
npm test      # 23 suites, 775 checks, all synthetic data
```
