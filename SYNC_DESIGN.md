# Sync Design Notes — for v3.0

Decisions and groundwork captured during v2.3, so the sync release is purely
transport work. Scope: **single user, two devices** (Fold 6 + PC), offline-first,
IndexedDB stays the source of truth on each device.

## What v2.3 already laid down

- **`updatedAt`** stamped on every `dbPut` (epoch ms). Bulk puts (seed/restore)
  preserve an existing stamp — restores aren't edits.
- **Tombstones**: every hard delete writes `{id: "store:recordId", store,
  recordId, deletedAt}` to the `tombstones` store. Lets sync distinguish
  "deleted here" from "never seen there". Aged out after 180 days.
  Excluded stores: `meta`, `trash`, `tombstones`.
- **Write-boundary normalization** so malformed records can't replicate.
- **Cross-tab coherence** via BroadcastChannel — required on the PC anyway,
  and the same "reload state politely" machinery is what a sync pull will use.
- **Stable IDs**: `uid()` = timestamp + counter + 5-char random. Cross-device
  collision is effectively impossible; no work needed.

## Conflict model: last-write-wins, whole record

Single careful user, two devices, short offline windows. Field-level merging
is not worth its complexity here. Compare `updatedAt` vs tombstone `deletedAt`;
newest wins. A restore-from-trash naturally beats an older tombstone.

Clock skew: phone and PC both NTP-sync; LWW at human editing cadence is safe.
If the backend provides server receive-time, store it but still resolve on
client `updatedAt` (the user's intent ordering).

## Per-store sync scope

| Store | Sync? | Notes |
|---|---|---|
| transactions | ✅ | the core |
| accounts | ✅ | see name-FK caveat below |
| categories | ✅ | list-per-type records; LWW on the whole list record |
| budgets | ✅ | |
| bills | ✅ | `paidMonths` rides along inside the record |
| debtPlans | ✅ | |
| networth | ✅ | snapshots are append-mostly; trivial |
| goals | ✅ | |
| startingBalances | ⚠️ **partial** | see below |
| meta (flags/selected) | ❌ device-local | lastAutoNW, dismissed banners, selected month, scrub flag |
| trash | ❌ device-local | the *transaction* delete already tombstones; trash is a local undo buffer |
| tombstones | — | not synced as data; consumed by the protocol |

## startingBalances — the derived-data problem

These records mix **user-entered openings** with **cascade-computed carry-overs**
in the same rows. Syncing computed values invites two devices to fight over
numbers they each derive locally.

**Decision: do not sync this store.** On every pull that changes transactions,
re-run the full cascade locally (manage.js already has the one-shot recompute).
The only true user input here is a manually set opening for a year with no
prior activity — handle that one case by also re-entering it on the second
device, or (better, small v3.0 task) tag manually-edited rows with
`manual: true` and sync only those.

## Name-based foreign keys — accepted risk

Accounts are referenced by **name** in transactions, bills, debtPlans, goals,
startingBalances. Renaming cascades locally (v1.2/v2.0 tooling). Cross-device:
rename on device A while device B edits a referencing record offline → after
sync, B's record points at the old name (orphan).

**Decision: accept under LWW.** Migration to ID references touches everything
for a risk that requires simultaneous offline rename+edit by the same person.
Mitigations: (1) don't rename accounts while a device is known-stale;
(2) ship a small "orphan scan" in Manage that lists records whose
account/fromAccount/linkedAccount matches no existing account, with a
reassign picker — the rename-cascade code is 90% of it.

## Transport recommendation

**PocketBase, self-hosted** (single Go binary + SQLite on any $4 VPS or a box
at home). One collection per synced store with `(id, payload JSON, updatedAt,
deleted)` — server stays schema-dumb; the app owns meaning. Auth: PocketBase
email login, one user. Realtime subscriptions exist but polling on
focus/interval is enough for two devices.

Supabase works identically (Postgres instead of SQLite) if running a server
is unappealing — accept the free-tier pause-on-idle quirk.

## Sync loop sketch (client)

```
push:  records where updatedAt > lastPushAt  (+ tombstones since lastPushAt)
pull:  server records where updatedAt > lastPullAt
merge: per id — newest of (local.updatedAt, remote.updatedAt, tombstone.deletedAt) wins
post:  recompute startingBalances cascade; invalidate merchant cache; reload state
when:  app start, visibilitychange→visible, after any local write (debounced),
       manual "Sync now" in More
```

`lastPushAt` / `lastPullAt` live in `meta` (device-local). First-device
bootstrap: push everything. Second device: restore latest JSON backup first
(cheap, instant), then sync reconciles the delta.

## Pre-flight ritual for first sync

1. JSON backup on both devices (belt and suspenders).
2. Bootstrap the second device from the backup, not from an empty ledger —
   avoids a 1,000-record initial pull and any LWW surprises.
