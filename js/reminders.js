/* ============================================================
   reminders.js — NEW(v3.1): bill reminders + app-icon badge.

   - Turning reminders on asks for notification permission, then registers
     Periodic Background Sync ('ledger-bill-reminders') so the service
     worker can notify with the app closed (sw.js runReminders). Chromium
     only, and at the browser's discretion (~every 12h, needs the app
     installed and used regularly).
   - Where background sync isn't available, the reminder shows when you
     open the app instead — at most once a day.
   - The badge (overdue + due today) is refreshed on every render.
   Settings: flags.reminders = { enabled, daysAhead, badge, background }.
   ============================================================ */

import './remind-core.js';
import { state, saveFlags } from './db.js';
import { today, toast } from './util.js';

const R = () => globalThis.LedgerRemind;
export const REMIND_TAG = 'ledger-bill-reminders';

export function reminderSettings(){
  return { enabled: false, daysAhead: 2, badge: true, background: false, ...(state.flags.reminders || {}) };
}
export async function setReminders(patch){
  state.flags.reminders = { ...reminderSettings(), ...patch };
  await saveFlags();
}

export async function registerPeriodicSync(){
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (!reg || !('periodicSync' in reg)) return false;
    const status = await navigator.permissions?.query({ name: 'periodic-background-sync' }).catch(() => null);
    if (status && status.state !== 'granted') return false;
    await reg.periodicSync.register(REMIND_TAG, { minInterval: 12 * 60 * 60 * 1000 });
    return true;
  } catch(e){ return false; }
}

// Returns { ok, background } — background=false means "reminds when you open the app".
export async function enableReminders(){
  if (typeof Notification === 'undefined'){ toast("This browser can't show notifications"); return { ok: false }; }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted'){ toast('Notifications are blocked for Ledger — allow them in Android settings → Apps'); return { ok: false }; }
  const background = await registerPeriodicSync();
  await setReminders({ enabled: true, background });
  return { ok: true, background };
}

export async function disableReminders(){
  await setReminders({ enabled: false, background: false });
  try { const reg = await navigator.serviceWorker?.ready; await reg?.periodicSync?.unregister(REMIND_TAG); } catch(e){}
}

export function dueSoon(){
  return R().dueBills(state.bills, today(), { daysAhead: reminderSettings().daysAhead });
}

export async function updateBadge(){
  if (typeof navigator === 'undefined' || !('setAppBadge' in navigator)) return null;
  const n = reminderSettings().badge ? R().badgeCount(state.bills, today()) : 0;
  try { n ? await navigator.setAppBadge(n) : await navigator.clearAppBadge(); } catch(e){}
  return n;
}

// Foreground fallback (no background sync): one notification per day.
export async function remindOnOpen(){
  const s = reminderSettings();
  if (!s.enabled || s.background || typeof Notification === 'undefined' || Notification.permission !== 'granted') return null;
  const day = today();
  if (state.flags.lastReminderDay === day) return null;
  const due = dueSoon();
  if (!due.length) return null;
  const sm = R().summary(due, { hideAmounts: !!state.flags.privacy });
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    const opts = { body: sm.body, tag: 'ledger-bills', icon: './icon-192.png', data: { url: './index.html?view=bills' } };
    if (reg?.showNotification) await reg.showNotification(sm.title, opts);
    else new Notification(sm.title, opts);
  } catch(e){ return null; }
  state.flags.lastReminderDay = day;
  await saveFlags();
  return sm;
}
