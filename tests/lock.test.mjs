/* v3.1 item 23: app lock. The app boots with the lock already on (and a
   launch shortcut in the URL), against a fake platform authenticator that
   behaves like Android's: create() makes a credential, get() returns an
   assertion over the given challenge with the user-verified flag. */
import { bootEnv, makeChecker, tick, domHelpers } from './_env.mjs';
const dom = await bootEnv({ url: 'https://ledger.test/?view=bills' });
const { check, done } = makeChecker();
const { $, $$, click, type } = domHelpers(dom);
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));

/* ── fake authenticator ── */
const enc = (u8) => Buffer.from(u8).toString('base64url');
const authn = { uv: true, fail: null, tamper: false, calls: 0, available: true };
globalThis.PublicKeyCredential = dom.window.PublicKeyCredential = {
  isUserVerifyingPlatformAuthenticatorAvailable: async () => authn.available
};
Object.defineProperty(navigator, 'credentials', { configurable: true, value: {
  async create({ publicKey }){
    authn.created = publicKey;
    return { rawId: crypto.getRandomValues(new Uint8Array(16)).buffer };
  },
  async get({ publicKey }){
    authn.calls++;
    if (authn.fail){ const e = new Error('The operation either timed out or was not allowed.'); e.name = authn.fail; throw e; }
    const id = new Uint8Array(publicKey.allowCredentials[0].id).slice();
    const challenge = authn.tamper ? crypto.getRandomValues(new Uint8Array(32)) : new Uint8Array(publicKey.challenge);
    const cd = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: enc(challenge), origin: 'https://ledger.test' }));
    const ad = new Uint8Array(37); ad[32] = authn.uv ? 0x05 : 0x01;   // UP (+ UV)
    return { rawId: id.buffer, response: { clientDataJSON: cd.buffer, authenticatorData: ad.buffer } };
  }
}});
// Controllable page visibility (jsdom has none) and clock.
let vis = 'visible';
Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => vis });
const setVisible = (v) => { vis = v; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); };
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

/* ── seed: data + a lock that's already on ── */
const { state, dbPut, exportData } = await import('../js/db.js');
const lock = await import('../js/lock.js');
await dbPut('accounts', { id:'a1', name:'Checking', type:'Checking', active:true, order:0 });
for (const [k, list] of Object.entries({ Expense:['Groceries'], Income:['Salary'], Refund:['Return'], Investment:['Brokerage'], CCPayment:['CC Payment'], LoanPayment:['Loan Payment'], Transfer:['Transfer'], BalanceTransfer:['Balance Transfer'] })){
  await dbPut('categories', { id:k, list });
}
const today = new Date().toISOString().slice(0, 10);
for (let i = 0; i < 14; i++){
  await dbPut('transactions', { id: 'tx' + i + Math.random().toString(36).slice(2, 8), date: today, type:'Expense', account:'Checking', category:'Groceries', amount: 10 + i, description:'' });
}
const pin = await lock.hashPin('2468');
const credId = await lock.registerBiometric();
check('a credential is requested from the phone authenticator, user verification required',
  authn.created.authenticatorSelection.authenticatorAttachment === 'platform' && authn.created.authenticatorSelection.userVerification === 'required');
await dbPut('meta', { id:'flags', anchorsV3: true, lock: { enabled: true, after: 1, credId, pinHash: pin.hash, pinSalt: pin.salt, pinLen: 4 } });

authn.fail = 'NotAllowedError';            // the user dismisses the first fingerprint prompt
await import('../js/app.js'); await tick(400);
const pressPin = async (digits) => { for (const d of digits) await click($(`.lock-key[data-k="${d}"]`), 5); await tick(450); };

/* ── locked on launch ── */
check('launch: Ledger opens locked', !!$('#lock') && dom.window.document.body.classList.contains('locked'));
check('…offering the fingerprint first (prompt shown automatically)', authn.calls === 1 && !!$('.lock-bio'));
check('…and the PIN after a dismissed prompt', /PIN/.test($('#lock-msg').textContent));
check('a launch shortcut waits for the unlock', state.view !== 'bills');
check('the lock screen is a modal dialog', $('#lock').getAttribute('role') === 'dialog' && $('#lock').getAttribute('aria-modal') === 'true');

await pressPin('1111');
check('wrong PIN → refused, attempts counted', !!$('#lock') && /Wrong PIN/.test($('#lock-msg').textContent) && state.flags.lock.fails === 1);
check('…and the dots clear', $$('#lock-dots i.on').length === 0);
await click($('.lock-key[data-k="2"]'), 5); await click($('.lock-key[data-k="⌫"]'), 5);
check('⌫ deletes a digit', $$('#lock-dots i.on').length === 0);
await pressPin('2468');
check('right PIN → unlocked', !$('#lock') && !dom.window.document.body.classList.contains('locked'));
check('…the failed-attempt count resets', state.flags.lock.fails === 0);
check('…and the launch shortcut runs now', state.view === 'bills');

/* ── auto-lock after time away ── */
authn.fail = null;
setVisible('hidden');
check('leaving Ledger shields the screen (app switcher)', dom.window.document.body.classList.contains('shield'));
skew += 20 * 1000;
setVisible('visible');
check('back within the time limit → no lock', !$('#lock') && !dom.window.document.body.classList.contains('shield'));
setVisible('hidden');
skew += 2 * 60 * 1000;
setVisible('visible');
check('back after 2 min (limit 1 min) → locked', !!$('#lock') && dom.window.document.body.classList.contains('locked'));
await tick(60);
check('…and the fingerprint unlocks it', !$('#lock') && authn.calls === 2);

/* ── a forged or unverified assertion doesn't unlock ── */
authn.uv = false;
setVisible('hidden'); skew += 5 * 60 * 1000; setVisible('visible'); await tick(60);
check('assertion without user verification → stays locked', !!$('#lock') && /not recognised/.test($('#lock-msg').textContent));
authn.uv = true; authn.tamper = true;
await click($('.lock-bio'), 60);
check('assertion over a different challenge → stays locked', !!$('#lock'));
authn.tamper = false;
await click($('.lock-bio'), 60);
check('a genuine assertion unlocks', !$('#lock'));

/* ── too many wrong PINs → a pause ── */
authn.fail = 'NotAllowedError';
setVisible('hidden'); skew += 5 * 60 * 1000; setVisible('visible'); await tick(60);
for (let i = 0; i < 5; i++) await pressPin('0000');
check('5 wrong PINs → 30s pause', state.flags.lock.fails === 5 && state.flags.lock.until > Date.now() && /try again in 30s/.test($('#lock-msg').textContent));
await pressPin('2468');
check('…even the right PIN waits', !!$('#lock') && /Too many tries/.test($('#lock-msg').textContent));
skew += 31 * 1000;
await pressPin('2468');
check('…then works', !$('#lock') && state.flags.lock.fails === 0);

/* ── device-only: never in a backup, never overwritten by a restore ── */
const backup = exportData();
check('backups leave the lock (and reminders) out', !('lock' in backup.flags) && !('reminders' in backup.flags));
const { restoreFromText } = await import('../js/manage.js');
await restoreFromText(JSON.stringify({ ...backup, flags: { ...backup.flags, theme: 'black', lock: { enabled: false } } }), 'old.json', () => {});
await tick(300);
check('restoring a backup keeps this phone\'s lock', state.flags.lock.enabled === true && state.flags.lock.pinHash === pin.hash);
check('…while its portable settings (theme) apply', dom.window.document.documentElement.dataset.theme === 'black');

/* ── forgot PIN → a backup file proves it's you ── */
setVisible('hidden'); skew += 5 * 60 * 1000; setVisible('visible'); await tick(60);
const fake = { transactions: Array.from({ length: 20 }, (_, i) => ({ id: 'guess' + i })), accounts: [] };
check('a made-up backup is refused', (await lock.unlockWithBackupText(JSON.stringify(fake))) === false && !!$('#lock') && /doesn't match/.test($('#lock-msg').textContent));
check('…as is a non-backup file', (await lock.unlockWithBackupText('not json')) === false && !!$('#lock'));
check('"Forgot PIN?" is on the lock screen', !!$('#lock-forgot'));
check('your real backup unlocks and turns the lock off', (await lock.unlockWithBackupText(JSON.stringify(backup))) === true && !$('#lock') && state.flags.lock.enabled === false && !state.flags.lock.pinHash);

/* ── Settings: turn it on, change timing, change PIN, turn it off ── */
const { openSettingsSheet } = await import('../js/settings.js');
openSettingsSheet(); await tick(30);
check('Settings has the app lock (off)', $('#st-lock .seg-btn.active')?.dataset.v === 'off' && $('#st-lock-setup').hidden);
await click($('#st-lock .seg-btn[data-v="on"]'), 30);
check('On → asks for a backup PIN', !$('#st-lock-setup').hidden && !!$('#st-pin'));
type('#st-pin', '12'); type('#st-pin2', '12');
await click($('#st-pin-save'), 60);
check('too-short PIN refused', /4 to 8/.test($('#st-pin-err').textContent) && !state.flags.lock.enabled);
type('#st-pin', '13579'); type('#st-pin2', '13570');
await click($('#st-pin-save'), 60);
check('mismatched PINs refused', /match/.test($('#st-pin-err').textContent) && !state.flags.lock.enabled);
type('#st-pin2', '13579');
await click($('#st-pin-save'), 600);
check('matching PINs → lock on, with fingerprint', state.flags.lock.enabled && !!state.flags.lock.credId && state.flags.lock.pinLen === 5);
check('…the sheet now shows the lock options', !!$('#st-lock-after') && /Fingerprint: on/.test($('#st-bio').textContent));
await click($('#st-lock-after .seg-btn[data-v="5"]'), 60);
check('lock-after saved', state.flags.lock.after === 5);
await click($('#st-pin-change'), 60);
check('Change PIN asks who you are first', !!$('#lock.lock-confirm') && !dom.window.document.body.classList.contains('locked'));
await click($('#lock-cancel'), 60);
check('…cancel leaves everything as it was', !$('#lock') && $('#st-lock-setup').hidden && state.flags.lock.pinLen === 5);
await click($('#st-lock .seg-btn[data-v="off"]'), 60);
check('turning it off needs your PIN', !!$('#lock.lock-confirm') && state.flags.lock.enabled);
// Physical keyboard works on the lock pad too (unfolded with a keyboard).
for (const k of '13579') dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
await tick(600);
check('…given → lock off', !$('#lock') && state.flags.lock.enabled === false);

/* ── no fingerprint hardware → PIN-only lock ── */
authn.available = false;
openSettingsSheet(); await tick(30);
await click($('#st-lock .seg-btn[data-v="on"]'), 30);
type('#st-pin', '8642'); type('#st-pin2', '8642');
await click($('#st-pin-save'), 600);
check('no authenticator → PIN-only lock', state.flags.lock.enabled && !state.flags.lock.credId);
await tick(30);
check('…and Settings says so', /PIN only/.test($('#st-bio').textContent));
setVisible('hidden'); skew += 10 * 60 * 1000; setVisible('visible'); await tick(60);
check('PIN-only lock screen has no fingerprint key', !!$('#lock') && !$('.lock-bio'));
await pressPin('8642');
check('…and opens with the PIN', !$('#lock'));
(await import('../js/sheet.js')).closeSheet(); await tick(30);

Date.now = realNow;
check('zero captured errors', errors.length === 0, errors[0]);
done('app lock tests');
