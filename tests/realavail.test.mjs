import { bootEnv, makeChecker, tick } from './_env.mjs';
const dom = await bootEnv();
const { check, done } = makeChecker();
const $ = s => dom.window.document.querySelector(s);
const $$ = s => Array.from(dom.window.document.querySelectorAll(s));
const num = (s) => parseFloat(s.replace(/[$,]/g, '').replace('−', '-'));
const { state, dbPut, loadState, saveFlags } = await import('../js/db.js');
await import('../js/app.js'); await tick(200);

const now = new Date();
const ym = now.toISOString().slice(0,7);
const d = (day) => `${ym}-${String(day).padStart(2,'0')}`;
await dbPut('accounts', { id:'a1', name:'WF Checking', type:'Checking', active:true, order:0 });
await dbPut('accounts', { id:'a2', name:'RH CC', type:'Credit Card', active:true, order:1 });
await dbPut('accounts', { id:'a3', name:'WF CC', type:'Credit Card', active:true, order:2 });
await dbPut('categories', { id:'Expense', list:['Misc'] });
// cash 1000; RH CC balance 250; WF CC balance 3000 (long-term, should NOT subtract)
await dbPut('transactions', { id:'t1', date:d(1), type:'Income', account:'WF Checking', category:'Salary', amount:1000, description:'' });
await dbPut('transactions', { id:'t2', date:d(2), type:'Expense', account:'RH CC', category:'Misc', amount:250, description:'' });
await dbPut('transactions', { id:'t3', date:d(2), type:'Expense', account:'WF CC', category:'Misc', amount:3000, description:'' });
// one standard unpaid bill $100, and an auto-cc bill tracking RH CC
await dbPut('bills', { id:'b1', name:'Rent', recurrence:'monthly', amount:100, dueDay:28, account:'Landlord', fromAccount:'WF Checking', active:true, paidMonths:{} });
await dbPut('bills', { id:'b2', name:'RH Card', recurrence:'auto-cc', linkedAccount:'RH CC', dueDay:25, fromAccount:'WF Checking', active:true, paidMonths:{} });
await loadState();

const { navigate } = await import('../js/app.js');
navigate('home'); await tick();

// default: no cards selected → available = 1000 - (100 + 250 auto-cc) = 650
let avail = num($('.real-card .v').textContent);
check('baseline includes auto-cc in bills', Math.abs(avail - 650) < 0.01, 'got ' + avail);

// open config, check RH CC
$('#ra-config').click(); await tick();
check('config sheet open', $('#sheet').classList.contains('open'));
check('both debt accounts listed', $$('.ra-row').length === 2);
$$('.ra-row').find(r => r.dataset.name === 'RH CC').click(); await tick(120);

// now: bills side drops the auto-cc (guard), card side subtracts 250 → 1000-100-250 = 650 (same total, no double count)
avail = num($('.real-card .v').textContent);
check('RH CC selected: no double count with its auto-cc bill', Math.abs(avail - 650) < 0.01, 'got ' + avail);
const rows = $$('.real-card .rb-row').map(r => r.textContent);
check('RH CC line shown', rows.some(t => t.includes('− RH CC') && t.includes('250')));
check('bills line excludes auto-cc now', rows.some(t => t.includes('Bills due') && t.includes('100')));

// also select WF CC → subtracts 3000 → 650-3000 = -2350
$$('.ra-row').find(r => r.dataset.name === 'WF CC').click(); await tick(120);
avail = num($('.real-card .v').textContent.replace('−','-'));
check('WF CC adds its balance to deduction', Math.abs(avail - (-2350)) < 0.01, 'got ' + avail);

// uncheck WF CC (the long-term card stays out, per the use case)
$$('.ra-row').find(r => r.dataset.name === 'WF CC').click(); await tick(120);
avail = num($('.real-card .v').textContent);
check('uncheck restores', Math.abs(avail - 650) < 0.01, 'got ' + avail);
check('persisted in flags', JSON.stringify(state.flags.realAvailCards) === '["RH CC"]', JSON.stringify(state.flags.realAvailCards));
check('subtitle names the card', $('.real-card .sub').textContent.includes('RH CC'));
done('real-available tests');
