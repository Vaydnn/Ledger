/* ============================================================
   settings.js — NEW(v3.1): More → Settings. One place for the device-level
   preferences added in v3.1: bill reminders, app-icon badge, app lock,
   privacy mode, theme, the number pad, and Home's layout.
   All live in flags (device-local meta record).
   ============================================================ */

import { $, $$, toast, esc } from './util.js';
import { state, saveFlags } from './db.js';
import { openSheet } from './sheet.js';
import { reminderSettings, setReminders, enableReminders, disableReminders, updateBadge, dueSoon } from './reminders.js';
import { openHomeCustomizeSheet } from './home.js';
import { lockSettings, LOCK_AFTER, enableLock, disableLock, changePin, addFingerprint, setLockAfter, biometricAvailable, confirmIdentity } from './lock.js';
import { privacyOn, setPrivacy, theme, setTheme } from './appearance.js';

const seg = (id, opts, cur) => `
  <div class="seg" id="${id}" role="tablist">
    ${opts.map(([v, label]) => `<button type="button" class="seg-btn ${String(cur) === String(v) ? 'active' : ''}" data-v="${esc(v)}">${esc(label)}</button>`).join('')}
  </div>`;

const pinFields = (cta) => `
  <div class="field"><label for="st-pin">Backup PIN (4–8 digits)</label>
    <input id="st-pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" /></div>
  <div class="field"><label for="st-pin2">Same PIN again</label>
    <input id="st-pin2" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" /></div>
  <div class="muted small" id="st-pin-err" style="color:var(--red);min-height:1em;"></div>
  <button type="button" class="btn" id="st-pin-save">${esc(cta)}</button>`;

export function openSettingsSheet(){
  const r = reminderSettings();
  const l = lockSettings();
  const notifSupported = typeof Notification !== 'undefined';
  const badgeSupported = typeof navigator !== 'undefined' && 'setAppBadge' in navigator;
  const due = dueSoon();
  $('#sheetBody').innerHTML = `
    <h2>Settings</h2>

    <div class="section-label">Bill reminders</div>
    ${seg('st-remind', [['off','Off'],['on','On']], r.enabled ? 'on' : 'off')}
    <div class="muted small" style="margin:8px 0 6px;line-height:1.5;">
      ${!notifSupported ? "This browser can't show notifications."
        : r.enabled ? (r.background ? 'On — Android notifies you even when Ledger is closed (about twice a day, when the browser allows).'
                                    : 'On — you\'ll be reminded when you open Ledger (background reminders aren\'t available in this browser).')
        : 'A notification when bills are due soon or overdue.'}
      ${due.length ? `<br><b>${due.length} due within ${r.daysAhead} day${r.daysAhead === 1 ? '' : 's'} right now.</b>` : ''}
    </div>
    <div class="field" style="margin-top:6px;"><label>Remind me</label>
      ${seg('st-ahead', [[1,'1 day before'],[2,'2 days'],[3,'3 days']], r.daysAhead)}
    </div>

    <div class="section-label">App icon badge</div>
    ${seg('st-badge', [['on','Show count'],['off','Off']], r.badge ? 'on' : 'off')}
    <div class="muted small" style="margin-top:8px;line-height:1.5;">${badgeSupported ? 'The number on the Ledger icon = bills overdue or due today.' : 'Your launcher doesn\'t support app badges from this browser.'}</div>

    <div class="section-label">App lock</div>
    ${seg('st-lock', [['off','Off'],['on','On']], l.enabled ? 'on' : 'off')}
    <div class="muted small" style="margin:8px 0 6px;line-height:1.5;">
      Fingerprint (or your phone's screen lock) to open Ledger, with a backup PIN.
      It stops someone who picks up your unlocked phone — your data itself isn't encrypted.
    </div>
    <div id="st-lock-setup" hidden>${l.enabled ? '' : pinFields('Turn on app lock')}</div>
    ${l.enabled ? `
      <div class="field" style="margin-top:6px;"><label>Lock after leaving Ledger for</label>
        ${seg('st-lock-after', LOCK_AFTER, l.after)}
      </div>
      <div class="muted small" id="st-bio" style="margin:4px 0 8px;">${l.credId ? 'Fingerprint: on' : ''}</div>
      <button type="button" class="btn ghost" id="st-pin-change">Change PIN</button>` : ''}

    <div class="section-label">Privacy mode</div>
    ${seg('st-privacy', [['off','Off'],['on','Blur amounts']], privacyOn() ? 'on' : 'off')}
    <div class="muted small" style="margin-top:8px;line-height:1.5;">Dollar amounts stay blurred until you tap them; the eye at the top shows them all. Bill notifications leave amounts out.</div>

    <div class="section-label">Theme</div>
    ${seg('st-theme', [['dark','Dark'],['black','Pure black']], theme())}
    <div class="muted small" style="margin-top:8px;line-height:1.5;">Pure black switches the Fold's OLED pixels fully off behind the app.</div>

    <div class="section-label">Adding transactions</div>
    ${seg('st-pad', [['pad','Number pad'],['keyboard','System keyboard']], state.flags.amountInput === 'keyboard' ? 'keyboard' : 'pad')}

    <div class="section-label">Home</div>
    <button class="btn ghost" id="st-home">Customize Home…</button>
  `;
  openSheet();

  wireSeg('st-remind', async (v) => {
    if (v === 'on'){
      const res = await enableReminders();
      if (res.ok) toast(res.background ? 'Reminders on — even when Ledger is closed' : 'Reminders on — shown when you open Ledger');
    } else { await disableReminders(); toast('Reminders off'); }
  });
  wireSeg('st-ahead', async (v) => setReminders({ daysAhead: Number(v) }));
  wireSeg('st-badge', async (v) => { await setReminders({ badge: v === 'on' }); await updateBadge(); });
  wireSeg('st-privacy', async (v) => setPrivacy(v === 'on'));
  wireSeg('st-theme', async (v) => setTheme(v));
  wireSeg('st-pad', async (v) => { state.flags.amountInput = v; await saveFlags(); });
  $('#st-home').addEventListener('click', openHomeCustomizeSheet);
  wireLock(l);
}

// A segmented control whose choice is saved and then shown (sheet re-rendered).
function wireSeg(id, fn){
  $$(`#${id} .seg-btn`).forEach(b => b.addEventListener('click', async () => {
    await fn(b.dataset.v);
    openSettingsSheet();
  }));
}

function wireLock(l){
  // Off → On reveals the PIN form; On → Off needs your fingerprint/PIN first.
  $$('#st-lock .seg-btn').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.v === 'on' && !l.enabled){
      $('#st-lock-setup').hidden = false;
      $$('#st-lock .seg-btn').forEach(x => x.classList.toggle('active', x === b));
      $('#st-pin').focus();
    } else if (b.dataset.v === 'off' && l.enabled){
      if (await disableLock()) toast('App lock off');
      openSettingsSheet();
    }
  }));
  wireSeg('st-lock-after', async (v) => setLockAfter(v));
  $('#st-pin-change')?.addEventListener('click', async () => {
    if (!await confirmIdentity('Change PIN')) return;
    const box = $('#st-lock-setup');
    box.innerHTML = pinFields('Save new PIN');
    box.hidden = false;
    wirePinForm(async (pin) => {
      const res = await changePin(pin);
      if (res.ok) toast('PIN changed');
      return res;
    });
    $('#st-pin').focus();
  });
  if (!l.enabled) wirePinForm(async (pin) => {
    const res = await enableLock(pin);
    if (res.ok) toast(res.fingerprint ? 'App lock on — fingerprint + PIN' : 'App lock on — PIN only (fingerprint unavailable)');
    return res;
  });
  if (l.enabled && !l.credId){
    biometricAvailable().then(ok => {
      const el = $('#st-bio');
      if (!el) return;
      if (!ok){ el.textContent = "Fingerprint isn't available in this browser — PIN only."; return; }
      el.innerHTML = '<button type="button" class="btn ghost" id="st-bio-add">Add fingerprint</button>';
      $('#st-bio-add').addEventListener('click', async () => {
        toast(await addFingerprint() ? 'Fingerprint added' : "Fingerprint wasn't set up");
        openSettingsSheet();
      });
    });
  }
}

function wirePinForm(save){
  const btn = $('#st-pin-save');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const a = $('#st-pin').value.trim(), b = $('#st-pin2').value.trim();
    const err = $('#st-pin-err');
    if (!/^\d{4,8}$/.test(a)){ err.textContent = 'Use 4 to 8 digits.'; return; }
    if (a !== b){ err.textContent = "The two PINs don't match."; return; }
    btn.disabled = true;
    const res = await save(a);
    btn.disabled = false;
    if (!res.ok){ err.textContent = res.error || 'Could not save'; return; }
    openSettingsSheet();
  });
}
