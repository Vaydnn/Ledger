/* ============================================================
   goals.js — NEW(v2.0): savings goals.

   A goal is { id, name, target, account|null, saved, targetDate|null,
   createdAt, archived }. Two progress modes:
   - Linked: progress = the live balance of a Checking/Savings account
     (one-account-per-purpose style — e.g. a dedicated savings account).
   - Manual: progress = the `saved` field, edited by hand or via the
     quick "+ Add" action on the goal row.

   Surfaces: a Goals card on Home (active goals with progress bars)
   and a full management sheet from the More menu.
   ============================================================ */

import { $, $$, fmt, fmtShort, clamp, uid, toast, toastAction, parseAmount, parseLocalDate, today, daysBetween, esc, haptic } from './util.js';
import { state, dbPut, dbDel } from './db.js';
import { balanceLatest } from './effects.js';
import { openSheet, closeSheet, openPicker } from './sheet.js';

export function goalProgress(g){
  if (g.account) return Math.max(0, balanceLatest(g.account));
  return Math.max(0, g.saved || 0);
}

/* ─── Home card ─────────────────────────── */
export function renderGoalsCard(){
  const active = state.goals.filter(g => !g.archived);
  if (!active.length) return '';
  return `
    <div class="card" style="margin-top:14px;">
      <h3 class="card-title">Savings Goals <span class="pill">${active.length}</span></h3>
      ${active.map(g => goalRowHTML(g, false)).join('')}
    </div>
  `;
}

function goalRowHTML(g, withActions){
  const saved = goalProgress(g);
  const target = g.target || 0;
  const pct = target > 0 ? clamp(saved / target, 0, 1) : 0;
  const done = target > 0 && saved >= target;
  let dateLine = '';
  if (g.targetDate && !done){
    const days = daysBetween(today(), g.targetDate);
    if (days >= 0){
      const left = target - saved;
      const months = Math.max(1, Math.ceil(days / 30.44));
      dateLine = `<span> · ${fmt(left / months).replace('−','')} /mo to hit ${g.targetDate}</span>`;
    } else {
      dateLine = `<span> · target date passed</span>`;
    }
  }
  return `
    <div class="goal-row" data-goal="${g.id}">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">
        <div style="font-size:13.5px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${done ? '✓ ' : ''}${esc(g.name)}</div>
        <div class="mono" style="font-size:12.5px;color:${done ? 'var(--green)' : 'var(--text-2)'};flex-shrink:0;">${fmtShort(saved)} / ${fmtShort(target)}</div>
      </div>
      <div class="bar" style="margin-top:6px;"><i style="width:${pct*100}%;${done?'background:var(--green);':''}"></i></div>
      <div class="muted small" style="margin-top:4px;">
        ${g.account ? `Linked to ${esc(g.account)}` : 'Manual tracking'}${dateLine}
      </div>
      ${withActions ? `
        <div style="display:flex;gap:6px;margin-top:8px;">
          ${!g.account && !done ? `<button class="btn secondary g-quick" data-id="${g.id}" style="flex:1;padding:8px;font-size:12px;">+ Add to goal</button>` : ''}
          <button class="btn ghost g-edit" data-id="${g.id}" style="width:auto;padding:8px 14px;font-size:12px;">Edit</button>
        </div>
      ` : ''}
    </div>
  `;
}

/* ─── Goals sheet (More menu) ─────────────────────────── */
export function openGoalsSheet(onChanged){
  const active = state.goals.filter(g => !g.archived);
  const archived = state.goals.filter(g => g.archived);

  $('#sheetBody').innerHTML = `
    <h2>Savings Goals</h2>
    ${active.length === 0 && archived.length === 0
      ? `<div class="empty" style="margin-bottom:14px;"><div class="big">No goals yet.</div>Set a target — emergency fund, baby fund, big purchase — and watch it fill up.</div>`
      : active.map(g => goalRowHTML(g, true)).join('')
    }
    ${archived.length ? `
      <div class="muted small" style="text-transform:uppercase;letter-spacing:.14em;margin:16px 0 8px;">Archived</div>
      ${archived.map(g => goalRowHTML(g, true)).join('')}
    ` : ''}
    <button class="btn" id="g-add" style="margin-top:12px;">+ New Goal</button>
  `;
  openSheet();

  $('#g-add').addEventListener('click', () => openGoalEditor(null, onChanged));
  $$('.g-edit').forEach(b => b.addEventListener('click', () => openGoalEditor(b.dataset.id, onChanged)));
  $$('.g-quick').forEach(b => b.addEventListener('click', () => {
    const g = state.goals.find(x => x.id === b.dataset.id);
    if (!g) return;
    const raw = prompt(`Add to "${g.name}" — how much?`);
    if (raw == null) return;
    const amt = parseAmount(raw);
    if (isNaN(amt) || amt <= 0){ toast('Enter a valid amount'); return; }
    g.saved = Math.max(0, (g.saved || 0) + amt);
    dbPut('goals', g).then(() => {
      toast(`Added ${fmt(amt)}`);
      if (typeof onChanged === 'function') onChanged();
      openGoalsSheet(onChanged);
    });
  }));
}

/* ─── Goal editor ─────────────────────────── */
function openGoalEditor(id, onChanged){
  const existing = id ? state.goals.find(g => g.id === id) : null;
  const linkable = state.accounts.filter(a => a.active && (a.type === 'Checking' || a.type === 'Savings'));
  const f = {
    name: existing?.name || '',
    target: existing?.target != null ? String(existing.target) : '',
    mode: existing?.account ? 'linked' : 'manual',
    account: existing?.account || linkable[0]?.name || null,
    saved: existing?.saved != null ? String(existing.saved) : '',
    targetDate: existing?.targetDate || '',
    archived: existing?.archived || false
  };

  function render(){
    $('#sheetBody').innerHTML = `
      <h2>${existing ? 'Edit' : 'New'} Goal</h2>
      <div class="field"><label>Name</label><input class="input" id="ge-name" value="${esc(f.name)}" placeholder="e.g. Emergency fund, Baby fund" /></div>
      <div class="field"><label>Target ($)</label><input class="input" id="ge-target" type="text" inputmode="decimal" value="${esc(f.target)}" placeholder="5000" /></div>
      <div class="field">
        <label>Track progress by</label>
        <div class="seg" id="ge-mode" role="tablist">
          <button type="button" class="seg-btn ${f.mode==='linked'?'active':''}" data-mode="linked">Account balance</button>
          <button type="button" class="seg-btn ${f.mode==='manual'?'active':''}" data-mode="manual">Manual amount</button>
        </div>
      </div>
      ${f.mode === 'linked' ? `
        <div class="field">
          <label>Linked Account <span class="muted small">(its live balance is the goal's progress)</span></label>
          <button class="input picker-btn" id="ge-acct" type="button">
            <span class="picker-val">${esc(f.account || '—')}</span>
            <span class="picker-chev">▾</span>
          </button>
        </div>
      ` : `
        <div class="field"><label>Saved so far ($)</label><input class="input" id="ge-saved" type="text" inputmode="decimal" value="${esc(f.saved)}" placeholder="0" /></div>
      `}
      <div class="field"><label>Target Date <span class="muted small">(optional — shows a monthly pace)</span></label><input class="input" id="ge-date" type="date" value="${f.targetDate}" /></div>
      ${existing ? `
        <div class="field">
          <label>Archived?</label>
          <div class="seg" id="ge-arch" role="tablist">
            <button type="button" class="seg-btn ${!f.archived?'active':''}" data-arch="false">No</button>
            <button type="button" class="seg-btn ${f.archived?'active':''}" data-arch="true">Yes</button>
          </div>
        </div>
      ` : ''}
      <button class="btn" id="ge-save">Save Goal</button>
      ${existing ? '<button class="btn danger" id="ge-del" style="margin-top:10px;">Delete Goal</button>' : ''}
      <button class="btn ghost" id="ge-back" style="margin-top:10px;">Back</button>
    `;

    $('#ge-name').addEventListener('input', e => f.name = e.target.value);
    $('#ge-target').addEventListener('input', e => f.target = e.target.value);
    $('#ge-date').addEventListener('input', e => f.targetDate = e.target.value);
    $('#ge-saved')?.addEventListener('input', e => f.saved = e.target.value);
    $$('.seg-btn', $('#ge-mode')).forEach(btn => btn.addEventListener('click', () => {
      if (f.mode === btn.dataset.mode) return;
      f.mode = btn.dataset.mode;
      render();
    }));
    if (existing){
      $$('.seg-btn', $('#ge-arch')).forEach(btn => btn.addEventListener('click', () => {
        f.archived = btn.dataset.arch === 'true';
        $$('.seg-btn', $('#ge-arch')).forEach(x => x.classList.toggle('active', x === btn));
      }));
    }
    $('#ge-acct')?.addEventListener('click', () => {
      if (!linkable.length){ toast('No checking/savings accounts to link'); return; }
      openPicker('Linked Account', linkable.map(a => a.name), f.account, (val) => {
        f.account = val;
        render();
      });
    });

    $('#ge-save').addEventListener('click', async () => {
      const name = f.name.trim();
      if (!name){ toast('Name required'); return; }
      const target = parseAmount(f.target);
      if (isNaN(target) || target <= 0){ toast('Enter a valid target'); return; }
      const saved = f.mode === 'manual' ? (isNaN(parseAmount(f.saved)) ? 0 : Math.max(0, parseAmount(f.saved))) : 0;
      if (f.mode === 'linked' && !f.account){ toast('Pick an account to link'); return; }
      const goal = {
        id: existing?.id || uid(),
        name, target,
        account: f.mode === 'linked' ? f.account : null,
        saved,
        targetDate: f.targetDate || null,
        createdAt: existing?.createdAt || today(),
        archived: f.archived
      };
      await dbPut('goals', goal);
      const i = state.goals.findIndex(g => g.id === goal.id);
      if (i >= 0) state.goals[i] = goal; else state.goals.push(goal);
      state.goals.sort((a,b) => String(a.name).localeCompare(String(b.name)));
      haptic(15); /* NEW(v2.2) */
      toast('Goal saved');
      if (typeof onChanged === 'function') onChanged();
      openGoalsSheet(onChanged);
    });
    $('#ge-del')?.addEventListener('click', async () => {
      // FIX(v2.9.2): immediate delete + Undo toast instead of confirm().
      const removed = { ...existing };
      await dbDel('goals', existing.id);
      state.goals = state.goals.filter(g => g.id !== existing.id);
      if (typeof onChanged === 'function') onChanged();
      openGoalsSheet(onChanged);
      toastAction(`Deleted "${removed.name}"`, 'Undo', async () => {
        await dbPut('goals', removed);
        state.goals.push(removed);
        state.goals.sort((a,b) => String(a.name).localeCompare(String(b.name)));
        if (typeof onChanged === 'function') onChanged();
        openGoalsSheet(onChanged);
      });
    });
    $('#ge-back').addEventListener('click', () => openGoalsSheet(onChanged));
  }

  render();
  openSheet();
}
