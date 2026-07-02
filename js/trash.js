/* ============================================================
   trash.js — NEW(v2.0): soft-delete safety net for transactions.

   Deleting a transaction now moves it into the `trash` store instead
   of destroying it. The delete toast offers an inline Undo, the More
   menu exposes a Trash sheet (restore / delete forever), and items
   older than 30 days are purged on app start.

   Notes:
   - Restoring re-runs cascadeForChange so balances heal correctly.
   - If the deleted txn was a bill's auto-logged payment, the bill's
     paid flag was cleared on delete; restoring does NOT re-link it
     (the bill simply shows unpaid again — re-tap Pay if needed).
   ============================================================ */

import { $, $$, fmt, toast, esc } from './util.js';
import { state, dbAll, dbPut, dbDel } from './db.js';
import { openSheet } from './sheet.js';
import { cascadeForChange } from './balances.js';
import { invalidateMerchantCache } from './merchants.js';

const RETENTION_DAYS = 30;

/* Move a transaction into the trash store. Caller is responsible for
   removing it from `transactions` (store + state) — this only files
   the copy away with a deletion timestamp. */
export async function trashTxn(txn){
  await dbPut('trash', { ...txn, deletedAt: Date.now() });
}

/* Restore a trashed transaction back into the ledger. */
export async function restoreTxn(trashed){
  const { deletedAt, ...txn } = trashed;
  await dbDel('trash', trashed.id);
  await dbPut('transactions', txn);
  state.transactions.push(txn);
  state.transactions.sort((a,b) => (b.date||'').localeCompare(a.date||''));
  await cascadeForChange(null, txn);
  invalidateMerchantCache();
  return txn;
}

/* Purge anything older than RETENTION_DAYS. Called once on app start. */
export async function purgeTrash(){
  try {
    const items = await dbAll('trash');
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    for (const i of items){
      if ((i.deletedAt || 0) < cutoff) await dbDel('trash', i.id);
    }
  } catch(e){ console.warn('Trash purge failed', e); }
}

/* ─── Trash sheet (More menu) ─────────────────────────── */
export async function openTrashSheet(onChanged){
  const items = (await dbAll('trash')).sort((a,b) => (b.deletedAt||0) - (a.deletedAt||0));

  $('#sheetBody').innerHTML = `
    <h2>Trash</h2>
    <div class="muted small" style="margin-bottom:14px;line-height:1.5;">
      Deleted transactions are kept here for ${RETENTION_DAYS} days, then removed automatically.
    </div>
    ${items.length === 0
      ? `<div class="empty"><div class="big">Trash is empty.</div>Deleted transactions will appear here.</div>`
      : items.map(t => {
          const ago = daysAgoLabel(t.deletedAt);
          return `
            <div class="rec-row">
              <div style="min-width:0;flex:1;">
                <div style="font-size:13.5px;font-weight:500;">${esc(t.category || t.type)} · ${fmt(t.amount || 0)}</div>
                <div class="muted small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${t.date || '—'} · ${esc(t.account || '')}${t.description ? ' · ' + esc(t.description) : ''}</div>
                <div class="muted small" style="margin-top:2px;font-size:10.5px;">Deleted ${ago}</div>
              </div>
              <div style="display:flex;gap:6px;flex-shrink:0;">
                <button class="btn secondary tr-restore" data-id="${t.id}" style="width:auto;padding:8px 12px;font-size:12px;">Restore</button>
                <button class="btn danger tr-kill" data-id="${t.id}" style="width:auto;padding:8px 10px;font-size:12px;">×</button>
              </div>
            </div>
          `;
        }).join('')
    }
    ${items.length ? `<button class="btn danger" id="tr-empty" style="margin-top:12px;">Empty Trash</button>` : ''}
  `;
  openSheet();

  $$('.tr-restore').forEach(b => b.addEventListener('click', async () => {
    const item = items.find(x => x.id === b.dataset.id);
    if (!item) return;
    await restoreTxn(item);
    toast('Restored');
    if (typeof onChanged === 'function') onChanged();
    openTrashSheet(onChanged);
  }));
  $$('.tr-kill').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete forever? This cannot be undone.')) return;
    await dbDel('trash', b.dataset.id);
    openTrashSheet(onChanged);
  }));
  $('#tr-empty')?.addEventListener('click', async () => {
    if (!confirm(`Permanently delete all ${items.length} item${items.length===1?'':'s'} in the trash?`)) return;
    for (const i of items) await dbDel('trash', i.id);
    toast('Trash emptied');
    openTrashSheet(onChanged);
  });
}

function daysAgoLabel(ts){
  if (!ts) return 'a while ago';
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago · ${Math.max(0, RETENTION_DAYS - days)} left`;
}
