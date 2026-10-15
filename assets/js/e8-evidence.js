/* Owner evidence tools. Reads existing records and imports reviewed receipts; never enables execution. */
(() => {
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const finite=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
 const money=v=>finite(v)?Number(v).toLocaleString('en-US',{style:'currency',currency:'USD'}):'Unknown';
 const ms=v=>finite(v)?Math.round(Number(v))+' ms':'Unknown';
 const uk=v=>v?new Date(v).toLocaleString('en-GB',{timeZone:'Europe/London',timeZoneName:'short'}):'Unknown';
 // Header-driven clipboard import only. IDs remain strings; empty/dash costs stay empty.
 function parseRow(text){
  const lines=String(text).trim().split(/\r?\n/);if(lines.length!==2)throw Error('Paste the header and exactly one tab-separated Closed Positions row.');
  const headers=lines[0].split('\t').map(x=>x.trim().toLowerCase()),values=lines[1].split('\t');
  if(headers.length!==values.length||new Set(headers).size!==headers.length)throw Error('Headers and row columns do not match.');
  const map=Object.fromEntries(headers.map((h,i)=>[h,values[i].trim()]));
  const ids={positionId:map['position id'],openingOrderId:map['opening order id'],closingOrderIds:map['closing order ids']};
  const out={...ids};for(const [field,header] of Object.entries({quantity:'amount',gross:'p&l',net:'net p&l',fee:'fee',swap:'swap',commission:'commission'})){
   const raw=map[header];if(raw==null||raw===''||raw==='—'||raw==='-')continue;
   if(/[£€]/.test(raw))throw Error('This importer requires USD amounts; foreign currency must not be relabelled as USD.');
   const clean=raw.replace(/[,$\s]/g,'').replace(/−/g,'-');if(!/^[+-]?\d+(?:\.\d+)?$/.test(clean))throw Error('Review the '+header+' field manually.');out[field]=clean;
  }return out;
 }
 function init(call,host){
  if(!host||host.dataset.evidenceMounted)return;host.dataset.evidenceMounted='true';
  let data=null,loading=false;
  host.innerHTML='<h2>E8 execution evidence</h2><p>Confirmed fills, reviewed receipts and paper estimates stay separate. These tools do not place trades.</p><button class="btn" type="button" data-e8="refresh">Refresh evidence</button><p role="status" data-status>Loading evidence…</p><div data-output></div>';
  const status=host.querySelector('[data-status]'),output=host.querySelector('[data-output]');
  const input=(key,label,type='text',optional=false)=>`<label style="display:block;margin:12px 0">${esc(label)}<input class="input" style="display:block;width:100%;box-sizing:border-box" name="${key}" type="${type}" ${type==='number'?'step="any"':''} ${optional?'':'required'} autocomplete="off"></label>`;
  const accountOptions=()=>'<option value="">Choose the exact saved E8 account</option>'+(data.accounts||[]).map(a=>`<option value="${esc(a.id)}">${esc(a.label)} · #${esc(a.account_id)}</option>`).join('');
  function render(){
   const c=data.coverage||{};
   output.innerHTML=`<p>Last 24 hours: ${esc(c.events??0)} source events; ${esc(c.requested??0)} recorder requests; ${esc(c.observed??0)} linked observations. Missing coverage stays visible.</p>
    <details><summary>Import a Closed Positions receipt</summary><p>Copy the exact trade from TradeLocker. Enter signed charges: −0.06 for a charge; +0.06 for a credit. A blank is unknown. The opening and all closing fills must already be matched in the broker history.</p>
     <p>${(data.candidates||[]).map((r,i)=>`<button class="btn" type="button" data-e8="candidate" data-index="${i}">Use matched IDs: ${esc(r.position_id)} · gross ${money(r.fill_gross)}</button>`).join(' ')}</p>
     <label>Optional: paste column headers and one history row<textarea class="input" data-paste rows="3" style="display:block;width:100%;box-sizing:border-box"></textarea></label><button class="btn" type="button" data-e8="paste">Fill recognised fields for review</button>
     <form data-receipt><label>Saved account<select class="input" name="account_id" required>${accountOptions()}</select></label>
      ${input('positionId','Broker position ID')}${input('openingOrderId','Opening order ID')}${input('closingOrderIds','All closing order IDs, separated by commas')}
      ${input('quantity','Total closed lots','number')}${input('gross','Broker gross P&L (USD)','number')}${input('net','Broker net P&L (USD)','number')}
      ${input('fee','Signed total fee (USD)','number')}<label>Does that fee already include commission?<select name="feeIncludesCommission" class="input" required><option value="">Choose from the receipt definition</option><option value="true">Yes, commission is included</option><option value="false">No, commission is separate</option></select></label>
      ${input('commission','Separate signed commission (required if not included)','number',true)}${input('swap','Signed swap (enter 0 only if explicitly shown)','number')}
      ${input('evidenceNote','Receipt source / date (10–500 characters)')}
      <label><input type="checkbox" name="reviewed" required> I checked the exact account, position, all exit quantities and costs against its history row.</label><p><button type="submit">Match and save reviewed receipt</button></p>
     </form><p>A reviewed manual receipt is labelled as owner supplied. It does not automatically certify 95% accuracy.</p></details>
    <details><summary>Recent position receipts · ${(data.receipts||[]).length}</summary>${(data.receipts||[]).map(r=>`<p><b>${esc(r.position_id)}</b> · gross ${money(r.gross)} · net ${money(r.net)} · ${esc(r.basis)}${r.conflict?' · CONFLICT: review revisions':''} · ${esc(uk(r.created_at))}</p>`).join('')||'<p>No reviewed receipts yet.</p>'}</details>
    <details><summary>Dispatch timing and quote comparisons · ${(data.dispatches||[]).length}</summary>${(data.dispatches||[]).map(r=>`<p><b>${esc(String(r.source_trade_id).slice(0,8))} · ${esc(r.event)} ${esc(r.side)}</b> · ${esc(uk(r.sent_at))}<br>Request → acknowledgement: ${ms(r.ack_ms)}; receipt lookup: ${ms(r.receipt_lookup_ms)}.<br>Pre-send quote received age: ${ms(r.received_age_ms)}; provider quote age: ${ms(r.provider_age_ms)}; quote-to-fill price difference: ${finite(r.quote_shortfall)?esc(Number(r.quote_shortfall).toFixed(5)):'Unknown'}${r.fill_confirmed?'':' · fill not confirmed'}.</p>`).join('')||'<p>No new dispatch evidence yet. Older timings are not reconstructed.</p>'}<p>Acknowledgement and history arrival are not exact venue fill time. A quote is not guaranteed available liquidity.</p></details>
    <details><summary>Event-time price coverage</summary>${(data.event_quotes||[]).map(r=>`<p>${esc(r.symbol)} · ${esc(r.kind)} · ${esc(uk(r.event_at))} · observation received ${ms(r.sampling_wait_ms)} after event · ${r.decision_quote_id?'pre-event observation recorded':'no recent pre-event benchmark'}.</p>`).join('')||'<p>No new event observations yet.</p>'}</details>
    <details><summary>Compare A and reverse B on the same E8 quotes</summary><p>Uses the recorded source exit schedule and observations received before each event. Destination stop/TP execution and pending-trigger ordering remain unproven.</p><form data-pair><select name="account_id" class="input" required>${accountOptions()}</select>${input('trade_id','Full IPFX source trade ID')}${input('signed_costs_a','Estimated signed total costs for A (leave blank if unknown)','number',true)}${input('signed_costs_b','Estimated signed total costs for reverse B (leave blank if unknown)','number',true)}<button type="submit">Calculate paired paper results</button></form><pre data-pair-result style="white-space:pre-wrap"></pre></details>
    <details><summary>Check an isolated trade against account balance</summary><p>Select snapshots from before entry and after full closure. Overlapping trades, rollover, unknown adjustments or unsettled charges prevent exact allocation.</p><form data-balance><select name="account_id" class="input" required>${accountOptions()}</select>
     ${input('before_id','Before snapshot ID','number')}${input('after_id','After snapshot ID','number')}${input('gross','Gross from matched broker fills (USD)','number')}${input('signed_adjustments','Signed non-trade adjustments (explicit 0 if none)','number')}
     ${[['confirm_no_other_activity','No other trades, pending fills or account adjustments'],['confirm_postings_settled','All broker postings have settled'],['confirm_same_broker_day','The interval stays within the same broker accounting day'],['confirm_history_complete','The history includes the whole position and all exits']].map(([k,v])=>`<label style="display:block;margin:8px 0"><input name="${k}" type="checkbox" required> ${v}</label>`).join('')}<label style="display:block;margin:8px 0"><input name="confirm_usd_statement" type="checkbox"> If snapshot currency is unknown, I checked the account statement and confirm these amounts are USD.</label><button type="submit">Check interval</button></form><pre data-balance-result style="white-space:pre-wrap"></pre><p>${(data.snapshots||[]).map(r=>`Snapshot ${esc(r.id)} · saved account ${esc(r.account_id)} · ${esc(uk(r.received_at))} · balance ${money(r.amounts?.balance)} · ${esc(r.currency||'currency unknown')}`).join('<br>')}</p></details>`;
  }
  async function load(){if(loading)return;loading=true;status.textContent='Loading evidence…';try{const r=await call('evidence_overview');data=r.evidence;render();status.textContent='Evidence updated. Broker execution unchanged.';}catch(e){status.textContent=e.message;}finally{loading=false;}}
  host.addEventListener('click',e=>{const b=e.target.closest('[data-e8]');if(!b)return;if(b.dataset.e8==='refresh')void load();if(b.dataset.e8==='candidate'){
   const r=(data.candidates||[])[Number(b.dataset.index)],form=host.querySelector('[data-receipt]');if(!r)return;
   for(const [key,value]of Object.entries({account_id:r.account_id,positionId:r.position_id,openingOrderId:r.opening_order_id,closingOrderIds:(r.closing_order_ids||[]).join(', '),quantity:r.quantity,gross:r.fill_gross}))if(value!=null)form.elements[key].value=String(value);
   status.textContent='Matched IDs and fill-derived gross loaded. Review the receipt net and signed costs.';
  }if(b.dataset.e8==='paste'){
   try{const parsed=parseRow(host.querySelector('[data-paste]').value),form=host.querySelector('[data-receipt]');for(const [k,v]of Object.entries(parsed))if(v!=null&&form.elements[k])form.elements[k].value=v;status.textContent='Review every populated field, IDs and fee definition before saving.';}catch(error){status.textContent=error.message;}
  }});
  host.addEventListener('submit',async e=>{const form=e.target;if(!form.matches('[data-receipt],[data-pair],[data-balance]'))return;e.preventDefault();if(loading)return;loading=true;const b=form.querySelector('[type="submit"]');if(b)b.disabled=true;status.textContent='Checking evidence…';
   const f=Object.fromEntries(new FormData(form)),id=Number(f.account_id),account=(data.accounts||[]).find(a=>Number(a.id)===id),num=k=>f[k]===''||f[k]===undefined?null:Number(f[k]);
   try{if(form.matches('[data-receipt]')){await call('import_receipt',{account_id:id,confirm_reviewed:f.reviewed==='on',receipt:{brokerAccountId:String(account?.account_id??''),positionId:f.positionId,openingOrderId:f.openingOrderId,closingOrderIds:String(f.closingOrderIds).split(',').map(s=>s.trim()).filter(Boolean),quantity:num('quantity'),gross:num('gross'),net:num('net'),fee:num('fee'),swap:num('swap'),commission:num('commission'),feeIncludesCommission:f.feeIncludesCommission==='true',evidenceNote:f.evidenceNote}});status.textContent='Reviewed receipt saved; source trading results and execution are unchanged.';}
    else if(form.matches('[data-pair]')){const r=await call('paired_projection',{account_id:id,trade_id:f.trade_id,signed_costs_a:num('signed_costs_a'),signed_costs_b:num('signed_costs_b')});const x=r.result;form.parentElement.querySelector('[data-pair-result]').textContent=x.available?`A paper gross: ${money(x.grossA)}; estimated net: ${money(x.netA)}.\nReverse B paper gross: ${money(x.grossB)}; estimated net: ${money(x.netB)}.\nBoth spreads are included. These are hypothetical outcomes, not broker fills.`:'Cannot calculate reliably: '+String(x.reason||'missing evidence').toLowerCase().replace(/_/g,' ')+'.';status.textContent='Paper comparison archived. No broker trades placed.';}
    else {const r=await call('balance_check',{account_id:id,before_id:num('before_id'),after_id:num('after_id'),gross:num('gross'),signed_adjustments:num('signed_adjustments'),confirm_no_other_activity:f.confirm_no_other_activity==='on',confirm_postings_settled:f.confirm_postings_settled==='on',confirm_same_broker_day:f.confirm_same_broker_day==='on',confirm_history_complete:f.confirm_history_complete==='on',confirm_usd_statement:f.confirm_usd_statement==='on'});form.parentElement.querySelector('[data-balance-result]').textContent=r.result.net===null?'Cannot allocate this interval safely. Check currency, snapshots, other activity and settlement.':`Balance-reconciled net: ${money(r.result.net)}.\nCombined gross-to-net cost difference: ${money(r.result.combinedCost)}.\nThis interval check relies on your confirmations and is separate from a position receipt.`;status.textContent='Interval check archived; this does not authenticate a per-position receipt.';}
   }catch(error){status.textContent=error.message;}finally{loading=false;if(b)b.disabled=false;}
  });
  void load();
 }
 window.IPFXE8Evidence={init,parseRow};
})();
