/* v3.1 Section D (items 26–36): everyday features. All sample data —
   generic names and round amounts, dates relative to today. */
import { bootEnv, makeChecker, tick, domHelpers } from './_env.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const { $, $$, click, type } = domHelpers(dom);
const errors = [];
process.on('unhandledRejection', e => errors.push(String(e?.stack || e)));

const { state, dbPut, dbDel, loadState, saveFlags, dataVersion } = await import('../js/db.js');
const util = await import('../js/util.js');
const app = await import('../js/app.js'); await tick(150);
const { closeSheet } = await import('../js/sheet.js');

const D = (n) => util.toLocalISO(util.addDays(new Date(), n));     // today ± n days, local
const T = util.today();
let seq = 0;
const txn = (o) => ({ id: 'e' + (++seq) + Math.random().toString(36).slice(2, 6), description: '', ...o });

await dbPut('accounts', { id:'a1', name:'Checking', type:'Checking', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'Savings', type:'Savings', active:true, order:1 });
await dbPut('accounts', { id:'a3', name:'Card', type:'Credit Card', active:true, order:2 });
await dbPut('accounts', { id:'a4', name:'Card B', type:'Credit Card', active:true, order:3 });
for (const [k, list] of Object.entries({ Expense:['Groceries','Restaurants','Rent','Utilities','Streaming','Gas'], Income:['Salary','Gig','Gifts'], Refund:['Return'], Investment:['Brokerage'], CCPayment:['CC Payment'], LoanPayment:['Loan Payment'], Transfer:['Transfer'], BalanceTransfer:['Balance Transfer'] })){
  await dbPut('categories', { id:k, list });
}
await dbPut('balanceAnchors', { id:'an1', account:'Checking', month: util.currentYm(), amount: 2000 });
await dbPut('balanceAnchors', { id:'an2', account:'Card', month: util.currentYm(), amount: 300 });

/* ── 26. Safe to spend per day until payday ── */
// Paychecks every 14 days, last one 4 days ago, split into two same-day
// deposits plus a small one the next day (one payday, not three).
for (let k = 0; k < 7; k++){
  const d = -4 - 14 * k;
  await dbPut('transactions', txn({ date: D(d), type:'Income', account:'Checking', category:'Salary', amount: 900 }));
  await dbPut('transactions', txn({ date: D(d), type:'Income', account:'Savings', category:'Salary', amount: 100 }));
  await dbPut('transactions', txn({ date: D(d + 1), type:'Income', account:'Checking', category:'Salary', amount: 20 }));
}
// Bigger but irregular side income — mustn't be taken for the paycheck.
for (const d of [-2, -9, -11, -30, -31, -58, -90]) await dbPut('transactions', txn({ date: D(d), type:'Income', account:'Checking', category:'Gig', amount: 700 }));
const dueIn = (n) => util.addDays(new Date(), n).getDate();
await dbPut('bills', { id:'b-soon', name:'Power', recurrence:'monthly', type:'Expense', account:'Checking', category:'Utilities', amount: 120, dueDay: dueIn(3), active:true, paidMonths:{} });
await dbPut('bills', { id:'b-late', name:'Rent', recurrence:'monthly', type:'Expense', account:'Checking', category:'Rent', amount: 1000, dueDay: dueIn(16), active:true, paidMonths:{} });
await dbPut('bills', { id:'b-cc', name:'Card bill', recurrence:'auto-cc', linkedAccount:'Card', closeDay: dueIn(5), graceDays: 0, active:true, paidMonths:{} });
await loadState();
state.flags.anchorsV3 = true;
await tick(700);

const pd = await import('../js/payday.js');
{
  const sched = pd.detectPaySchedule(T);
  check('paycheck found among incomes (Salary, not the bigger irregular Gig)', sched?.category === 'Salary', JSON.stringify(sched));
  check('split / next-day deposits count as one payday → every 14 days', sched?.step === 14 && sched.last === D(-4));
  const nxt = pd.nextPayday(T);
  check('next payday = last + 14 days', nxt && util.toLocalISO(nxt.date) === D(10) && !nxt.expectedToday);
  check('a payday due today but not logged yet is flagged', pd.nextPayday(D(10)).expectedToday === true && util.toLocalISO(pd.nextPayday(D(10)).date) === D(24));

  const s = pd.safeToSpend(T);
  const { balanceLatest } = await import('../js/effects.js');
  check('safe to spend starts from checking only (not savings)', s.cash === balanceLatest('Checking'));
  const labels = s.due.map(e => e.label);
  check('bills due before payday are subtracted', labels.includes('Power'));
  check('bills due after payday are not', !labels.includes('Rent'));
  check('arithmetic: checking − due − cards = total; ÷ days', s.total === util.round2(s.cash - s.dueBefore - s.cardDeduct) && s.days === 10 && s.perDay === util.round2(s.total / 10));

  // A card selected in Real available is subtracted once — its auto-pay bill isn't added on top.
  const withBill = s.due.some(e => e.acct === 'Card');
  state.flags.realAvailCards = ['Card'];
  const s2 = pd.safeToSpend(T);
  check('a card subtracted in Real available isn\'t double-counted through its bill',
    withBill && !s2.due.some(e => e.acct === 'Card') && s2.cardDeduct === 300);
  state.flags.realAvailCards = [];

  // Paying the soon bill takes it out.
  const ym = D(3).slice(0, 7);
  state.bills.find(b => b.id === 'b-soon').paidMonths = { [ym]: 'x' };
  check('a paid bill no longer counts', !pd.safeToSpend(T).due.some(e => e.label === 'Power'));
  state.bills.find(b => b.id === 'b-soon').paidMonths = {};

  // Home card.
  app.navigate('home'); await tick(40);
  const card = $('#view-home .home-card[data-card="safe"]');
  check('Home shows the Safe to spend card', !!card && /\/day/.test(card.textContent) && /10 days until payday/.test(card.textContent) && /estimated/.test(card.textContent));
  check('…with the breakdown', /Due before payday/.test(card.textContent) && /Until payday/.test(card.textContent));

  // Manual payday.
  await click($('#safe-config'), 40);
  check('⚙ opens Payday, showing what was detected', /From your Salary deposits/.test($('#sheetBody').textContent) && /every ~14 days/.test($('#sheetBody').textContent));
  await click($('#pd-mode .seg-btn[data-v="manual"]'), 20);
  type('#pd-date', D(5));
  await click($('#pd-every .seg-btn[data-v="month"]'), 20);
  check('changing the cadence keeps the date you typed', $('#pd-date').value === D(5));
  await click($('#pd-save'), 60);
  check('saved as a manual payday', state.flags.payday?.mode === 'manual' && state.flags.payday.every === 'month' && state.flags.payday.anchor === D(5));
  check('card follows it', new RegExp(`5 days until payday`).test($('#view-home .home-card[data-card="safe"]').textContent) && !/estimated/.test($('#view-home .home-card[data-card="safe"]').textContent));

  // Monthly keeps the day: the 31st → Feb 28 → Mar 31.
  state.flags.payday = { mode:'manual', anchor:'2027-01-31', every:'month' };
  check('monthly paydays keep their day (no drift)', util.toLocalISO(pd.nextPayday('2027-02-01').date) === '2027-02-28' && util.toLocalISO(pd.nextPayday('2027-03-01').date) === '2027-03-31');
  state.flags.payday = { mode:'manual', anchor: D(-1), every:'week' };
  check('weekly from a past payday rolls forward', util.toLocalISO(pd.nextPayday(T).date) === D(6));
  state.flags.payday = { mode:'auto' };
  await saveFlags();

  // No regular income → asks to set payday.
  const saved = state.transactions;
  state.transactions = saved.filter(t => t.category !== 'Salary');
  check('only irregular income → nothing detected', pd.detectPaySchedule(T) === null);
  dataVersion.n++;                       // derived balances re-index
  app.navigate('home'); app.renderAll(); await tick(40);
  check('…the card offers "Set payday"', /Set payday/.test($('#view-home .home-card[data-card="safe"]')?.textContent || ''));
  state.transactions = saved;
  dataVersion.n++;

  // Only for the current month.
  await app.stepMonth(-1); await tick(40);
  check('not shown while browsing another month', !$('#view-home .home-card[data-card="safe"]'));
  await app.stepMonth(1); await tick(40);
  const { openHomeCustomizeSheet } = await import('../js/home.js');
  openHomeCustomizeSheet(); await tick(20);
  check('listed in Customize Home', $$('.hc-row').some(r => /Safe to spend/.test(r.textContent)));
  closeSheet(); await tick(20);
}

/* ── 27. Log again ── */
const add = await import('../js/add.js');
const { openTxnSheet } = await import('../js/txns.js');
{
  const src = txn({ date: D(-6), type:'Expense', account:'Card', category:'Restaurants', amount: 23.5, description:'Taco place' });
  await dbPut('transactions', src); await loadState(); await tick(30);
  const before = state.transactions.length;
  openTxnSheet(src.id); await tick(30);
  check('the transaction sheet offers "Log again"', !!$('#sheetBody .td-again'));
  await click($('#sheetBody .td-again'), 60);
  check('Log again opens Add with everything but the date', state.view === 'add' && add.addForm.type === 'Expense' && add.addForm.account === 'Card'
    && add.addForm.category === 'Restaurants' && add.addForm.description === 'Taco place' && add.addForm.amount === '23.5');
  check('…dated today, as a new entry (not an edit)', add.addForm.date === T && !add.addForm.editingId && !$('#sheet').classList.contains('open'));
  await click($('#f-save'), 120);
  const copy = state.transactions.find(t => t.id !== src.id && t.description === 'Taco place');
  check('saving makes a second transaction', state.transactions.length === before + 1 && copy && copy.date === T && copy.amount === 23.5 && copy.account === 'Card');
  check('…and the original is untouched', state.transactions.find(t => t.id === src.id).date === D(-6));

  await dbPut('accounts', { id:'a9', name:'Old Card', type:'Credit Card', active:false, order:9 });
  await loadState();
  add.logAgain({ type:'Expense', account:'Old Card', category:'Groceries', amount: 4, description:'' }); await tick(30);
  check('a closed account isn\'t carried over', add.addForm.account !== 'Old Card' && !add.addForm.accountTouched);
  add.resetAddForm(); app.navigate('home'); await tick(30);
}

/* ── 28. Recently added on Home ── */
{
  const legacy = { id:'legacy1', date: D(-100), type:'Expense', account:'Checking', category:'Gas', amount: 30, description:'', updatedAt: 1000 };
  await dbPut('transactions', legacy);
  check('a pre-3.1 record keeps its last-write time as when it was added', legacy.createdAt === 1000 && legacy.updatedAt > 1000);
  const fresh = txn({ date: T, type:'Expense', account:'Checking', category:'Gas', amount: 31 });
  await dbPut('transactions', fresh);
  check('new records are stamped when first written', fresh.createdAt > 1000 && fresh.createdAt <= Date.now());
  const createdBefore = fresh.createdAt;
  fresh.amount = 32; await dbPut('transactions', fresh);
  check('…and keep that stamp through edits', fresh.createdAt === createdBefore);
  await loadState();

  // A backdated receipt, entered now.
  add.resetAddForm({ type:'Expense', date: D(-40), account:'Checking', category:'Groceries', amount:'7', description:'Backdated receipt' });
  app.navigate('add'); await tick(40);
  await click($('#f-save'), 120);
  app.navigate('home'); await tick(40);
  const recent = () => $$('#view-home .home-card[data-card="recent"] .txn').map(el => state.transactions.find(t => t.id === el.dataset.id));
  check('Recent defaults to "Just added": the backdated receipt is first', recent()[0]?.description === 'Backdated receipt', recent().map(t => t?.description).join('|'));
  check('…then the earlier entries, newest first', recent()[1]?.id === fresh.id);
  await click($('#view-home [data-rm="date"]'), 60);
  check('"By date" switches to the latest dates (saved)', state.flags.recentMode === 'date' && !recent().some(t => t.description === 'Backdated receipt') && recent()[0].date === T);
  check('…and the chip shows it', $('#view-home [data-rm="date"]').getAttribute('aria-pressed') === 'true');
  await click($('#view-home [data-rm="added"]'), 60);
  check('back to "Just added"', state.flags.recentMode === 'added' && recent()[0]?.description === 'Backdated receipt');
}

/* ── 29. Split transactions ── */
const { balanceLatest, monthTotals } = await import('../js/effects.js');
const { splitParts } = await import('../js/db.js');
const { pick } = domHelpers(dom);
{
  const cardBefore = balanceLatest('Card B');
  const expBefore = monthTotals(new Date().getFullYear(), new Date().getMonth() + 1).exp;
  add.resetAddForm({ type:'Expense', account:'Card B', category:'Groceries', amount:'80', description:'Big store run' });
  app.navigate('add'); await tick(40);
  check('Expense offers "Split across categories"', !!$('#f-split'));
  await click($('#f-split'), 40);
  check('split mode: two parts, category field becomes "Split"', $$('.sp-row').length === 2 && /Split · 2 parts/.test($('.split-sum').textContent) && !$('#f-cat'));
  type('.sp-amt[data-i="0"]', '50');
  check('the blank part shows it takes the rest', /\$30\.00 → the blank part/.test($('#sp-left').textContent));
  await click($$('.sp-cat')[1], 30); await pick('Restaurants'); await tick(30);
  check('each part picks its own category', add.addForm.splits[1].category === 'Restaurants' && $$('.sp-row').length === 2);
  type('.sp-amt[data-i="1"]', '40');
  check('over the total is flagged live', /Over by \$10\.00/.test($('#sp-left').textContent));
  const n0 = state.transactions.length;
  await click($('#f-save'), 100);
  check('…and refused on save', state.transactions.length === n0 && /over the total/.test($('#toast').textContent));
  type('.sp-amt[data-i="1"]', '');
  await click($('#f-save'), 150);
  const parts = state.transactions.filter(t => t.description === 'Big store run');
  const sid = parts[0]?.splitId;
  check('saved as one transaction per part, sharing a split id', parts.length === 2 && sid && parts.every(p => p.splitId === sid && p.splitTotal === 80));
  check('parts: Groceries $50 + Restaurants $30 (the rest)', JSON.stringify(splitParts(sid).map(p => [p.category, p.amount])) === JSON.stringify([['Groceries', 50], ['Restaurants', 30]]));
  check('same date / account / note on every part', parts.every(p => p.date === T && p.account === 'Card B' && p.description === 'Big store run'));
  check('the card moves by the full $80', util.round2(balanceLatest('Card B') - cardBefore) === 80);
  check('monthly expenses count it once ($80)', util.round2(monthTotals(new Date().getFullYear(), new Date().getMonth() + 1).exp - expBefore) === 80);

  // Activity + detail.
  app.navigate('txns'); await tick(60);
  const row = $$('#view-txns .txn').find(el => el.dataset.id === splitParts(sid)[1].id);
  check('Activity marks split parts', !!row && /split/.test(row.textContent));
  openTxnSheet(splitParts(sid)[1].id); await tick(30);
  check('a part\'s detail lists the whole split', /Split · \$80\.00 in 2 parts/.test($('#sheetBody').textContent) && /Groceries/.test($('.td-split').textContent) && $('.td-edit').textContent === 'Edit split');

  // Edit: the whole split loads; change a part, add a third.
  await click($('.td-edit'), 60);
  check('Edit loads the total and every part', add.addForm.amount === '80' && add.addForm.splits.length === 2 && add.addForm.splitId === sid && add.addForm.editingId === splitParts(sid)[0].id);
  type('.sp-amt[data-i="0"]', '40');
  await click($('#sp-add'), 40);
  type('.sp-amt[data-i="1"]', '30');
  check('a new part slots in with an unused category', $$('.sp-row').length === 3 && add.addForm.splits[2].category !== 'Groceries' && add.addForm.splits[2].category !== 'Restaurants');
  const keepIds = splitParts(sid).map(p => p.id);
  await click($('#f-save'), 150);
  const p3 = splitParts(sid);
  check('edit: 3 parts $40 / $30 / $10, existing ids kept', p3.length === 3 && p3.map(p => p.amount).join() === '40,30,10' && p3[0].id === keepIds[0] && p3[1].id === keepIds[1]);
  check('…still $80 on the card', util.round2(balanceLatest('Card B') - cardBefore) === 80);

  // Remove a part while editing.
  add.startEdit(p3[2]); await tick(40);
  await click($$('.sp-del')[2], 40);
  type('.sp-amt[data-i="1"]', '');
  await click($('#f-save'), 150);
  check('removing a part deletes it', splitParts(sid).length === 2 && splitParts(sid)[1].amount === 40 && !state.transactions.some(t => t.id === p3[2].id));

  // Reconcile: the statement shows ONE $80 line.
  const { openReconcileWithFile } = await import('../js/reconcile.js');
  openReconcileWithFile('stmt.csv', `Date,Description,Amount\n${T},BIG STORE,80.00\n`); await tick(40);
  await click($('#rc-acct'), 30); await pick('Card B'); await tick(30);
  await click($('#rc-rerun'), 200);
  check('Reconcile matches a split to its single statement line', /Fully reconciled/.test($('#sheetBody').textContent), $('#sheetBody').textContent.replace(/\s+/g, ' ').slice(0, 300));
  closeSheet(); await tick(20);
  const learned = Object.values(state.flags.stmtMerchants || {}).map(e => e.c);
  check('…without learning "A + B" as a category', !learned.some(c => / \+ /.test(c || '')));

  // Log again repeats the split.
  openTxnSheet(splitParts(sid)[0].id); await tick(30);
  await click($('#sheetBody .td-again'), 60);
  check('Log again on a split starts a new split', add.addForm.splits?.length === 2 && !add.addForm.splitId && !add.addForm.editingId && add.addForm.amount === '80');
  add.resetAddForm(); app.navigate('home'); await tick(30);

  // Delete removes every part; Undo brings them all back.
  openTxnSheet(splitParts(sid)[1].id); await tick(30);
  await click($('#sheetBody .td-del'), 150);
  check('deleting a part deletes the whole split', splitParts(sid).length === 0 && /Deleted split \(2 parts\)/.test($('#toast').textContent));
  await click($('#toast-act'), 150);
  check('Undo restores every part', splitParts(sid).length === 2 && util.round2(balanceLatest('Card B') - cardBefore) === 80);

  // "Don't split" while editing → one transaction for the total.
  add.startEdit(splitParts(sid)[0]); await tick(40);
  await click($('#sp-off'), 40);
  await click($('#f-save'), 150);
  const merged = state.transactions.filter(t => t.description === 'Big store run');
  check('"Don\'t split" turns it back into one $80 transaction', merged.length === 1 && merged[0].amount === 80 && !merged[0].splitId && merged[0].category === 'Groceries');

  // Only Expense splits.
  add.resetAddForm({ type:'Income', account:'Checking', category:'Salary', amount:'5' }); app.navigate('add'); await tick(30);
  check('Income has no split option', !$('#f-split'));
  add.resetAddForm(); app.navigate('home'); await tick(20);
}

/* ── 30. Tags ── */
const tagsMod = await import('../js/tags.js');
const { txnFilters } = await import('../js/txns.js');
{
  check('tag cleanup: case, #, punctuation, spaces → hyphen', tagsMod.normalizeTag('  #Beach Trip!! ') === 'beach-trip');
  check('parseTags splits on commas/spaces, dedupes', JSON.stringify(tagsMod.parseTags('#trip, Work  trip')) === '["trip","work"]');

  const key = (k) => new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  add.resetAddForm({ type:'Expense', account:'Card', category:'Restaurants', amount:'60', description:'Beach dinner', date: D(-20) });
  app.navigate('add'); await tick(40);
  check('the Add form has a Tags field', !!$('#f-tag-input'));
  $('#f-tag-input').value = '#Trip'; $('#f-tag-input').dispatchEvent(key('Enter')); await tick(20);
  check('Enter adds a tag chip', JSON.stringify(add.addForm.tags) === '["trip"]' && !!$('#f-tags [data-del-tag="trip"]'));
  type('#f-tag-input', 'drinks');                 // a word ending in "s" isn't a delimiter
  await tick(20);
  check('typing a word doesn\'t commit it early', JSON.stringify(add.addForm.tags) === '["trip"]' && $('#f-tag-input').value === 'drinks');
  type('#f-tag-input', 'family,');                // Android keyboards: the comma arrives as input
  await tick(20);
  check('a comma adds one too', JSON.stringify(add.addForm.tags) === '["trip","family"]');
  await click($('#f-tags [data-del-tag="family"]'), 20);
  check('× removes it', JSON.stringify(add.addForm.tags) === '["trip"]');
  $('#f-tag-input').value = 'beach';             // typed, not committed…
  await click($('#f-save'), 120);
  const dinner = state.transactions.find(t => t.description === 'Beach dinner');
  check('…still saved with Save', JSON.stringify(dinner?.tags) === '["trip","beach"]');

  // Suggestions + more tagged spending (a refund nets out).
  add.resetAddForm({ type:'Expense', account:'Card', category:'Gas', amount:'40', description:'Fuel', date: D(-21) });
  app.navigate('add'); await tick(40);
  const sugg = $('#view-add [data-add-tag="trip"]');
  check('used tags are suggested', !!sugg);
  sugg.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })); await tick(20);
  await click($('#f-save'), 120);
  add.resetAddForm({ type:'Refund', account:'Card', category:'Return', amount:'15', description:'Deposit back', date: D(-19), tags: ['trip'] });
  app.navigate('add'); await tick(30);
  await click($('#f-save'), 120);
  check('saved tags', state.transactions.filter(t => (t.tags || []).includes('trip')).length === 3);

  // Splits carry tags on every part; edit + log again keep them.
  add.resetAddForm({ type:'Expense', account:'Card', category:'Groceries', amount:'30', description:'Trip snacks', date: D(-20), tags:['trip'] });
  app.navigate('add'); await tick(30);
  await click($('#f-split'), 30);
  type('.sp-amt[data-i="0"]', '10');
  await click($('#f-save'), 150);
  const snack = state.transactions.filter(t => t.description === 'Trip snacks');
  check('every part of a split gets the tags', snack.length === 2 && snack.every(t => JSON.stringify(t.tags) === '["trip"]'));
  add.startEdit(dinner); await tick(30);
  check('Edit keeps the tags', JSON.stringify(add.addForm.tags) === '["trip","beach"]');
  add.logAgain(dinner); await tick(30);
  check('Log again carries them', JSON.stringify(add.addForm.tags) === '["trip","beach"]');
  add.resetAddForm(); app.navigate('home'); await tick(20);

  // Activity: #search, totals, tag chips.
  const rows = () => $$('#view-txns .txn').map(el => state.transactions.find(t => t.id === el.dataset.id));
  txnFilters.month = 'all';
  app.navigate('txns'); await tick(40);
  type('#t-search', '#tr'); await tick(220);
  check('"#tr" finds everything tagged #trip', rows().length === 5 && rows().every(t => t.tags.includes('trip')), rows().length);
  check('…with what it adds up to (expenses − refunds)', /5 transactions/.test($('.tag-sum').textContent) && /\$115\.00 spent/.test($('.tag-sum').textContent), $('.tag-sum')?.textContent);
  type('#t-search', 'beach'); await tick(220);
  check('plain search matches tags too', rows().some(t => t.description === 'Beach dinner'));
  type('#t-search', ''); await tick(220);
  txnFilters.month = 'current';
  openTxnSheet(dinner.id); await tick(30);
  check('the detail shows its tags', $$('#sheetBody [data-show-tag]').map(b => b.textContent).join(' ') === '#trip #beach');
  await click($('#sheetBody [data-show-tag="trip"]'), 60);
  check('tapping a tag shows it in Activity (all months)', state.view === 'txns' && txnFilters.tag === 'trip' && txnFilters.month === 'all' && rows().length === 5 && !!$('.chip[data-tag-clear]'));
  await click($('.chip[data-tag-clear]'), 60);
  check('× clears the tag filter', txnFilters.tag === null && !$('.tag-sum'));

  // More → Tags.
  tagsMod.openTagsSheet(); await tick(30);
  const tagRows = $$('#sheetBody .tag-row');
  check('Tags lists each tag with count + spend', tagRows.length === 2 && /#trip/.test(tagRows[0].textContent) && /5 transactions/.test(tagRows[0].textContent) && /\$115\.00/.test(tagRows[0].textContent));
  await click(tagRows[1], 60);
  check('…and opens one in Activity', txnFilters.tag === 'beach' && rows().length === 1);
  txnFilters.tag = null; txnFilters.month = 'current';
  app.navigate('home'); await tick(20);
}

/* ── 31. Recurring prompts ── */
const rec = await import('../js/recurring.js');
{
  // Same day of the month, the last 4 months → due today.
  const now = new Date();
  const monthsAgo = (k, dayShift = 0) => {
    const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
    d.setDate(Math.min(now.getDate() + dayShift, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    return util.toLocalISO(d);
  };
  for (let k = 1; k <= 4; k++) await dbPut('transactions', txn({ date: monthsAgo(k), type:'Expense', account:'Card', category:'Streaming', amount: 15.49, description:'Streamflix', tags:['subs'] }));
  // Weekly coffee — regular, but too frequent to prompt for.
  for (let k = 1; k <= 8; k++) await dbPut('transactions', txn({ date: D(-7 * k), type:'Expense', account:'Card', category:'Restaurants', amount: 5, description:'Corner Coffee' }));
  await loadState(); await tick(30);

  const ps = rec.recurringPrompts(T);
  const sf = ps.find(p => p.label === 'Streamflix');
  check('a monthly charge due today is prompted', !!sf && sf.due === T && sf.late === 0, JSON.stringify(ps.map(p => [p.label, p.due])));
  check('weekly habits aren\'t', !ps.some(p => p.label === 'Corner Coffee'));
  check('category-level patterns aren\'t (merchants only)', ps.every(p => p.key.startsWith('m:')));
  check('still prompted 3 days late, not 4', rec.recurringPrompts(D(3)).some(p => p.label === 'Streamflix') && !rec.recurringPrompts(D(4)).some(p => p.label === 'Streamflix'));
  check('not before it\'s due', !rec.recurringPrompts(D(-1)).some(p => p.label === 'Streamflix'));

  app.navigate('home'); app.renderAll(); await tick(40);
  const card = () => $('#view-home .home-card[data-card="recurring"]');
  check('Home shows "Usually charged around now" at the top', !!card() && /Streamflix/.test(card().textContent) && /\$15\.49/.test(card().textContent) && /due today/.test(card().textContent)
    && $('#view-home .home-card').dataset.card === 'recurring');

  const before = state.transactions.length;
  await click($('#view-home .recur-log'), 120);
  const logged = state.transactions.find(t => t.description === 'Streamflix' && t.date === T);
  check('"Log it" logs it like last time, dated when due', state.transactions.length === before + 1 && logged && logged.amount === 15.49 && logged.account === 'Card' && logged.category === 'Streaming' && JSON.stringify(logged.tags) === '["subs"]');
  check('…and the prompt goes away', !card());
  await click($('#toast-act'), 120);
  check('Undo removes it and the prompt is back', !state.transactions.some(t => t.id === logged.id) && !!card());

  await click($('#view-home .recur-edit'), 60);
  check('"Edit first" opens Add with it filled in', state.view === 'add' && add.addForm.description === 'Streamflix' && add.addForm.amount === '15.49' && add.addForm.date === T && !add.addForm.editingId);
  add.resetAddForm(); app.navigate('home'); await tick(30);

  await click($('#view-home .recur-skip'), 60);
  check('"Not now" hides it until the next charge', !card() && state.flags.recurDismissed[sf.key] === T);
  state.flags.recurDismissed = {};
  check('…which would prompt again', rec.recurringPrompts(T).some(p => p.label === 'Streamflix'));

  await dbPut('bills', { id:'b-sf', name:'Streamflix', recurrence:'monthly', type:'Expense', account:'Card', category:'Streaming', amount: 15.49, dueDay: now.getDate(), active:true, paidMonths:{} });
  await loadState();
  check('a bill that covers it takes over (no double reminder)', !rec.recurringPrompts(T).some(p => p.label === 'Streamflix'));
  await dbDel('bills', 'b-sf'); await loadState();
  app.navigate('home'); await tick(20);
}

/* ── 32. Reconcile memory ── */
const recon = await import('../js/reconcile.js');
{
  check('file kind = its header row', recon.fileSig('﻿Status,Date,Description,Debit,Credit\r\nCleared,10/01/2026,X,1.00,') === 'status,date,description,debit,credit');
  check('…or the column count when there\'s no header', recon.fileSig('10/01/2026,X,1.00\n') === 'cols:3');

  const a = txn({ date: D(-10), type:'Expense', account:'Card', category:'Groceries', amount: 12.34, description:'Market' });
  const b = txn({ date: D(-9), type:'Expense', account:'Card', category:'Gas', amount: 56.78, description:'Fuel stop' });
  await dbPut('transactions', a); await dbPut('transactions', b); await loadState();
  const us = (iso) => `${iso.slice(5, 7)}/${iso.slice(8)}/${iso.slice(0, 4)}`;
  const citi = `Status,Date,Description,Debit,Credit\nCleared,${us(D(-10))},MARKET 123,12.34,\nCleared,${us(D(-9))},FUEL STOP 9,56.78,\n`;

  // First time: the account is picked by hand.
  recon.openReconcileWithFile('Date range.CSV', citi); await tick(30);
  await click($('#rc-acct'), 30); await pick('Card'); await tick(30);
  await click($('#rc-rerun'), 200);
  check('the results know this account', /Reconcile · Card/.test($('#sheetBody h2').textContent));
  check('…and remember it for this kind of file', state.flags.reconcileMemory?.bySig['status,date,description,debit,credit'] === 'Card');
  check('matched entries can be marked cleared', !!$('#rc-clear') && /Mark 2 matched as cleared/.test($('#rc-clear').textContent));
  await click($('#rc-clear'), 200);
  check('marking clears exactly the matched ones', state.transactions.find(t => t.id === a.id).cleared === true && state.transactions.find(t => t.id === b.id).cleared === true
    && state.transactions.filter(t => t.cleared).length === 2);
  check('…and records "reconciled through" the statement\'s last date', recon.reconciledThrough('Card') === D(-9) && /reconciled through/.test($('#sheetBody .rc-through')?.textContent || ''));
  closeSheet(); await tick(20);

  // Next time: the same kind of file picks Card by itself.
  recon.openReconcileSheet(); await tick(20);
  await click($('#rc-acct'), 30); await pick('Checking'); await tick(20);   // left on another account
  closeSheet(); await tick(20);
  recon.openReconcileWithFile('Date range (2).CSV', citi); await tick(30);
  check('a file of a known kind opens on its account', $('#rc-acct .picker-val').textContent === 'Card' && /remembered/.test($('#sheetBody').textContent));
  check('setup shows how far it\'s reconciled', /Reconciled through/.test($('#rc-through').textContent));
  await click($('#rc-acct'), 30);
  check('…the account list too', $$('.picker-option').some(o => /Card/.test(o.textContent) && /thru/.test(o.textContent)));
  await pick('Card'); await tick(20);
  closeSheet(); await tick(20);

  // Activity shows the marks; edits that change what the statement showed remove them.
  app.navigate('txns'); await tick(40);
  const rowA = $$('#view-txns .txn').find(el => el.dataset.id === a.id);
  check('Activity marks cleared transactions ✓', !!rowA?.querySelector('.clr'));
  openTxnSheet(a.id); await tick(30);
  check('…and the detail says so', /Cleared — matched on a statement/.test($('#sheetBody').textContent));
  closeSheet(); await tick(20);
  add.startEdit(state.transactions.find(t => t.id === a.id)); await tick(30);
  add.addForm.description = 'Market (weekly)';
  await click($('#f-save'), 120);
  check('editing only the note keeps the mark', state.transactions.find(t => t.id === a.id).cleared === true);
  add.startEdit(state.transactions.find(t => t.id === a.id)); await tick(30);
  add.addForm.amount = '13.34';
  await click($('#f-save'), 120);
  check('changing the amount removes it', !state.transactions.find(t => t.id === a.id).cleared);
  // It's about your accounts, not this phone — a restore on a new phone keeps it.
  check('reconcile memory travels with backups', (await import('../js/db.js')).exportData().flags.reconcileMemory?.through?.Card === D(-9));
  app.navigate('home'); await tick(20);
}

/* ── 33. Statement balance vs current ── */
const stm = await import('../js/statement.js');
{
  await dbPut('accounts', { id:'a5', name:'Stmt Card', type:'Credit Card', active:true, order:5 });
  // Before the statement closed (5 days ago): $100 + $50. After: +$30 charge, −$40 payment.
  for (const [d, type, amount, extra] of [[-20,'Expense',100,{}], [-8,'Expense',50,{}], [-3,'Expense',30,{}], [-2,'CC Payment',40,{ fromAccount:'Checking', category:'CC Payment' }]]){
    await dbPut('transactions', txn({ date: D(d), type, account:'Stmt Card', category:'Groceries', amount, ...extra }));
  }
  await loadState();
  check('no cycle known → no statement figure', stm.statementInfo('Stmt Card') === null);

  // Set the cycle on the card (Accounts → Edit).
  const { openAccountsSheet } = await import('../js/manage.js');
  openAccountsSheet(); await tick(30);
  await click($(`#sheetBody .a-edit[data-id="a5"]`), 30);
  check('a card has statement-cycle fields', !!$('#ae-close-day') && !!$('#ae-grace'));
  const closeDay = util.addDays(new Date(), -5).getDate();
  type('#ae-close-day', String(closeDay)); type('#ae-grace', '25');
  await click($('#ae-save'), 80);
  closeSheet(); await tick(20);
  const card = state.accounts.find(a => a.name === 'Stmt Card');
  check('saved on the account', card.closeDay === closeDay && card.graceDays === 25);

  const s = stm.statementInfo('Stmt Card', T);
  check('statement closed 5 days ago', s.closeIso === D(-5) && s.dueIso === D(20));
  check('statement balance = $150 (what was owed when it closed)', s.statement === 150);
  check('current balance = $140 (150 + 30 new − 40 paid)', s.current === 140);
  check('still due from the statement = $110 (150 − 40 paid since)', s.remaining === 110);

  app.navigate('home'); app.renderAll(); await tick(40);
  const row = $(`#view-home .acct-row[data-acct="Stmt Card"]`);
  check('Home shows the statement next to the current balance', !!row && /statement \$110\.00 due/.test(row.textContent) && /140\.00/.test(row.querySelector('.acct-bal').textContent));

  // An Auto (CC) bill can pay the statement balance instead of the current one.
  const { getBillAmount, openBillSheet } = await import('../js/bills.js');
  const bill = { id:'b-stm', name:'Stmt Card bill', recurrence:'auto-cc', linkedAccount:'Stmt Card', fromAccount:'Checking', closeDay, graceDays: 25, active:true, paidMonths:{}, type:'CC Payment', account:'Stmt Card' };
  await dbPut('bills', bill); await loadState();
  check('auto-pay bill: current balance by default ($140)', getBillAmount(state.bills.find(b => b.id === 'b-stm')) === 140);
  openBillSheet('b-stm'); await tick(30);
  check('the bill offers "Statement balance"', !!$('#bf-ccamt'));
  await click($('#bf-ccamt .seg-btn[data-v="statement"]'), 30);
  await click($('#bf-save'), 80);
  check('…saved; the bill now asks for $110', state.bills.find(b => b.id === 'b-stm').ccAmount === 'statement' && getBillAmount(state.bills.find(b => b.id === 'b-stm')) === 110);
  check('past months still read the month-end balance', getBillAmount(state.bills.find(b => b.id === 'b-stm'), 2020, 1) === 0);

  // Paying what's due → "statement paid".
  await dbPut('transactions', txn({ date: T, type:'CC Payment', account:'Stmt Card', fromAccount:'Checking', category:'CC Payment', amount: 110 }));
  await loadState();
  check('paying it leaves nothing due', stm.statementInfo('Stmt Card').remaining === 0 && getBillAmount(state.bills.find(b => b.id === 'b-stm')) === 0);
  app.renderAll(); await tick(30);
  check('…and Home says the statement is paid', /statement paid ✓/.test($(`#view-home .acct-row[data-acct="Stmt Card"]`).textContent));

  // Without its own cycle, a card uses its auto-pay bill's.
  const live = state.accounts.find(a => a.name === 'Stmt Card');   // (loadState replaced the objects)
  delete live.closeDay; delete live.graceDays;
  check('no card cycle → the Auto (CC) bill\'s', stm.cardCycle('Stmt Card')?.source === 'bill' && stm.cardCycle('Stmt Card').closeDay === closeDay);
  check('closing day clamps in short months', util.toLocalISO(stm.lastClose(31, '2027-02-27')) === '2027-01-31' && util.toLocalISO(stm.lastClose(31, '2027-02-28')) === '2027-02-28');
  await dbDel('bills', 'b-stm'); await loadState();
}

/* ── 34. More charts ── */
const charts = await import('../js/charts.js');
{
  check('month windows cross the year boundary', charts.monthsBack(3, 2027, 1).map(p => p.ym).join() === '2026-11,2026-12,2027-01');
  const { year: y, month: m } = state.selected;
  const sp = charts.spendingByMonth(12, y, m);
  check('spending by month: 12 months ending at the selected one', sp.length === 12 && sp[11].ym === `${y}-${String(m).padStart(2, '0')}` && sp[11].exp === monthTotals(y, m).exp);
  const ym = `${y}-${String(m).padStart(2, '0')}`;
  const groc = util.sumMoney(state.transactions.filter(t => t.type === 'Expense' && t.category === 'Groceries' && t.date?.startsWith(ym)), t => t.amount);
  check('category trend: this month\'s Groceries matches the transactions', charts.categorySeries('Groceries', 12, y, m)[11].value === groc);
  const tops = charts.topCategories(12, y, m);
  check('top categories ordered by spend', tops.length > 2 && tops.includes('Groceries'));

  // Net worth snapshots for the big chart.
  for (const [k, d, c] of [[1, D(-400), 1000], [2, D(-150), 1500], [3, D(-20), 2100]]){
    await dbPut('networth', { id: 'nw' + k, date: d, checking: c, savings: 0, investments: 0, ccDebt: 0, otherDebt: 0 });
  }
  await loadState();

  app.navigate('more'); await tick(40);
  check('More has Charts', !!$('#view-more .menu-item[data-act="charts"]'));
  await click($('#view-more .menu-item[data-act="charts"]'), 60);
  check('Charts opens on spending: 12 bars, this month highlighted, average line', $$('#ch-body .ch-bar').length === 12 && $$('#ch-body .ch-bar')[11].classList.contains('cur') && !!$('#ch-body .ch-avg'));
  check('…opens as a wide dialog unfolded (sheet-wide)', $('#sheet').classList.contains('sheet-wide'));
  await click($('#ch-span .seg-btn[data-v="6"]'), 40);
  check('6 months → 6 bars', $$('#ch-body .ch-bar').length === 6);
  const firstBar = $$('#ch-body .ch-bar')[0];
  firstBar.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await tick(20);
  const p0 = charts.spendingByMonth(6, y, m)[0];
  check('tapping a bar shows that month', $('#ch-cap').textContent.startsWith(util.monthName(p0.m)) && $$('#ch-body .ch-bar')[0].classList.contains('cur'));

  await click($('#ch-tab .seg-btn[data-v="categories"]'), 40);
  check('Categories: chips for your top categories', $$('.ch-cats .chip').length === tops.length && $('.ch-cats .chip[aria-pressed="true"]').dataset.cat === tops[0]);
  await click($('.ch-cats .chip[data-cat="Groceries"]'), 40);
  check('…picking one charts it', /Groceries per month/.test($('.ch-head').textContent) && $$('#ch-body .ch-bar').length === 6 && /vs avg/.test($('.ch-stats').textContent));

  await click($('#ch-tab .seg-btn[data-v="networth"]'), 40);
  check('Net worth: the 1Y range shows the last year\'s snapshots', $$('#ch-body .ch-dot').length === 2 && /\$2,100\.00/.test($('.ch-head').textContent));
  await click($('#ch-nw .seg-btn[data-v="all"]'), 40);
  check('…All shows every one', $$('#ch-body .ch-dot').length === 3 && /\+\$1,100\.00 since/.test($('#ch-body').textContent));
  closeSheet(); await tick(20);
  app.renderAll(); await tick(30);
  await click($('#nw-big'), 60);
  check('the Net Worth card opens the full chart', $('#ch-tab .seg-btn.active')?.dataset.v === 'networth');
  closeSheet(); await tick(20);
  app.navigate('home'); await tick(20);
}

/* ── 35. Rollover budgets + budget left per day ── */
const bud = await import('../js/budgets.js');
{
  // A past year, so "today" doesn't matter: $100/month for Utilities.
  const amounts = Object.fromEntries(util.monthAbbr.map(m => [m, 100]));
  const ub = { id:'bu1', year: 2025, type:'Expense', category:'Utilities', amounts: { ...amounts } };
  await dbPut('budgets', ub);
  await dbPut('transactions', txn({ date:'2025-01-12', type:'Expense', account:'Checking', category:'Utilities', amount: 60 }));    // 40 under
  await dbPut('transactions', txn({ date:'2025-02-10', type:'Expense', account:'Checking', category:'Utilities', amount: 170 }));   // 70 over…
  await dbPut('transactions', txn({ date:'2025-02-20', type:'Refund', account:'Checking', category:'Return', amount: 20, offsetCategory:'Utilities' }));  // …50 over net
  await loadState();
  const b = () => state.budgets.find(x => x.id === 'bu1');
  check('without rollover every month is its own $100', bud.budgetMonth(b(), 3).target === 100 && bud.budgetMonth(b(), 3).carry === 0);
  b().rollover = true;
  check('rollover: January\'s $40 left carries into February ($140)', bud.budgetMonth(b(), 2).carry === 40 && bud.budgetMonth(b(), 2).target === 140);
  check('…February\'s overspend (net of the refund) comes off March: 40 + (100 − 150) = −10 → $90',
    bud.budgetMonth(b(), 3).carry === -10 && bud.budgetMonth(b(), 3).target === 90);
  check('January starts fresh', bud.budgetMonth(b(), 1).carry === 0);
  check('left per day: $300 with 10 days to go (incl. today) = $30/day', bud.leftPerDay(300, 2026, 9, new Date(2026, 8, 21)) === 30);
  check('…$0 once overspent, none for other months', bud.leftPerDay(-5, 2026, 9, new Date(2026, 8, 21)) === 0 && bud.leftPerDay(300, 2026, 8, new Date(2026, 8, 21)) === null);

  // Budgets sheet: the switch + rolled-over lines.
  delete b().rollover; await dbPut('budgets', b());
  state.selected.year = 2025; state.selected.month = 3;
  bud.openBudgetsSheet(); await tick(30);
  await click($('#b-pick'), 30); await pick('Utilities · Expense'); await tick(30);
  check('an expense budget has a rollover switch (off)', $('#b-rollover .seg-btn.active')?.dataset.v === 'off' && !$('.b-carry'));
  await click($('#b-rollover .seg-btn[data-v="on"]'), 60);
  check('switching it on is saved', b().rollover === true && (await import('../js/db.js')).state.budgets.find(x => x.id === 'bu1').rollover === true);
  const rows = $$('.budget-row');
  check('February shows the $40 rolled in', /Rolled in\s*\+\$40\.00/.test(rows[1].textContent));
  check('March shows the earlier overspend', /Overspent before\s*−\$10\.00/.test(rows[2].textContent));
  check('the month inputs still edit the base amount', rows[2].querySelector('.b-cell').value === '100.00');
  closeSheet(); await tick(20);
  const now = new Date();
  state.selected.year = now.getFullYear(); state.selected.month = now.getMonth() + 1;

  // Home: this month's budget shows $/day left.
  const thisYear = Object.fromEntries(util.monthAbbr.map(m => [m, 5000]));
  await dbPut('budgets', { id:'bu2', year: now.getFullYear(), type:'Expense', category:'Groceries', amounts: thisYear, rollover: true });
  await loadState();
  app.navigate('home'); app.renderAll(); await tick(40);
  const row = $$('#view-home .bdg-row').find(r => /Groceries/.test(r.textContent));
  const bm = bud.budgetMonth(state.budgets.find(x => x.id === 'bu2'), now.getMonth() + 1);
  check('Home budget rows show what\'s left per day', !!row && new RegExp(util.fmt(bud.leftPerDay(bm.left, now.getFullYear(), now.getMonth() + 1)).replace(/[$.]/g, '\\$&') + '/day').test(row.textContent), row?.textContent);
  check('…and the rollover carried in (↻)', now.getMonth() === 0 || /↻/.test(row.textContent));
  await dbDel('budgets', 'bu2'); await dbDel('budgets', 'bu1'); await loadState();
}

/* ── 36. Daily snapshots (keep 7) + one-tap share from the backup reminder ── */
{
  const dbm = await import('../js/db.js');
  const dailies = async () => (await dbm.listSnapshots()).filter(s => s.kind === 'daily');
  const s1 = await dbm.maybeDailySnapshot('2030-01-01');
  check('first open of the day takes a daily snapshot', !!s1 && s1.kind === 'daily' && s1.reason === 'Daily' && s1.txnCount === state.transactions.length);
  check('…once a day', (await dbm.maybeDailySnapshot('2030-01-01')) === null && (await dailies()).length === 1);
  check('…and not again when nothing changed', (await dbm.maybeDailySnapshot('2030-01-02')) === null && state.flags.lastDailySnapshot === '2030-01-02');
  // Two safety snapshots (as a restore would take) + 9 changed days.
  await dbm.saveSnapshot('Before restoring a.json'); await dbm.saveSnapshot('Before restoring b.json');
  for (let d = 3; d <= 11; d++){
    await dbPut('transactions', txn({ date: D(-1), type:'Expense', account:'Checking', category:'Groceries', amount: d, description:'snap day ' + d }));
    await loadState();
    await dbm.maybeDailySnapshot(`2030-01-${String(d).padStart(2, '0')}`);
  }
  const all = await dbm.listSnapshots();
  check('the newest 7 daily snapshots are kept', (await dailies()).length === 7 && (await dailies())[0].txnCount === state.transactions.length);
  check('…without pushing out the safety snapshots', all.filter(s => s.kind !== 'daily').length === 2);
  check('the "last daily" marker stays on this device', !('lastDailySnapshot' in dbm.exportData().flags));

  // Roll back to a daily snapshot from Backup & Restore.
  const { openBackupSheet, maybeBackupNudge } = await import('../js/manage.js');
  const oldest = (await dailies()).at(-1);
  await openBackupSheet(() => {}); await tick(30);
  check('Backup & Restore lists the daily snapshots', $$('#sheetBody .bk-roll').length === 9 && /once a day/.test($('#sheetBody').textContent));
  await click($(`#sheetBody .bk-roll[data-id="${oldest.id}"]`), 400);
  check('rolling back to a daily snapshot restores it', state.transactions.length === oldest.txnCount);
  closeSheet(); await tick(20);

  // Backup reminder → one tap.
  state.flags.lastBackupAt = Date.now() - 40 * 86400000; state.flags.lastBackupNudge = 0;
  await maybeBackupNudge(); await tick(1500);
  check('no share sheet available → "Save now"', /Backup is 40 days old/.test($('#toast').textContent) && $('#toast-act')?.textContent === 'Save now');
  let shared = null;
  navigator.canShare = () => true;
  navigator.share = async (d) => { shared = d; };
  state.flags.lastBackupNudge = 0;
  await maybeBackupNudge(); await tick(1500);
  check('with a share sheet → "Share now"', $('#toast-act')?.textContent === 'Share now');
  await click($('#toast-act'), 120);
  const readFile = (f) => new Promise(r => { const fr = new dom.window.FileReader(); fr.onload = () => r(fr.result); fr.readAsText(f); });   // jsdom's File has no .text()
  check('one tap shares today\'s backup file', shared?.files?.[0]?.name === `ledger-backup-${T}.json` && JSON.parse(await readFile(shared.files[0])).app === 'ledger');
  check('…and counts as backed up', Date.now() - state.flags.lastBackupAt < 60000);
  state.flags.lastBackupNudge = 0;
  await maybeBackupNudge(); await tick(1500);
  check('no nag right after a backup', state.flags.lastBackupNudge === 0 && !/days old|No backup yet/.test($('#toast').textContent));
  delete navigator.canShare; delete navigator.share;
}

check('zero captured errors', errors.length === 0, errors[0]);
done('everyday tests');
