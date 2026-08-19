/* Deterministic synthetic dataset for tests. NO real financial data lives in
   this repo — the app's data stays on-device; tests run against this. */
const LCG = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2**32;

export const ACCOUNTS = [
  ['Main CC','Credit Card'],['Promo CC','Credit Card'],['Checking','Checking'],
  ['Savings','Savings'],['Car Loan','Loan']
].map((a,i) => ({ id:'a'+i, name:a[0], type:a[1], active:true, order:i }));

export const CATEGORIES = {
  Expense: ['Groceries','Restaurants','Gas','Shopping','Streaming','Phone Bill','Misc'],
  Income: ['Salary','Side Income'],
  Refund: ['Return','Purchase Refund']
};

// ~14 months of plausible activity ending today. Seeded → identical every run.
export function makeDataset(){
  const rnd = LCG(20260612);
  const txns = [];
  let id = 0;
  const T = (date, type, account, category, amount, description='') =>
    txns.push({ id:'fx'+(id++), date, type, account, category,
                amount: Math.round(amount*100)/100, description, fromAccount:null });
  const iso = (d) => d.toISOString().slice(0,10);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth()-13, 1);

  // bi-weekly salary, regime change 3 months ago (raise)
  let pay = new Date(start);
  while (pay <= today){
    const old = (today - pay) / 86400000 > 95;
    T(iso(pay), 'Income', 'Checking', 'Salary', old ? 1450 : 2100);
    pay = new Date(pay.getFullYear(), pay.getMonth(), pay.getDate()+14);
  }
  // monthly fixed: streaming $15.99 (hikes to $21.99 in last 2 charges), phone ~$95
  for (let d = new Date(start); d <= today; d = new Date(d.getFullYear(), d.getMonth()+1, 1)){
    const left = (today.getFullYear()-d.getFullYear())*12 + (today.getMonth()-d.getMonth());
    // FIX(v2.9.1): the current month's charge used to be hard-dated the 5th —
    // future-dated before the 5th, so detectRecurring (rightly) excluded it
    // and the price-hike assertion failed on days 1–4 of every month.
    const chargeDay = left === 0 ? Math.min(5, today.getDate()) : 5;
    T(iso(new Date(d.getFullYear(), d.getMonth(), chargeDay)), 'Expense', 'Main CC', 'Streaming', left < 2 ? 21.99 : 15.99);
    if (new Date(d.getFullYear(), d.getMonth(), 12) <= today)
      T(iso(new Date(d.getFullYear(), d.getMonth(), 12)), 'Expense', 'Main CC', 'Phone Bill', 93 + rnd()*4);
  }
  // variable daily-ish spending on Main CC + Checking
  for (let d = new Date(start); d <= today; d = new Date(d.getFullYear(), d.getMonth(), d.getDate()+1)){
    if (rnd() < 0.55){
      const cat = ['Groceries','Restaurants','Gas','Shopping','Misc'][Math.floor(rnd()*5)];
      const amt = { Groceries: 25+rnd()*60, Restaurants: 12+rnd()*30, Gas: 30+rnd()*20,
                    Shopping: 10+rnd()*90, Misc: 5+rnd()*25 }[cat];
      T(iso(d), 'Expense', rnd() < 0.8 ? 'Main CC' : 'Checking', cat, amt, cat==='Groceries'?'MegaMart':'');
    }
    if (rnd() < 0.03) T(iso(d), 'Refund', 'Main CC', 'Return', 8+rnd()*40);
    if (rnd() < 0.04) T(iso(d), 'Income', 'Checking', 'Side Income', 10+rnd()*30);
  }
  // monthly CC payment + a loan payment
  for (let d = new Date(start); d <= today; d = new Date(d.getFullYear(), d.getMonth()+1, 1)){
    const pd = new Date(d.getFullYear(), d.getMonth(), 25);
    if (pd <= today){
      T(iso(pd), 'CC Payment', 'Main CC', 'CC Payment', 600+rnd()*500);
      txns[txns.length-1].fromAccount = 'Checking';
      T(iso(pd), 'Loan Payment', 'Car Loan', 'Loan Payment', 320);
      txns[txns.length-1].fromAccount = 'Checking';
    }
  }
  return txns.sort((a,b) => a.date.localeCompare(b.date));
}

// Bank-statement CSV mirroring the dataset's Main CC activity with realistic
// posting lags, plus planted fakes/declines for the reconcile suite.
export function makeStatementCSV(txns){
  const rows = [];
  const cc = txns.filter(t => t.account === 'Main CC' || t.fromAccount === 'Main CC');
  cc.forEach((t, i) => {
    const lag = i % 17 === 0 ? 5 : i % 3;          // mostly 0–2d, some 5d
    const d = new Date(t.date); d.setDate(d.getDate() + lag);
    const amt = t.type === 'Expense' ? t.amount : -t.amount;
    rows.push([d.toISOString().slice(0,10), '12:00 PM', 'test user', amt.toFixed(2), '0', '',
               'Posted', t.type === 'CC Payment' ? 'Payment' : 'Purchase', t.description || t.category, '']);
  });
  // drop two rows from the MIDDLE (dropping the earliest would shrink the
  // statement's date range and hide them from the diff entirely)
  const dropped = rows.splice(Math.floor(rows.length/2), 2); // → ledger-only
  rows.push(['2099-01-01','1:00 PM','test user','18.47','0','','Posted','Purchase','FAKE WINGS','']);   // placeholder dates fixed below
  rows.push(['2099-01-02','1:00 PM','test user','4.99','0','','Posted','Purchase','FAKE GAME','']);
  // place fakes inside the real range
  const mid = rows[Math.floor(rows.length/2)][0];
  rows[rows.length-2][0] = mid; rows[rows.length-1][0] = mid;
  rows.push([mid,'2:00 PM','test user','27.05','0','','Declined','Purchase','DECLINED RETRY','']);
  const csv = 'Date,Time,Cardholder,Amount,Points,Balance,Status,Type,Merchant,Description\n'
    + rows.map(r => r.map(x => `"${x}"`).join(',')).join('\n');
  return { csv, fakeCount: 2, droppedCount: dropped.length };
}
