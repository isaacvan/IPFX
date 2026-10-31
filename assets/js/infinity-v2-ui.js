/* Desktop Infinity version controls. All live thresholds come from the server's saved rules. */
(() => {
 'use strict';
 const $=id=>document.getElementById(id);
 const account=()=>typeof engineState==='undefined'?null:engineState?.account;
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let status=null,lastQuote=null,requestId=null,busy=false,lastAccountKey='';const widths=new Map();
 const minLot=(requestedSymbol)=>{const a=account();if(a?.rules_version!=='infinity_v2')return .01;
  const symbol=String(requestedSymbol || (typeof activeSym==='string'?activeSym:'')).replace(/^[^:]+:/,'');
  return Number(a.v2_pricing_profiles?.find(x=>x.symbol===symbol)?.min_lot||.01);};
 const fmt=(n,d=2)=>Number(n||0).toFixed(d);
 // Overall consistency score: every counted trade in this Infinity v2 run, across stages (server: run_score / run_n).
 const overall=p=>({n:Number(p?.run_n??p?.n??0),score:Number(p?.run_score??p?.combined_score??p?.score??0)});
 const needed=r=>r?.combined_score??r?.stage_score??null;
 const needTxt=v=>Number.isInteger(Number(v))?Number(v).toFixed(1):String(v);
 const seenScore=new Map();
 function overallHtml(p,a){const o=overall(p),need=needed(p?.rules);
  if(p?.scoring_pending&&!o.n)return '<span class="iv2-ov-k">Overall consistency score</span><span class="iv2-ov-v">updating…</span>';
  const ok=need!=null&&o.score>=need;
  return '<span class="iv2-ov-k">Overall consistency score</span><span class="iv2-ov-v '+(ok?'ok':'')+'">'+(o.n?fmt(o.score):'—')+'</span>'+
   '<span class="iv2-ov-s">'+o.n+' counted trade'+(o.n===1?'':'s')+' this run'+(need!=null?' · Stage '+a.stage+' needs '+needTxt(need):'')+(p?.scoring_pending?' · updating…':'')+'</span>';}
 function scoreToast(now,prev,a){let t=$('iv2ScoreToast');
  if(!t){t=document.createElement('div');t.id='iv2ScoreToast';t.setAttribute('role','status');t.setAttribute('aria-live','polite');document.body.appendChild(t);}
  const d=now.score-prev.score,need=needed(a.infinity_v2?.rules),arrow=d>0.005?'▲':d<-0.005?'▼':'■';
  t.innerHTML='<div class="iv2-t-h">Counted trade complete<button type="button" aria-label="Close">×</button></div>'+
   '<div class="iv2-t-v">'+fmt(now.score)+' <span class="'+(d>0.005?'up':d<-0.005?'down':'')+'">'+arrow+' '+(d>=0?'+':'')+fmt(d)+'</span></div>'+
   '<div class="iv2-t-s">Overall consistency score · '+now.n+' counted trades'+(need!=null?' · Stage '+a.stage+' needs '+needTxt(need):'')+'</div>';
  t.querySelector('button').onclick=()=>t.classList.remove('show');t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('show'),9000);}
 // After every refresh: when the run's counted trades go up (a counted trade closed and was scored), announce the new score.
 let rescoreTimer=null;
 function watchScore(){const a=account(),p=a?.infinity_v2;if(a?.rules_version!=='infinity_v2'||!p)return;
  // The score is recomputed within ~10 s of a close; fetch state again shortly instead of waiting for the next routine poll.
  if(p.scoring_pending){if(!rescoreTimer&&typeof engineCall==='function')rescoreTimer=setTimeout(()=>{rescoreTimer=null;engineCall({action:'state'}).catch(()=>{});},12000);return;}
  const now=overall(p),prev=seenScore.get(a.id);seenScore.set(a.id,now);if(prev&&now.n>prev.n)scoreToast(now,prev,a);}
 async function call(body){const token=await freshToken();if(!token)throw Error('Sign in again.');
  const response=await fetch(ENGINE_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok||result.ok===false)throw Error(result.error||'Request failed.');return result;}
 async function refreshStatus(){if(typeof hasSession!=='function'||!hasSession())return;
  try{status=(await call({action:'infinity_status'})).infinity;updateControls();}catch{}}
 function updateControls(){const a=account(),badge=$('iv2Badge'),button=$('iv2Switch');if(!badge||!button)return;
  badge.hidden=a?.challenge_type!=='infinity'||a.is_demo;badge.textContent=a?.rules_version==='infinity_v2'?'Infinity v2':'Infinity v1';
  button.hidden=!(status?.v2_enabled&&a?.rules_version==='infinity_v1'&&a.status==='active'&&!a.is_demo);
 }
 async function switchRun(){if(busy)return;const a=account();if(!a)return;
  if(engineState.open_trades?.length||engineState.pending_orders?.length){engineMsg('Close open positions and cancel pending orders before switching.');return;}
  const d=$('iv2SwitchDialog');d.querySelector('[data-terms]').checked=false;d.querySelector('[data-accept]').disabled=true;d.querySelector('[data-error]').textContent='';d.showModal();
 }
 async function confirmSwitch(){if(busy||!$('iv2SwitchDialog').querySelector('[data-terms]').checked)return;
  const a=account();requestId??=crypto.randomUUID();busy=true;
  try{await call({action:'switch_infinity_v2',account_id:a.id,rules_version:'infinity_v2',accept_terms:true,terms_version:status.v2_terms_version,request_id:requestId});
   $('iv2SwitchDialog').close();await engineCall({action:'state'});requestId=null;updateControls();
  }catch(e){$('iv2SwitchDialog').querySelector('[data-error]').textContent=e.message;}finally{busy=false;}
 }
 function render(){updateControls();const a=account();if(a?.rules_version!=='infinity_v2'){const ov=$('iv2Overall');if(ov)ov.hidden=true;return false;}
  const p=a.infinity_v2,r=p?.rules;if(!r)return false;
  const title=$('ch-title');if(!title)return false;
  title.textContent='Infinity v2 · Stage '+a.stage;
  $('ch-sub').textContent='Pass on your results. No minimum days, sessions or waiting period.';
  let ov=$('iv2Overall');if(!ov){ov=document.createElement('div');ov.id='iv2Overall';$('ch-sub').insertAdjacentElement('afterend',ov);}
  ov.hidden=false;ov.innerHTML=overallHtml(p,a);
  $('ch-verdict').textContent=p.integrity_hold?'Review required':p.eligible?'Requirements met':'In progress';
  $('ch-bars').innerHTML='';$('ch-restart').hidden=true;
  $('ch-reqs-rule').textContent='Meet all requirements at the same time, with no open positions or pending orders.';
  const lines=[];
  if(p.scoring_pending)lines.push([false,"Updating the score; advancement waits for the next scoring check."]);
  if(r.target_pct)lines.push([p.counted_profit>=p.target,'Counted profit $'+fmt(p.counted_profit)+' / $'+fmt(p.target)]);
  if(r.min_counted_trades)lines.push([p.n>=r.min_counted_trades,p.n+' / '+r.min_counted_trades+' counted trades this stage']);
  if(r.stage_score!=null)lines.push([p.score>=r.stage_score,'Stage score '+fmt(p.score,3)+' / '+r.stage_score]);
  if(r.combined_score!=null)lines.push([p.combined_score>=r.combined_score,'Combined score '+fmt(p.combined_score,3)+' / '+r.combined_score]);
  if(r.best_day_share!=null)lines.push([p.best_day_share!=null&&p.best_day_share<=r.best_day_share,'Best-day share '+(p.best_day_share==null?'—':fmt(p.best_day_share*100,1)+'%')+' / maximum '+fmt(r.best_day_share*100,0)+'%']);
  lines.push([!engineState.open_trades?.length&&!engineState.pending_orders?.length,'Flat: no open positions or pending orders']);
  if(p.integrity_hold)lines.push([false,'Account review required before advancement or payout']);
  if(p.identity_required)lines.push([false,'Verify your identity to move to Stage 3. Your account keeps trading meanwhile.']);
  $('ch-reqs').innerHTML=lines.map(([ok,text])=>'<div class="ch-req"><div class="ch-req-ic '+(ok?'done':'')+'">'+(ok?'✓':'○')+'</div><div class="ch-req-txt">'+esc(text)+'</div></div>').join('');
  $('ch-note').textContent='Same-instrument, same-direction entries overlap or join within '+r.group_gap_minutes+' minutes as one counted trade. Score uses opening-stop risk, capped at ±'+r.score_r_cap+'R. Winning trades held under '+r.min_hold_seconds/60+' minutes do not count toward targets or payouts; losses always count.';
  return true;
 }
 function tick(){updateControls();const a=account(),hint=$('iv2Ticket');if(!hint)return;hint.hidden=a?.rules_version!=='infinity_v2';if(hint.hidden)return;
  const pause=lastQuote?.pause_until?Math.max(0,Math.ceil((Date.parse(lastQuote.pause_until)-Date.now())/1000)):0;
  const rows=engineState.open_trades||[],hold=Number(a.infinity_v2?.rules?.min_hold_seconds||0);
  const timers=rows.map(t=>{const left=Math.max(0,Math.ceil(hold-(Date.now()-Date.parse(t.opened_at))/1000));return t.symbol+': '+(left?left+'s until profit counts':'hold met');});
  hint.textContent=(lastQuote?.min_stop_distance!=null?'Minimum stop distance: '+Number(lastQuote.min_stop_distance).toPrecision(4)+'. ':'')+'Stops can only be tightened. '+(pause?'This instrument resumes in '+pause+'s. ':'')+timers.join(' · ');
  const om=$('omHint');if(om&&typeof omMode!=='undefined'&&omMode==='modify')om.textContent='Tighten your stop only; it cannot be removed or widened. Minimum distance is eight current spreads.';
 }
 function styles(){if($('iv2ScoreCss'))return;const c=document.createElement('style');c.id='iv2ScoreCss';c.textContent=
  '#iv2Overall{display:flex;flex-wrap:wrap;align-items:baseline;gap:.35rem .6rem;margin:.55rem 0 .2rem;padding:.55rem .7rem;border:1px solid rgba(37,99,235,.45);border-radius:10px;background:rgba(37,99,235,.10)}'+
  '.iv2-ov-k{font-size:11px;font-weight:600;color:var(--muted,#9ca3af);letter-spacing:.02em}.iv2-ov-v{font-size:20px;font-weight:800;color:#93c5fd;font-variant-numeric:tabular-nums}.iv2-ov-v.ok{color:#34d399}'+
  '.iv2-ov-s{flex-basis:100%;font-size:11px;color:var(--muted,#9ca3af)}'+
  '#iv2ScoreToast{position:fixed;top:96px;left:18px;z-index:9999;min-width:260px;max-width:340px;padding:.7rem .85rem;border:1px solid rgba(37,99,235,.55);border-radius:12px;background:#111317;color:#e5e7eb;box-shadow:0 12px 30px rgba(0,0,0,.45);opacity:0;transform:translateY(-8px);pointer-events:none;transition:opacity .2s,transform .2s}'+
  '#iv2ScoreToast.show{opacity:1;transform:none;pointer-events:auto}.iv2-t-h{display:flex;justify-content:space-between;font-size:11px;font-weight:700;color:#93c5fd;text-transform:uppercase;letter-spacing:.04em}'+
  '.iv2-t-h button{background:none;border:0;color:inherit;font-size:16px;line-height:1;cursor:pointer}.iv2-t-v{font-size:24px;font-weight:800;margin:.15rem 0;font-variant-numeric:tabular-nums}'+
  '.iv2-t-v .up{color:#34d399;font-size:14px}.iv2-t-v .down{color:#f87171;font-size:14px}.iv2-t-s{font-size:12px;color:#9ca3af}'+
  'body.light #iv2Overall{background:rgba(37,99,235,.07)}body.light .iv2-ov-v{color:#1d4ed8}body.light .iv2-ov-v.ok{color:#047857}body.light #iv2ScoreToast{background:#fff;color:#111827}body.light .iv2-t-h{color:#1d4ed8}';
  document.head.appendChild(c);}
 function mount(){styles();const mode=document.querySelector('.acct-mode');if(!mode)return;
  const badge=document.createElement('span');badge.id='iv2Badge';badge.hidden=true;badge.style.cssText='font-size:11px;padding:3px 7px;color:#60a5fa';mode.insertAdjacentElement('afterend',badge);
  const button=document.createElement('button');button.id='iv2Switch';button.type='button';button.className='tb-restart';button.hidden=true;button.textContent='Switch to Infinity v2';button.onclick=switchRun;badge.insertAdjacentElement('afterend',button);
  const d=document.createElement('dialog');d.id='iv2SwitchDialog';d.className='rs-dlg';d.innerHTML='<div class="rs-hd"><h2>Switch to Infinity v2</h2><button type="button" class="rs-x" data-close aria-label="Close">×</button></div><div class="rs-bd"><p>This is permanent. Your current balance, loss floors, stage, strikes and held Stage 2 profit carry over. This stage’s v2 trade count and score start from switching.</p><p>Review the current <a href="/infinity-v2.html" target="_blank" rel="noopener">Infinity v2 rules</a> and published Terms before accepting.</p><label><input type="checkbox" data-terms> I accept the Infinity v2 rules and updated Terms.</label><p data-error role="alert"></p></div><div class="rs-ft"><button type="button" class="rs-btn" data-close>Cancel</button><button type="button" class="rs-btn pri" data-accept disabled>Agree and switch</button></div>';
  d.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>d.close());d.querySelector('[data-terms]').onchange=e=>{d.querySelector('[data-accept]').disabled=!e.target.checked;};d.querySelector('[data-accept]').onclick=confirmSwitch;document.body.appendChild(d);
  const hint=document.createElement('div');hint.id='iv2Ticket';hint.hidden=true;hint.className='ch-reqs-rule';$('ord-lots')?.closest('.order-panel')?.appendChild(hint);
  if(!hint.isConnected)$('ord-lots')?.parentElement?.parentElement?.appendChild(hint);
  window.addEventListener('ipfx-state',()=>{const a=account(),key=a?.id+':'+a?.rules_version;if(key!==lastAccountKey){lastAccountKey=key;refreshStatus();}updateControls();watchScore();});
  refreshStatus();setInterval(()=>{tick();},1000);setInterval(refreshStatus,60000);
 }
 window.ipfxInfinityV2={render,minLot,refresh:refreshStatus,pause:()=>lastQuote?.pause_until?Math.max(0,Math.ceil((Date.parse(lastQuote.pause_until)-Date.now())/1000)):0,price:p=>{const width=account()?.rules_version==='infinity_v2'?widths.get(p.s):null;if(!width)return p;const mid=Number.isFinite(p.m)?p.m:(p.a+p.b)/2;return {...p,b:mid-width/2,a:mid+width/2,sp:width};},quote:q=>{lastQuote=q;if(q?.symbol&&Number.isFinite(q.spread))widths.set(q.symbol,q.spread);tick();}};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();
