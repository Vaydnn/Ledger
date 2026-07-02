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
git commit -m "v2.10.0"
git push
```

- Pages redeploys automatically, ~60 seconds after push.
- On the phone, the service worker picks up the new version the next time
  you open the app (occasionally it takes one extra open-close cycle —
  the version number in More → About tells you what's live).

**Tiny edits without the PC:** any single file can be edited straight in
the GitHub web UI (open file → pencil icon → commit), including from the
phone's browser. Pages redeploys the same way.

---

## Running the tests (optional, at the PC)

```bash
npm install   # once
npm test      # 9 suites, ~300 checks, all synthetic data
```
