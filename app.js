const $ = (id) => document.getElementById(id);
const money = (n) => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(Number(n||0));
const escapeHtml = (s='') => String(s).replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]));
const b64bytes = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const ownershipKey = 'money-dashboard-ownership-v1';
const budgetKey = 'money-dashboard-budgets-v1';
let snapshot = null;

function readJson(key){ try{return JSON.parse(localStorage.getItem(key)||'{}')}catch{return {}} }
function saveJson(key,v){ localStorage.setItem(key,JSON.stringify(v)); }
function ownerPct(account){ const saved=readJson(ownershipKey); return Number(saved[account.account_id] ?? 100); }
function ownedBalance(account){ return Number(account.current||0) * ownerPct(account)/100; }

async function decryptSnapshot(passphrase){
  const res=await fetch(`data.enc.json?t=${Date.now()}`,{cache:'no-store'});
  if(!res.ok) throw new Error('Encrypted snapshot is not available yet.');
  const envelope=await res.json();
  if(!envelope.ciphertext) throw new Error('The first daily sync has not run yet.');
  const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(passphrase),'PBKDF2',false,['deriveKey']);
  const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt:b64bytes(envelope.salt),iterations:Number(envelope.iterations||250000),hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['decrypt']);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64bytes(envelope.iv)},key,b64bytes(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plain));
}

function summaryData(){
  const depository=snapshot.accounts.filter(a=>a.type==='depository').reduce((s,a)=>s+ownedBalance(a),0);
  const credit=snapshot.accounts.filter(a=>a.type==='credit').reduce((s,a)=>s+ownedBalance(a),0);
  const investments=(snapshot.holdings||[]).reduce((s,h)=>s+Number(h.value||0),0);
  return {net:depository+investments-credit,cash:depository,credit,investments,spend:Number(snapshot.month_spend||0)};
}

function renderSummary(){
  const s=summaryData();
  const cards=[
    ['Tracked net worth',money(s.net),'Cash + investments − credit cards; joint ownership adjusted'],
    ['Liquid cash',money(s.cash),'Checking + savings; joint ownership adjusted'],
    ['Credit cards owed',money(s.credit),'Current Discover + Chase balances'],
    ['Spent this month',money(s.spend),'Purchases counted once; card repayments excluded']
  ];
  $('summary').innerHTML=cards.map(([l,v,sub])=>`<div class="summary-card"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`).join('');
}

function renderAccounts(){
  const accounts=[...snapshot.accounts].sort((a,b)=>Number(b.current||0)-Number(a.current||0));
  $('accountsBody').innerHTML=accounts.map(a=>`<tr>
    <td>${escapeHtml(a.institution)}</td>
    <td><div class="account-name">${escapeHtml(a.name)}</div><div class="tiny">•••• ${escapeHtml(a.mask||'')}</div></td>
    <td>${escapeHtml(a.subtype||a.type)}</td>
    <td>${money(a.current)}</td>
    <td><input class="ownership" type="number" min="0" max="100" step="1" value="${ownerPct(a)}" data-account="${escapeHtml(a.account_id)}" aria-label="ownership percentage" /></td>
    <td data-share="${escapeHtml(a.account_id)}">${money(ownedBalance(a))}</td>
  </tr>`).join('');
  document.querySelectorAll('.ownership').forEach(el=>el.addEventListener('change',()=>{
    const all=readJson(ownershipKey); all[el.dataset.account]=Math.max(0,Math.min(100,Number(el.value||0))); saveJson(ownershipKey,all);
    const account=snapshot.accounts.find(a=>a.account_id===el.dataset.account); document.querySelector(`[data-share="${CSS.escape(el.dataset.account)}"]`).textContent=money(ownedBalance(account)); renderSummary();
  }));
}

function renderCards(){
  const cards=snapshot.accounts.filter(a=>a.type==='credit');
  const spends=snapshot.card_spend_by_account||{};
  $('cards').innerHTML=cards.length?cards.map(a=>`<div class="card-row"><div><div class="account-name">${escapeHtml(a.institution)} · ${escapeHtml(a.name)}</div><div class="tiny">•••• ${escapeHtml(a.mask||'')} · this month ${money(spends[a.account_id]||0)}</div></div><div class="metric">${money(a.current)}</div></div>`).join(''):'<p class="muted">No credit-card snapshot yet.</p>';
}

function renderHoldings(){
  const holdings=(snapshot.holdings||[]).slice(0,20);
  $('holdings').innerHTML=holdings.length?holdings.map(h=>`<div class="holding-row"><div><div class="account-name">${escapeHtml(h.ticker||h.name||'Holding')}</div><div class="tiny">${Number(h.quantity||0).toLocaleString(undefined,{maximumFractionDigits:6})} shares · ${money(h.price)} each</div></div><div class="metric">${money(h.value)}</div></div>`).join(''):'<p class="muted">Robinhood has not been linked to this dashboard yet.</p>';
}

function renderBudgets(){
  const actual=snapshot.spending_by_category||{};
  const saved=readJson(budgetKey);
  const categories=snapshot.budget_categories||Object.keys(actual);
  $('budgets').innerHTML=categories.map(cat=>{
    const spent=Number(actual[cat]||0),limit=Number(saved[cat]||0),pct=limit>0?Math.min(100,spent/limit*100):0,over=limit>0&&spent>limit;
    return `<div class="budget-row ${over?'over':''}" data-budget-row="${escapeHtml(cat)}"><div class="budget-head"><strong>${escapeHtml(cat)}</strong><input class="budget-input" type="number" min="0" step="25" data-category="${escapeHtml(cat)}" value="${limit||''}" placeholder="Limit" /></div><div class="progress"><span style="width:${pct}%"></span></div><div class="budget-meta"><span>${money(spent)} spent</span><span>${limit?money(Math.max(0,limit-spent))+' left':'No limit set'}</span></div></div>`;
  }).join('');
}

function renderTransactions(){
  const rows=(snapshot.transactions||[]).slice(0,60);
  $('transactionsBody').innerHTML=rows.map(t=>{ const amount=Number(t.amount||0),out=amount>=0; return `<tr><td>${escapeHtml(t.date)}</td><td><div class="account-name">${escapeHtml(t.merchant||t.name||'Transaction')}</div>${t.pending?'<div class="tiny">Pending</div>':''}</td><td>${escapeHtml(t.institution)}<div class="tiny">${escapeHtml(t.account_name||'')}</div></td><td>${escapeHtml(t.category||'Other')}</td><td class="right ${out?'amount-out':'amount-in'}">${out?'-':'+'}${money(Math.abs(amount))}</td></tr>` }).join('');
}

function render(){
  $('unlockView').classList.add('hidden'); $('dashboard').classList.remove('hidden');
  $('updatedAt').textContent=`Updated ${new Date(snapshot.generated_at).toLocaleString()}`;
  renderSummary(); renderAccounts(); renderCards(); renderHoldings(); renderBudgets(); renderTransactions();
}

$('unlockForm').addEventListener('submit',async(e)=>{
  e.preventDefault(); $('unlockError').textContent='Decrypting…';
  try{ snapshot=await decryptSnapshot($('passphrase').value); $('passphrase').value=''; $('unlockError').textContent=''; render(); }
  catch(err){ $('unlockError').textContent=err?.message?.includes('decrypt')?'Incorrect passphrase or damaged snapshot.':(err?.message||'Could not unlock snapshot.'); }
});

$('saveBudgets').addEventListener('click',()=>{
  const saved={}; document.querySelectorAll('.budget-input').forEach(el=>saved[el.dataset.category]=Number(el.value||0)); saveJson(budgetKey,saved); renderBudgets();
});
