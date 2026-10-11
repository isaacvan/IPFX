/* Reported account totals only; never assign account-wide fees to a trader. */
(() => {
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const amount=v=>typeof v==='number'&&Number.isFinite(v)?v.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2}):'Unavailable';
 const labels={INCOMPLETE:'Cost fields incomplete',CONSISTENT_POSITIVE_FEE:'Gross / net / fees agree',CONSISTENT_SIGNED_FEE:'Gross / net / signed fees agree',ZERO_REPORTED_DIFFERENCE:'No reported gross-to-net difference',UNATTRIBUTED_DIFFERENCE:'Unattributed cost or timing difference — review'};
 function render(rows,now=Date.now()){
  if(!Array.isArray(rows))return '<p class="small">Reported E8 account totals unavailable.</p>';
  if(!rows.length)return '<p class="small">No E8 account totals captured yet.</p>';
  return rows.map(r=>{
   const age=(now-Date.parse(r.received_at))/1000,fresh=r.fresh===true&&Number.isFinite(age)&&age>=0&&age<180;
   const a=r.amounts||{},status=r.reconciliation?.status;
   return `<section><h3>${esc(r.label||'E8 monitor')} · reported account totals</h3><p class="small">${fresh?'Recent API snapshot':'Stale / unavailable snapshot'}${Number.isFinite(age)?' · '+Math.max(0,Math.round(age))+'s old':''}${r.error?' · '+esc(r.error):''}</p>
    <div class="table-wrap"><table><thead><tr><th>Broker today gross</th><th>Broker today net</th><th>Reported fees</th><th>Open gross</th><th>Open net</th></tr></thead><tbody><tr><td>${amount(a.todayGross)}</td><td>${amount(a.todayNet)}</td><td>${amount(a.todayFees)}</td><td>${amount(a.openGrossPnL)}</td><td>${amount(a.openNetPnL)}</td></tr></tbody></table></div>
    <p class="small">${esc(labels[status]||'Reconciliation unavailable')} · ${esc(r.currency||'Broker account currency not supplied')}.</p>
    <p class="small">These are reported whole-account amounts, not trader reverse estimates or cash payouts. “Today” follows the broker’s unconfirmed reset boundary. Fees and any unexplained difference are not allocated to individual trades. Missing values stay unavailable.</p></section>`;
  }).join('');
 }
 window.IPFXE8AccountTotals={render};
})();
