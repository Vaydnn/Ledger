/* ============================================================
   lock.js — NEW(v3.1): app lock.

   - Fingerprint via WebAuthn with the phone's own authenticator
     (userVerification 'required' — Android's prompt also offers the
     phone's PIN/pattern), plus a backup PIN that's always set, so a
     missing or broken fingerprint can never shut you out.
   - Locks on every launch and after Ledger has been in the background
     longer than the chosen time. While locked the app is hidden.
   - "Forgot PIN?" unlocks with one of your backup files: it has to hold
     this device's transactions, which nobody without your data can fake.
   Honest scope: the data in IndexedDB isn't encrypted. This stops
   someone who picks up your unlocked phone, not someone with a forensic
   tool. Settings live in flags.lock, which never leaves this device.
   ============================================================ */

import { $, $$, toast, esc, JSON_ACCEPT } from './util.js';
import { state, saveFlags } from './db.js';

const b64u = {
  enc(buf){
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str){
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  }
};

export const LOCK_AFTER = [[0.5, '30 sec'], [1, '1 min'], [5, '5 min'], [15, '15 min']];
const MAX_TRIES = 5;

export function lockSettings(){
  return { enabled: false, after: 1, credId: null, pinHash: null, pinSalt: null, pinLen: 4, fails: 0, until: 0, ...(state.flags.lock || {}) };
}
async function setLock(patch){
  state.flags.lock = { ...lockSettings(), ...patch };
  await saveFlags();
}

/* ── secrets ── */
export async function hashPin(pin, saltB64){
  const salt = saltB64 ? b64u.dec(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 150000 }, key, 256);
  return { hash: b64u.enc(bits), salt: b64u.enc(salt) };
}
export async function checkPin(pin){
  const l = lockSettings();
  if (!l.pinHash) return false;
  return (await hashPin(pin, l.pinSalt)).hash === l.pinHash;
}

export async function biometricAvailable(){
  try { return !!(globalThis.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
  catch(e){ return false; }
}
// Creates a credential on this phone's authenticator; returns its id.
export async function registerBiometric(){
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { name: 'Ledger' },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'Ledger', displayName: 'Ledger app lock' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
    timeout: 60000, attestation: 'none'
  }});
  if (!cred?.rawId) throw new Error('No credential');
  return b64u.enc(cred.rawId);
}
// True only for an assertion that answers this challenge, from our
// credential, with the user verified (authenticatorData flags bit 2).
export async function verifyBiometric(){
  const l = lockSettings();
  if (!l.credId) return false;
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const a = await navigator.credentials.get({ publicKey: {
    challenge, userVerification: 'required', timeout: 60000,
    allowCredentials: [{ type: 'public-key', id: b64u.dec(l.credId), transports: ['internal'] }]
  }});
  if (!a?.response) return false;
  const cd = JSON.parse(new TextDecoder().decode(a.response.clientDataJSON));
  const flags = new Uint8Array(a.response.authenticatorData)[32];
  return cd.type === 'webauthn.get' && cd.challenge === b64u.enc(challenge) && b64u.enc(a.rawId) === l.credId && (flags & 0x04) === 0x04;
}

// A backup proves ownership when it holds this device's transactions
// (ids carry random bits — they can't be guessed).
export function backupProvesOwnership(data){
  if (!data || !Array.isArray(data.transactions)) return false;
  const ids = new Set(data.transactions.map(t => t?.id));
  const mine = state.transactions.map(t => t.id);
  if (!mine.length) return true;
  return mine.filter(id => ids.has(id)).length >= Math.min(10, mine.length);
}

/* ── lock state ── */
let locked = false;
let waiters = [];
let hiddenAt = 0;
let busy = false;        // a fingerprint prompt / file picker is up — don't relock under it

export const isLocked = () => locked;
export const whenUnlocked = () => locked ? new Promise(r => waiters.push(r)) : Promise.resolve();

export function lockNow(){
  if (!lockSettings().enabled || locked) return false;
  locked = true;
  document.body.classList.add('locked');
  showPad({ confirm: false }).then(() => {
    locked = false;
    hiddenAt = 0;
    document.body.classList.remove('locked', 'shield');
    const w = waiters; waiters = [];
    w.forEach(f => f());
  });
  return true;
}

// "Confirm it's you" before turning the lock off or changing the PIN.
export function confirmIdentity(title){
  if (!lockSettings().enabled) return Promise.resolve(true);
  return showPad({ confirm: true, title });
}

export function setupAutoLock(){
  document.addEventListener('visibilitychange', () => {
    const l = lockSettings();
    if (!l.enabled) return;
    if (document.visibilityState === 'hidden'){
      if (busy) return;
      hiddenAt = Date.now();
      document.body.classList.add('shield');        // keeps amounts out of the app switcher
      return;
    }
    if (locked){ autoBio(); return; }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    if (hiddenAt && away >= l.after * 60000) lockNow();
    else document.body.classList.remove('shield');
  });
}

/* ── the pad ── */
let current = null;      // { el, resolve, confirm, entry }

function showPad({ confirm, title }){
  return new Promise(resolve => {
    $('#lock')?.remove();
    const l = lockSettings();
    const el = document.createElement('div');
    el.id = 'lock';
    el.className = 'lock' + (confirm ? ' lock-confirm' : '');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', confirm ? (title || "Confirm it's you") : 'Ledger is locked');
    const keys = ['1','2','3','4','5','6','7','8','9', l.credId ? 'bio' : '', '0', '⌫'];
    el.innerHTML = `
      <div class="lock-box">
        <div class="lock-mark">Ledger<span>.</span></div>
        <div class="lock-msg" id="lock-msg" aria-live="polite">${esc(confirm ? (title || "Confirm it's you") : 'Enter your PIN')}</div>
        <div class="lock-dots" id="lock-dots">${'<i></i>'.repeat(l.pinLen)}</div>
        <div class="lock-pad">
          ${keys.map(k => k === '' ? '<span></span>'
            : k === 'bio' ? `<button type="button" class="lock-key lock-bio" data-k="bio" aria-label="Use fingerprint"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 11v3a6 6 0 0 1-1.5 4"/><path d="M8.5 9.5A4 4 0 0 1 16 11v2.5a10 10 0 0 1-.8 4"/><path d="M5.5 15.5A12 12 0 0 0 6 11a6 6 0 0 1 9-5.2"/><path d="M18 7.5a8 8 0 0 1 .9 3.5v1.5"/></svg></button>`
            : `<button type="button" class="lock-key" data-k="${k}" aria-label="${k === '⌫' ? 'Delete' : k}">${k}</button>`).join('')}
        </div>
        <div class="lock-links">
          ${confirm ? '<button type="button" class="link-btn" id="lock-cancel">Cancel</button>'
                    : '<button type="button" class="link-btn" id="lock-forgot">Forgot PIN?</button>'}
        </div>
      </div>`;
    document.body.appendChild(el);
    const finish = (ok) => {
      document.removeEventListener('keydown', onKey, true);
      el.remove();
      current = null;
      resolve(ok);
    };
    current = { el, finish, confirm, entry: '' };
    const onKey = (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('⌫');
      else if (e.key === 'Escape' && confirm) finish(false);
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    $$('.lock-key', el).forEach(b => b.addEventListener('click', () => b.dataset.k === 'bio' ? tryBio() : press(b.dataset.k)));
    $('#lock-cancel', el)?.addEventListener('click', () => finish(false));
    $('#lock-forgot', el)?.addEventListener('click', forgot);
    paintDots();
    autoBio();
  });
}

function paintDots(){
  if (!current) return;
  $$('#lock-dots i', current.el).forEach((d, i) => d.classList.toggle('on', i < current.entry.length));
}
function say(msg, bad){
  const m = current && $('#lock-msg', current.el);
  if (!m) return;
  m.textContent = msg;
  if (bad){ current.el.classList.remove('shake'); void current.el.offsetWidth; current.el.classList.add('shake'); }
}

async function press(k){
  if (!current || current.checking) return;
  const l = lockSettings();
  if (l.until > Date.now()){ say(`Too many tries — wait ${Math.ceil((l.until - Date.now()) / 1000)}s`, true); return; }
  if (k === '⌫'){ current.entry = current.entry.slice(0, -1); paintDots(); return; }
  if (current.entry.length >= l.pinLen) return;
  current.entry += k;
  paintDots();
  if (current.entry.length < l.pinLen) return;
  const cur = current;
  cur.checking = true;
  const ok = await checkPin(cur.entry);
  cur.checking = false;
  if (current !== cur) return;
  if (ok){
    if (l.fails || l.until) await setLock({ fails: 0, until: 0 });
    cur.finish(true);
    return;
  }
  const fails = l.fails + 1;
  const until = fails >= MAX_TRIES ? Date.now() + Math.min(15 * 60, 30 * 2 ** (fails - MAX_TRIES)) * 1000 : 0;
  await setLock({ fails, until });
  cur.entry = '';
  paintDots();
  say(until ? `Wrong PIN — try again in ${Math.round((until - Date.now()) / 1000)}s` : `Wrong PIN (${MAX_TRIES - fails} left before a pause)`, true);
}

async function tryBio(){
  const cur = current;
  if (!cur || busy || !lockSettings().credId) return;
  busy = true;
  try {
    if (await verifyBiometric()){ if (current === cur) cur.finish(true); }
    else say('Fingerprint not recognised — use your PIN', true);
  } catch(e){
    if (current === cur) say('Use your PIN, or tap the fingerprint to try again');
  } finally { busy = false; }
}
function autoBio(){
  if (current && lockSettings().credId && document.visibilityState !== 'hidden') tryBio();
}

function forgot(){
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = JSON_ACCEPT;
  busy = true;
  input.addEventListener('change', async () => {
    busy = false;
    const f = input.files?.[0];
    if (!f) return;
    await unlockWithBackupText(await f.text());
  });
  input.addEventListener('cancel', () => { busy = false; });
  input.click();
}

export async function unlockWithBackupText(text){
  let data = null;
  try { data = JSON.parse(text); } catch(e){}
  if (!backupProvesOwnership(data)){ say("That backup doesn't match this device's data", true); return false; }
  await setLock({ enabled: false, credId: null, pinHash: null, pinSalt: null, fails: 0, until: 0 });
  current?.finish(true);
  toast('Unlocked with your backup — app lock is off. Set it up again in More → Settings.');
  return true;
}

/* ── Settings actions ── */
// Sheet-free setup: the Settings sheet hosts the PIN fields (settings.js).
export async function enableLock(pin){
  if (!/^\d{4,8}$/.test(pin)) return { ok: false, error: 'PIN must be 4–8 digits' };
  const { hash, salt } = await hashPin(pin);
  let credId = null, bioError = null;
  if (await biometricAvailable()){
    busy = true;
    try { credId = await registerBiometric(); } catch(e){ bioError = e; }
    finally { busy = false; }
  }
  await setLock({ enabled: true, pinHash: hash, pinSalt: salt, pinLen: pin.length, credId, fails: 0, until: 0 });
  return { ok: true, fingerprint: !!credId, bioError };
}
export async function disableLock(){
  if (!await confirmIdentity('Turn off app lock')) return false;
  await setLock({ enabled: false, credId: null, pinHash: null, pinSalt: null, fails: 0, until: 0 });
  return true;
}
export async function changePin(pin){
  if (!/^\d{4,8}$/.test(pin)) return { ok: false, error: 'PIN must be 4–8 digits' };
  const { hash, salt } = await hashPin(pin);
  await setLock({ pinHash: hash, pinSalt: salt, pinLen: pin.length });
  return { ok: true };
}
export async function addFingerprint(){
  busy = true;
  try { await setLock({ credId: await registerBiometric() }); return true; }
  catch(e){ return false; }
  finally { busy = false; }
}
export async function setLockAfter(min){ await setLock({ after: Number(min) }); }
