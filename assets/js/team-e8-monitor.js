(() => {
 'use strict';
 const URL='https://agulweemteoeagscmppy.supabase.co';
 const PUBLIC_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndWx3ZWVtdGVvZWFnc2NtcHB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MzU0ODIsImV4cCI6MjA4MTQxMTQ4Mn0.I70jN5DCuCn8OtISqvTRzuzGFaYd2pV8vviEED6gFlQ';
 const sb=window.supabase.createClient(URL,PUBLIC_KEY),$=id=>document.getElementById(id);
 const esc=x=>String(x??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let busy=false,latest=null,overviewAt=0;
 function refreshQuoteAge(){if(!latest)return;
  $('quotes').innerHTML=(latest.summary?.quotes||[]).map(q=>{
   const age=Number(q.age_ms)+Math.max(0,Date.now()-overviewAt);
   const fresh=q.fresh&&Number.isFinite(age)&&age<=Number(q.max_quote_age_ms??15000);
   return '<tr><td>'+esc(q.account_id)+' / '+esc(q.symbol)+'</td><td>'+esc(q.bid)+'</td><td>'+esc(q.ask)+'</td><td>'+esc(q.spread)+'</td><td>'+esc(new Date(q.received_at).toLocaleTimeString('en-GB'))+'</td><td class="'+(fresh?'good':'bad')+'">'+(fresh?'Recent API reply':'Old API reply')+' · '+(Number.isFinite(age)?Math.round(age/1000)+'s old':'age unavailable')+'</td></tr>';
  }).join('')||'<tr><td colspan="6">No reference quotes yet.</td></tr>';
 }
 async function call(fn,body){const{data:{session}}=await sb.auth.getSession();if(!session){location.replace('team-login.html?next='+encodeURIComponent('/team-e8-monitor.html'));throw Error('Sign in with owner MFA');}
  const r=await fetch(URL+'/functions/v1/'+fn,{method:'POST',cache:'no-store',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.access_token},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>null);if(!r.ok||!j?.ok)throw Error(j?.error||'Read-only setup unavailable');return j;}
 async function load(){if(busy)return;busy=true;try{latest=await call('e8-monitor-admin',{action:'overview'});overviewAt=Date.now();
  const selected=$('monitorAccount').value;const accounts=latest.accounts||[];
  $('monitorAccount').innerHTML=accounts.map(a=>'<option value="'+a.id+'"'+(String(a.id)===selected?' selected':'')+'>'+esc(a.label)+' #'+esc(a.account_id)+'</option>').join('');
  const profiles=latest.summary?.accounts||[];
  $('health').innerHTML=profiles.length?profiles.map(p=>'<p><b>'+esc(p.label)+'</b> · '+esc(p.status)+' · '+(p.enabled?'sampling on':'paused')+
   (p.error_code?' · <span class="bad">'+esc(p.error_code)+'</span>':'')+(p.history_error_code?' · history: '+esc(p.history_error_code):'')+
   '<br><small>Last quote: '+esc(p.last_quote_at?new Date(p.last_quote_at).toLocaleString('en-GB'):'not received')+' · last history: '+esc(p.last_history_at?new Date(p.last_history_at).toLocaleString('en-GB'):'not received')+'</small></p>').join(''):'Connect the E8 account, then start sampling.';
  refreshQuoteAge();
  $('history').textContent=(latest.summary?.fills||0)+' broker fills retained · '+(latest.summary?.fee_complete_fills||0)+' have all commission/fee/swap fields · '+(latest.summary?.revisions||0)+' archived revisions. Missing fees are unknown.';
  const sim=latest.simulation;
  $('simulationStatus').textContent=sim?sim.positions+' positions · '+sim.events+' lifecycle events archived · refresh every 10 seconds.':'Automatic archive unavailable.';
  $('simulationTrades').innerHTML=(sim?.recent||[]).map(t=>{
   const reverse=t.selected_book==='b',side=reverse?(t.trader_side==='buy'?'sell':'buy'):t.trader_side;
   const gross=t.selected_gross_usd==null?'Unavailable':'$'+Number(t.selected_gross_usd).toFixed(2);
   const decision=t.decision_gross_usd==null?'Unavailable':'$'+Number(t.decision_gross_usd).toFixed(2);
   return '<tr><td>'+esc(t.trade_id.slice(0,8))+' / '+esc(t.symbol)+(t.is_practice?' · practice':'')+'</td><td>'+esc(t.trader_side)+' → '+esc(side)+' ('+(reverse?'B':'A')+')</td><td>'+esc(t.exited_lots??0)+' / '+esc(t.original_lots)+'</td><td>'+esc(t.status.replaceAll('_',' '))+'</td><td>'+esc(gross)+'</td><td>'+esc(decision)+'<br><small>'+esc((t.decision_status||'Decision quote unavailable').replaceAll('_',' '))+'</small></td><td>Unverified</td></tr>';
  }).join('')||'<tr><td colspan="7">No new tracked trades yet.</td></tr>';
  $('pendingStatus').textContent=sim?.pending_active==null?'Pending archive unavailable.':sim.pending_active+' resting orders · '+sim.pending_unconfirmed+' fills awaiting a source trade link';
  $('pendingOrders').innerHTML=(sim?.pending_recent||[]).map(p=>{
   const o=p.snapshot||{};
   return '<tr><td>'+esc(p.order_id.slice(0,8))+' / '+esc(o.symbol)+'</td><td>'+esc(o.side)+' '+esc(o.order_type)+'</td><td>'+esc(o.volume)+' @ '+esc(o.trigger_price)+'</td><td>'+esc(p.status)+'<br><small>'+esc(p.tracking_status.replaceAll('_',' '))+'</small></td><td>'+esc(o.filled_trade_id?.slice(0,8)||o.reject_reason||'—')+'</td></tr>';
  }).join('')||'<tr><td colspan="5">No observed pending orders yet.</td></tr>';
  $('status').textContent='Owner-only · read-only E8 · updated '+new Date().toLocaleTimeString('en-GB');
 }catch(e){refreshQuoteAge();$('status').textContent=e.name==='TimeoutError'?'Monitor request timed out — showing the last received data.':e.message;}finally{busy=false;}}
 $('connect').addEventListener('submit',async e=>{e.preventDefault();$('connectBtn').disabled=true;try{
  const result=await call('ladder-admin',{action:'ladder_add',role:'monitor',label:$('label').value,size_usd:Number($('size').value),fee_usd:0,signal_group:0,
   email:$('email').value,password:$('password').value,server:$('server').value,account_id:$('account').value});
  $('password').value='';await load();if(result.id)$('monitorAccount').value=String(result.id);
 }catch(err){$('status').textContent=err.message;}finally{$('password').value='';$('connectBtn').disabled=false;}});
 async function configure(enabled){const id=Number($('monitorAccount').value);if(!id)throw Error('Connect and choose the E8 account first');
  const symbols=$('symbols').value.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
  await call('e8-monitor-admin',{action:'configure',account_id:id,symbols,interval_ms:Number($('interval').value),max_quote_age_ms:15000,enabled});await load();}
 $('settings').addEventListener('submit',async e=>{e.preventDefault();try{await configure(true);}catch(err){$('status').textContent=err.message;}});
 $('pause').addEventListener('click',async()=>{try{await configure(false);}catch(err){$('status').textContent=err.message;}});
 $('addClose').addEventListener('click',()=>{if($('closeRows').children.length>=50)return;const row=$('closeRows').firstElementChild.cloneNode(true);row.querySelectorAll('input').forEach(i=>i.value='');$('closeRows').appendChild(row);});
 $('projection').addEventListener('submit',async e=>{e.preventDefault();$('projectBtn').disabled=true;try{
  const number=id=>$(id).value.trim()===''?null:Number($(id).value);
  const replay={symbol:$('projectSymbol').value.trim().toUpperCase(),traderSide:$('traderSide').value,book:$('projectBook').value,
   lots:number('projectLots'),openedAt:new Date($('openedAt').value).getTime(),scaleUSD:number('scaleUSD'),feesUSD:number('feesUSD'),
   adverseBps:number('adverseBps'),minDelayMs:number('minDelayMs'),maxWaitMs:15000,assumptionSource:$('assumptionSource').value,
   closes:[...$('closeRows').querySelectorAll('.close-row')].map(r=>({at:new Date(r.querySelector('[data-close-time]').value).getTime(),lots:Number(r.querySelector('[data-close-lots]').value)}))};
  const {result}=await call('e8-monitor-admin',{action:'project',account_id:Number($('monitorAccount').value),replay});
  $('projectResult').innerHTML=result.available?'<p><b>Estimated net: $'+esc(result.netUSD.toFixed(2))+'</b> · gross $'+esc(result.grossUSD.toFixed(2))+' · assumed total fees $'+esc(result.feesUSD.toFixed(2))+'</p><p>Entry observation arrived '+esc(result.entrySamplingWaitMs)+'ms after opening; exit waits: '+esc(result.slices.map(s=>s.samplingWaitMs+'ms').join(', '))+'. These are sampled estimates, not actual E8 fills.</p>':'<p class="bad">Estimate unavailable: '+esc(result.reason)+'. No zero-profit result was invented.</p>';
 }catch(err){$('projectResult').textContent=err.message;}finally{$('projectBtn').disabled=false;}});
 $('refresh').addEventListener('click',load);setInterval(refreshQuoteAge,1000);setInterval(()=>{if(!document.hidden)load();},10000);load();
})();
