/* v3.1 Fold layout (items 6–18), driven at the Fold 8 Ultra's two widths:
   cover ≈ 411 CSS px, inner ≈ 860. jsdom has no layout engine, so these
   check the JS-side behavior (what renders where, modes, continuity) —
   the CSS is verified visually in the browser pane. */
import { bootEnv, makeChecker, tick, domHelpers, setViewport, setPosture } from './_env.mjs';
const dom = await bootEnv({ width: 411, height: 960 });
dom.window.ontouchstart = null;   // a touch device, so touch-only wiring (month swipe) runs
const { check, done } = makeChecker();
const { $, $$, click } = domHelpers(dom);
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));

const { state, dbPut, loadState } = await import('../js/db.js');
const app = await import('../js/app.js'); await tick(150);
const layout = await import('../js/layout.js');

await dbPut('accounts', { id:'a1', name:'Checking', type:'Checking', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'Card', type:'Credit Card', active:true, order:1 });
for (const [k, list] of Object.entries({ Expense:['Groceries','Restaurants'], Income:['Salary'], Refund:['Return'], Investment:['Brokerage'], CCPayment:['CC Payment'], LoanPayment:['Loan Payment'], Transfer:['Transfer'], BalanceTransfer:['Balance Transfer'] })){
  await dbPut('categories', { id:k, list });
}
const today = new Date().toISOString().slice(0, 10);
for (let i = 0; i < 6; i++) await dbPut('transactions', { id:'t'+i, date:today, type:'Expense', account:'Card', category: i % 2 ? 'Groceries' : 'Restaurants', amount: 10 + i, description:'shop '+i });
await loadState();
state.flags.anchorsV3 = true;
await tick(700);

/* ── 6. About → This screen ── */
const manage = await import('../js/manage.js');
manage.openAboutSheet(); await tick(30);
const disp = () => $('#about-display')?.textContent || '';
check('About shows the viewport size', disp().includes('411 × 960'), disp());
check('folded → phone layout', disp().includes('Folded / phone layout'));
setViewport(860, 955); await tick(30);
check('readout updates live on unfold', disp().includes('860 × 955') && disp().includes('Unfolded layout'), disp());
setViewport(411, 960); await tick(30);
check('…and back on fold', disp().includes('411 × 960'));

/* ── 7. breakpoint at 700px ── */
const { closeSheet } = await import('../js/sheet.js');
closeSheet(); await tick(30);
check('cover (411) is the phone layout', !layout.isWide() && !document.body.classList.contains('is-wide'));
setViewport(699); await tick(20);
check('699px is still phone layout (old 560 breakpoint would have flipped)', !layout.isWide());
setViewport(700); await tick(20);
check('700px is the unfolded layout', layout.isWide() && document.body.classList.contains('is-wide'));
setViewport(860, 955); await tick(20);
check('inner portrait (860) unfolded', layout.isWide());
setViewport(955, 860); await tick(20);
check('inner landscape (955) unfolded', layout.isWide());
setViewport(411, 960); await tick(20);
check('folding back removes the class', !document.body.classList.contains('is-wide'));
check('CSS uses the same breakpoint', /@media \(min-width: 700px\)/.test(require_html()) && !/min-width: 560px/.test(require_html()));
function require_html(){ return (globalThis.__html ||= dom.window.document.documentElement.outerHTML); }

/* ── 8. Activity: list + detail when unfolded ── */
app.navigate('txns'); await tick(40);
check('folded: no detail pane', !$('#txn-detail'));
await click($$('#txn-results .txn')[0]);
check('folded: a tap opens the sheet', document.querySelector('#sheet').classList.contains('open') && !!$('#sheetBody .td-edit'));
closeSheet(); await tick(30);
setViewport(860, 955); await tick(40);
check('unfolded: detail pane appears beside the list', !!$('#txn-detail') && !!$('.split .split-main #txn-results'));
check('unfolded: pane starts with a placeholder', $('#txn-detail').textContent.includes('Select a transaction'));
const rows = $$('#txn-results .txn');
await click(rows[1]);
check('unfolded: a tap fills the pane, not a sheet', $('#txn-detail').textContent.includes('Transaction') && !document.querySelector('#sheet').classList.contains('open'));
check('unfolded: the tapped row is highlighted', rows[1].classList.contains('selected'));
const selId = rows[1].dataset.id;
const n0 = state.transactions.length;
await click($('#txn-detail .td-del'), 150);
check('unfolded: delete from the pane removes it', state.transactions.length === n0 - 1 && !state.transactions.some(t => t.id === selId));
check('unfolded: pane resets after delete', $('#txn-detail').textContent.includes('Select a transaction'));
await click($('#toast-act'), 200);
check('undo brings it back', state.transactions.some(t => t.id === selId));
await click($$('#txn-results .txn')[0]);
await click($('#txn-detail .td-edit'), 60);
check('unfolded: edit opens the Add form for it', state.view === 'add');
setViewport(411, 960); await tick(40);
app.navigate('txns'); await tick(40);

/* ── 9. navigation rail (CSS) ── */
{
  const css = dom.window.document.querySelector('style').textContent;
  const wideBlock = css.slice(css.indexOf('@media (min-width: 700px)'));
  check('unfolded nav becomes a vertical rail', /nav\.tabs\s*\{[^}]*flex-direction:\s*column/.test(wideBlock) && /--rail:\s*92px/.test(wideBlock) && /padding-left:\s*var\(--rail\)/.test(wideBlock));
}

/* ── 10. Add form context column ── */
{
  const { resetAddForm } = await import('../js/add.js');
  resetAddForm({ type:'Expense', category:'Groceries', account:'Card', accountTouched:true });
  app.navigate('add'); await tick(40);
  check('folded: no context column', !$('#add-side'));
  setViewport(860, 955); await tick(40);
  check('unfolded: context column beside the form', !!$('#add-side') && !!$('.split-main #f-amount'));
  const side = () => $('#add-side').textContent;
  check('shows the account balance', side().includes('Card') && side().includes('owed'), side());
  const amt = $('#f-amount'); amt.value = '11.00'; amt.dispatchEvent(new dom.window.Event('input')); await tick(20);
  check('shows the balance after this transaction', side().includes('→'), side());
  check('flags a possible duplicate (same amount + account today)', !!$('#add-side .add-dup'), side());
  const d = $('#f-desc'); d.value = 'shop 1'; d.dispatchEvent(new dom.window.Event('input')); await tick(20);
  check('lists recent entries at that merchant', side().includes('Recent at') && side().includes('$11.00'), side());
  setViewport(411, 960); await tick(40);
  check('folding removes the column, keeps what you typed', !$('#add-side') && $('#f-amount').value === '11.00' && $('#f-desc').value === 'shop 1');
}

/* ── 11. Bills calendar ── */
{
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const prevD = new Date(now.getFullYear(), now.getMonth() - 1, 10);
  const prevIso = `${prevD.getFullYear()}-${String(prevD.getMonth()+1).padStart(2,'0')}-10`;
  await dbPut('bills', { id:'rent', name:'Rent', recurrence:'monthly', type:'Expense', account:'Checking', amount:1200, dueDay:1, category:'Rent', active:true, paidMonths:{ [ym]:'x' } });
  await dbPut('bills', { id:'net', name:'Internet', recurrence:'monthly', type:'Expense', account:'Checking', amount:70, dueDay:31, category:'Utilities', active:true, paidMonths:{} });
  await dbPut('bills', { id:'fix', name:'Car repair', recurrence:'once', type:'Expense', account:'Checking', amount:450, dueDate:prevIso, dueDay:10, category:'Misc', active:true, paidMonths:{} });
  await loadState();
  state.selected = { year: now.getFullYear(), month: now.getMonth() + 1 };
  app.navigate('bills'); await tick(40);
  check('folded: no calendar', !$('.cal'));
  setViewport(860, 955); await tick(40);
  check('unfolded: calendar beside the bill list', !!$('.split-side .cal') && !!$('.split-main #add-bill'));
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const cellFor = (d) => $$('.cal-cell:not(.blank)')[d - 1];
  check('rent on day 1, shown paid', cellFor(1)?.querySelector('.cal-bill.paid')?.textContent.includes('Rent'));
  check('a day-31 bill lands on the last day in short months', cellFor(days)?.textContent.includes('Internet'), String(days));
  check('carried one-time bill listed under the grid', $('.split-side').textContent.includes('Carried over') && $('.split-side').textContent.includes('Car repair'));
  check('today is highlighted', !!$('.cal-cell.today'));
  await click($('.cal-bill[data-bill-id="net"]'));
  check('tapping a calendar bill opens its editor', ($('#sheetBody h2')?.textContent || '').includes('Edit Bill'));
  closeSheet(); await tick(30);
  setViewport(411, 960); await tick(40);
}

/* ── 12. Reconcile: statement vs ledger side by side ── */
{
  const d0 = new Date(); const iso = (n) => { const d = new Date(d0); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  await dbPut('transactions', { id:'rc-led-only', date:iso(1), type:'Expense', account:'Card', category:'Groceries', amount:33.33, description:'only mine' });
  await loadState();
  const mine = state.transactions.filter(t => t.account === 'Card' && t.id !== 'rc-led-only');
  const csv = ['Date,Description,Amount', ...mine.map(t => `${t.date},${t.description},${t.amount.toFixed(2)}`), `${iso(2)},STATEMENT ONLY,44.44`].join('\n');
  const origCreate = dom.window.document.createElement.bind(dom.window.document);
  dom.window.document.createElement = function(tag){
    const el = origCreate(tag);
    if (String(tag).toLowerCase() === 'input') el.click = function(){ Object.defineProperty(this, 'files', { value:[{ name:'s.csv', text: async () => csv }] }); setTimeout(() => this.onchange && this.onchange(), 0); };
    return el;
  };
  setViewport(860, 955); await tick(20);
  const rec = await import('../js/reconcile.js');
  rec.openReconcileSheet(); await tick(30);
  await click($('#rc-acct'));
  await click($$('.picker-option').find(o => o.dataset.v === 'Card'));
  await click($('#rc-file'), 400);
  const cols = $$('.rc-pair > .rc-col');
  check('statement-only and ledger-only render as a pair of columns', cols.length === 2, String(cols.length));
  check('left: on statement, not in ledger', cols[0]?.textContent.includes('STATEMENT ONLY'));
  check('right: in ledger, not on statement', cols[1]?.textContent.includes('only mine'));
  await click($('#rc-show-matched'), 40);
  const mrow = $('.rc-match-row');
  check('matched rows show statement ↔ ledger sides', !!mrow && mrow.querySelectorAll('.rc-side').length === 2 && !!$('.rc-match-head'));
  dom.window.document.createElement = origCreate;
  closeSheet(); await tick(30);
  setViewport(411, 960); await tick(20);
}

/* ── 13. side panels / dialogs ── */
{
  const sheet = $('#sheet');
  setViewport(860, 955); await tick(20);
  manage.openCategoriesSheet(); await tick(30);
  check('a normal sheet opens as the side panel (not the wide dialog)', sheet.classList.contains('open') && !sheet.classList.contains('sheet-wide'));
  check('a close button exists for panels', !!$('#sheetClose'));
  await click($('#sheetClose'), 60);
  check('× closes it', !sheet.classList.contains('open'));
  const rec = await import('../js/reconcile.js');
  rec.openReconcileSheet(); await tick(30);
  check('Reconcile opens as the wide dialog', sheet.classList.contains('sheet-wide'));
  await click($('#rc-acct'));
  check('a picker inside the dialog keeps dialog mode', sheet.classList.contains('sheet-wide') && !!$('.picker-option'));
  await click($('#picker-cancel'), 60);
  manage.openAboutSheet(); await tick(30);
  check('the next sheet opened fresh is a panel again', !sheet.classList.contains('sheet-wide'));
  closeSheet(); await tick(30);
  const css = dom.window.document.querySelector('style').textContent;
  check('panel CSS: right-side, ~cover width', /\.sheet\s*\{[^}]*right:\s*0;[^}]*width:\s*min\(460px/.test(css.slice(css.indexOf('@media (min-width: 700px)'))));
  setViewport(411, 960); await tick(20);
}

/* ── 14. number pad ── */
{
  const add = await import('../js/add.js');
  const { evalAmountExpr } = await import('../js/util.js');
  const k = (s, keys) => keys.split(' ').reduce((a, key) => add.applyPadKey(a, key), s);
  check('digits + decimal', k('', '1 2 . 5 0') === '12.50');
  check('no third decimal', k('', '1 . 2 3 4') === '1.23');
  check('no leading zeros', k('', '0 0 7') === '7');
  check('"." on empty → 0.', k('', '. 5') === '0.5');
  check('one decimal point per number', k('', '1 . . 2') === '1.2');
  check('operators: swap, never lead', k('', '+ 5 + − 2') === '5−2');
  check('⌫ deletes one', k('12.5', '⌫') === '12.');
  check('sum evaluates in cents', evalAmountExpr('12.50+3.20−1') === 14.7 && evalAmountExpr('0.1+0.2') === 0.3);
  check('malformed sums are rejected', isNaN(evalAmountExpr('5+−')) && isNaN(evalAmountExpr('abc')));
  check('plain numbers unchanged', evalAmountExpr('1,234.56') === 1234.56);

  add.resetAddForm({ type:'Expense', category:'Groceries', account:'Card', accountTouched:true });
  app.navigate('add'); await tick(40);
  const amt = $('#f-amount');
  check('pad shown by default; system keyboard suppressed', !!$('.amt-pad') && amt.hasAttribute('readonly') && amt.getAttribute('inputmode') === 'none');
  for (const key of ['2','5','+','4','.','5']) await click($(`.pad-key[data-k="${key}"]`), 5);
  check('typing on the pad fills the amount', amt.value === '25+4.5' && add.addForm.amount === '25+4.5', amt.value);
  check('live sum preview', $('#f-amt-calc').textContent === '= $29.50', $('#f-amt-calc').textContent);
  await click($('.date-chips .chip[data-day="-1"]'), 20);
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yIso = `${y.getFullYear()}-${String(y.getMonth()+1).padStart(2,'0')}-${String(y.getDate()).padStart(2,'0')}`;
  check('Yesterday chip sets the date', add.addForm.date === yIso && $('#f-date').value === yIso);
  const n0 = state.transactions.length;
  await click($('.pad-key[data-k="✓"]'), 200);
  const saved = state.transactions.find(t => t.date === yIso && t.amount === 29.5);
  check('✓ on the pad saves the summed amount', state.transactions.length === n0 + 1 && !!saved, JSON.stringify(saved));
  app.navigate('add'); await tick(30);
  await click($('.pad-key[data-k="⌨"]'), 60);
  check('⌨ switches to the system keyboard and remembers it', state.flags.amountInput === 'keyboard' && !$('.amt-pad') && $('#f-amount').getAttribute('inputmode') === 'decimal');
  await click($('#f-use-pad'), 60);
  check('…and back to the pad', state.flags.amountInput === 'pad' && !!$('.amt-pad'));
}

/* ── 15. customizable Home ── */
{
  state.flags.homeLayout = undefined;
  app.navigate('home'); await tick(40);
  const order = () => $$('#view-home .home-card').map(s => s.dataset.card);
  check('default order', order().join(',').startsWith('quicklog,pace,real'), order().join(','));
  const fold = $('.home-card[data-card="accounts"] .card-fold');
  check('collapsible cards get a ⌄ button', !!fold && !$('.home-card[data-card="quicklog"] .card-fold'));
  await click(fold, 60);
  check('⌄ collapses the card in place', $('.home-card[data-card="accounts"]').classList.contains('collapsed'));
  check('collapse is remembered', state.flags.homeLayout.collapsed.includes('accounts'));
  app.navigate('more'); app.navigate('home'); await tick(30);
  check('…across re-renders', $('.home-card[data-card="accounts"]').classList.contains('collapsed'));
  await click($('#home-customize'), 40);
  check('Customize Home sheet lists every card', $$('.hc-row').length === 10);
  await click($('.hc-up[data-k="accounts"]'), 60);
  const o = order();
  check('↑ moves a card up', o.indexOf('accounts') < o.indexOf('debt'), o.join(','));
  await click($('.hc-vis[data-k="insights"]'), 60);
  check('hiding a card removes it from Home', !order().includes('insights') && state.flags.homeLayout.hidden.includes('insights'));
  await click($('#hc-reset'), 60);
  check('reset restores everything', order().includes('insights') && !$('.home-card.collapsed') && order().join(',').startsWith('quicklog,pace,real'));
  closeSheet(); await tick(30);
}

/* ── 16. month swipe on Home, Bills and Activity ── */
{
  const swipe = async (el, x0, x1, target = el) => {
    const mk = (type, x, key) => { const ev = new dom.window.Event(type, { bubbles: true }); Object.defineProperty(ev, key, { value: [{ clientX: x, clientY: 400 }] }); return ev; };
    target.dispatchEvent(mk('touchstart', x0, 'touches'));
    target.dispatchEvent(mk('touchend', x1, 'changedTouches'));
    await tick(60);
  };
  const sel = () => `${state.selected.year}-${state.selected.month}`;
  const { txnFilters } = await import('../js/txns.js');
  for (const view of ['home', 'bills', 'txns']){
    app.navigate(view); await tick(30);
    const before = sel();
    await swipe($(`#view-${view}`), 300, 120);           // swipe left → next month
    const after = sel();
    check(`${view}: swipe left steps to the next month`, before !== after, `${before} → ${after}`);
    await swipe($(`#view-${view}`), 120, 300);           // swipe right → back
    check(`${view}: swipe right steps back`, sel() === before);
  }
  app.navigate('txns'); await tick(30);
  const before = sel();
  await swipe($('#view-txns'), 300, 120, $('.txn-filters'));
  check('a swipe that starts on the scrolling filter chips is ignored', sel() === before);
  txnFilters.month = 'all';
  await swipe($('#view-txns'), 300, 120);
  check('Activity on "All months" ignores month swipes', sel() === before);
  txnFilters.month = 'current';
  await swipe($('#view-txns'), 10, 300);
  check('edge swipes (Android back gesture) are ignored', sel() === before);
}

/* ── 17. half-folded postures ── */
{
  setViewport(860, 955); await tick(20);
  app.navigate('home'); await tick(30);
  check('flat by default', layout.posture() === 'flat' && !document.body.classList.contains('posture-tabletop'));
  setPosture('tabletop'); await tick(30);
  check('tabletop detected → body class', layout.posture() === 'tabletop' && document.body.classList.contains('posture-tabletop'));
  check('Home marks the hero for the top half', !!$('#view-home .hero.tt-top'));
  app.navigate('add'); await tick(30);
  check('Add marks the amount for the top half', !!$('#view-add .field.tt-top #f-amount'));
  setPosture('book'); await tick(30);
  check('book posture detected', layout.posture() === 'book' && document.body.classList.contains('posture-book') && !document.body.classList.contains('posture-tabletop'));
  setPosture('flat'); await tick(30);
  check('back to flat clears posture classes', !document.body.classList.contains('posture-book'));
  const css = dom.window.document.querySelector('style').textContent;
  check('posture CSS uses viewport segments', /vertical-viewport-segments:\s*2/.test(css) && /env\(viewport-segment-height 0 0/.test(css) && /horizontal-viewport-segments:\s*2/.test(css));
  setViewport(411, 960); await tick(20);
}

/* ── 18. fold ↔ unfold continuity ── */
{
  // Focus + caret survive the re-render.
  const add = await import('../js/add.js');
  add.resetAddForm({ type:'Expense' }); app.navigate('add'); await tick(30);
  const d = $('#f-desc'); d.value = 'coffee beans'; d.dispatchEvent(new dom.window.Event('input'));
  d.focus(); d.setSelectionRange(3, 3);
  setViewport(860, 955); await tick(40);
  const d2 = $('#f-desc');
  check('the focused field is still focused after unfolding', document.activeElement === d2 && d2 !== d, document.activeElement?.id);
  check('…with the text and cursor kept', d2.value === 'coffee beans' && d2.selectionStart === 3);
  setViewport(411, 960); await tick(40);
  check('…and after folding again', document.activeElement?.id === 'f-desc');

  // Scroll anchor: the row at the top of the screen is put back at the same height.
  app.navigate('txns'); await tick(30);
  const rows = $$('#txn-results .txn');
  const target = rows[3];
  const proto = dom.window.HTMLElement.prototype;
  const origRect = proto.getBoundingClientRect;
  let scrolled = null, targetCalls = 0;
  proto.getBoundingClientRect = function(){
    const id = this.dataset?.id;
    // Before the re-render the row sits at 120px; after it, the layout
    // change has moved it to 300px.
    if (id === target.dataset.id){ const top = targetCalls++ === 0 ? 120 : 300; return { top, bottom: top + 50, height: 50 }; }
    if (id && rows.slice(0, 3).some(r => r.dataset.id === id)) return { top: -200, bottom: -150, height: 50 };
    return { top: 0, bottom: 0, height: 0 };
  };
  const origBy = dom.window.scrollBy;
  dom.window.scrollBy = window.scrollBy = (x, y) => { scrolled = y; };
  setViewport(860, 955); await tick(40);
  check('unfolding scrolls so the same transaction stays at the same height', scrolled === 180, String(scrolled));
  proto.getBoundingClientRect = origRect;
  dom.window.scrollBy = window.scrollBy = origBy;

  // Activity: the open transaction moves between pane and sheet.
  await click($$('#txn-results .txn')[1]);
  const selId = $('#txn-detail .td-card').dataset.txnId;
  setViewport(411, 960); await tick(60);
  check('folding with a transaction in the pane opens it as the sheet', $('#sheet').classList.contains('open') && $('#sheetBody .td-card')?.dataset.txnId === selId);
  setViewport(860, 955); await tick(60);
  check('unfolding with its sheet open moves it back to the pane', !$('#sheet').classList.contains('open') && $('#txn-detail .td-card')?.dataset.txnId === selId);
  setViewport(411, 960); await tick(60);
  closeSheet(); await tick(30);
}

check('zero captured errors', errors.length === 0, errors[0]);
done('fold layout tests');
