// Owner/MFA controls for read-only reference sampling. Never accepts broker passwords or places orders.
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2';
import {allowRequest,readJsonObject} from '../_shared/request-guards.ts';
import {finiteNumber,replayReference,type ReplayRequest} from '../_shared/e8-reference.ts';
import {receiptCosts,isolatedBalance,pairedPaper,type QuoteEvidence,type PaperEvent} from '../_shared/e8-evidence.ts';
const ORIGINS=new Set(['https://ipfxcapital.com','https://www.ipfxcapital.com','http://localhost:3000','http://localhost:8127']);
function aal(token:string){try{const p=token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');return JSON.parse(atob(p+'='.repeat((4-p.length%4)%4))).aal;}catch{return null;}}
Deno.serve(async req=>{
 const origin=req.headers.get('origin')||'https://ipfxcapital.com';
 const headers={'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':ORIGINS.has(origin)?origin:'https://ipfxcapital.com',
  'Access-Control-Allow-Headers':'authorization,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS','Vary':'Origin'};
 const json=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers});
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST'||!ORIGINS.has(origin))return json({ok:false,error:'Not allowed'},403);
 const authorization=req.headers.get('authorization')??'';
 const auth=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:authorization}}});
 const {data:{user},error:authError}=await auth.auth.getUser();
 if(authError||!user||aal(authorization.replace(/^Bearer\s+/i,''))!=='aal2')return json({ok:false,error:'Owner MFA session required'},401);
 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
 const {data:admin,error:adminError}=await db.from('admins').select('user_id').eq('user_id',user.id).maybeSingle();
 if(adminError||!admin||String(user.email).toLowerCase()!==String(Deno.env.get('IPFX_OWNER_EMAIL')||'paulade491@gmail.com').toLowerCase())return json({ok:false,error:'Owner access only'},403);
 try{if(!await allowRequest(db,'e8-monitor-admin',user.id,60,60))return json({ok:false,error:'Too many requests'},429);}catch{return json({ok:false,error:'Request protection unavailable'},503);}
 const body=await readJsonObject(req,8192).catch(()=>null);if(!body)return json({ok:false,error:'Invalid request'},400);
 if(body.action==='overview'){
  const [summary,accounts,simulation]=await Promise.all([db.rpc('e8_reference_summary'),db.from('ladder_accounts').select('id,label,platform,api_env,account_id,server,instrument_map').eq('role','monitor').eq('execution_enabled',false),db.rpc('e8_sim_summary')]);
  if(summary.error||accounts.error||simulation.error)return json({ok:false,error:'Reference monitor unavailable'},503);
  return json({ok:true,summary:summary.data,accounts:accounts.data,simulation:simulation.data});
 }
 if(body.action==='evidence_overview'){
  const {data,error}=await db.rpc('e8_evidence_overview');
  return error?json({ok:false,error:'Execution evidence is not available yet'},503):json({ok:true,evidence:data});
 }
 const id=Number(body.account_id);if(!Number.isSafeInteger(id)||id<1)return json({ok:false,error:'Choose an E8 monitor account'},400);
 const {data:a,error:ae}=await db.from('ladder_accounts').select('role,platform,execution_enabled,server,api_env,instrument_map').eq('id',id).maybeSingle();
 if(ae||!a||a.platform!=='tradelocker')return json({ok:false,error:'Choose an existing TradeLocker account'},409);
 if(body.action==='import_receipt'){
  const r=body.receipt as Record<string,unknown>|null;
  if(!r||body.confirm_reviewed!==true)return json({ok:false,error:'Review the exact account, position, quantities and signed costs first'},400);
  try{
   const costs=receiptCosts(r);
   const receipt={brokerAccountId:String(r.brokerAccountId??''),positionId:String(r.positionId??''),openingOrderId:String(r.openingOrderId??''),
    closingOrderIds:r.closingOrderIds,quantity:finiteNumber(r.quantity),gross:costs.gross,net:costs.net,fee:costs.fee,
    commission:costs.commission,swap:costs.swap,feeIncludesCommission:costs.feeIncludesCommission,evidenceNote:String(r.evidenceNote??'').slice(0,501)};
   const {data,error}=await db.rpc('e8_import_position_receipt',{p_account:id,p_actor:user.id,p_receipt:receipt});
   if(error)return json({ok:false,error:'Receipt was not imported: '+String(error.message??'Exact broker matching unavailable').slice(0,180)},409);
   return json({ok:true,receipt:data});
  }catch(e){return json({ok:false,error:(e as Error).message},400);}
 }
 if(body.action==='balance_check'){
  const ids=[body.before_id,body.after_id].map(Number);
  if(ids.some(x=>!Number.isSafeInteger(x)||x<1)||ids[0]===ids[1])return json({ok:false,error:'Choose two different account snapshots'},400);
  const {data:rows,error}=await db.from('e8_account_snapshots').select('id,account_id,received_at,amounts,currency').eq('account_id',id).in('id',ids);
  const before=rows?.find(x=>Number(x.id)===ids[0]),after=rows?.find(x=>Number(x.id)===ids[1]);
  if(error||!before||!after||Date.parse(after.received_at)<=Date.parse(before.received_at)||Date.parse(after.received_at)-Date.parse(before.received_at)>20*3600000)return json({ok:false,error:'Snapshot interval is missing, reversed or longer than 20 hours'},400);
  const {data:fills,error:fe}=await db.from('cost_fills').select('ref,qty,raw').eq('account_id',id).gt('filled_at',before.received_at).lte('filled_at',after.received_at).limit(1001);
  if(fe||fills?.length===1001)return json({ok:false,error:'Complete interval history unavailable'},409);
  const positions=new Set((fills??[]).map(f=>String(f.raw?.positionId??'')));
  const reportedCurrency=before.currency===after.currency?before.currency:null;
  const ownerConfirmedUsd=before.currency==null&&after.currency==null&&body.confirm_usd_statement===true;
  const result=isolatedBalance({before:finiteNumber(before.amounts.balance),after:finiteNumber(after.amounts.balance),gross:finiteNumber(body.gross),adjustments:finiteNumber(body.signed_adjustments),
   currency:reportedCurrency??(ownerConfirmedUsd?'USD':null),flatBefore:before.amounts.positionsCount===0&&before.amounts.ordersCount===0,
   flatAfter:after.amounts.positionsCount===0&&after.amounts.ordersCount===0,onePosition:positions.size===1&&!positions.has(''),
   noOtherActivity:body.confirm_no_other_activity===true,stableAfter:body.confirm_postings_settled===true,sameBrokerDay:body.confirm_same_broker_day===true,
   windowComplete:body.confirm_history_complete===true&&(fills?.length??0)>=2});
  const {error:log}=await db.from('admin_audit_log').insert({actor_id:user.id,action:'e8_balance_check',detail:{account_id:id,before_id:ids[0],after_id:ids[1],result,
   basis:'OWNER_ATTESTED_INTERVAL_CHECK_NOT_AUTHENTICATED_POSITION_RECEIPT',currency_basis:ownerConfirmedUsd?'OWNER_CONFIRMED_USD_STATEMENT':'BROKER_REPORTED_OR_UNKNOWN'}});
  if(log)return json({ok:false,error:'Could not archive reconciliation'},503);
  return json({ok:true,result:{...result,currencyBasis:ownerConfirmedUsd?'OWNER_CONFIRMED_USD_STATEMENT':'BROKER_REPORTED_OR_UNKNOWN'}});
 }
 if(a.role!=='monitor'||a.execution_enabled)return json({ok:false,error:'Only a read-only TradeLocker monitor can be configured'},409);
 if(body.action==='paired_projection'){
  if(!/^[0-9a-f-]{36}$/i.test(String(body.trade_id??'')))return json({ok:false,error:'Enter the source trade ID'},400);
  const {data:p,error:pe}=await db.from('e8_sim_positions').select('*').eq('trade_id',body.trade_id).eq('reference_account_id',id).maybeSingle();
  if(pe||!p)return json({ok:false,error:'Trade has no matching recorded E8 reference account'},409);
  const {data:events,error:ee}=await db.from('e8_sim_events').select('kind,event_at,lots').eq('trade_id',p.trade_id).in('kind',['open','partial','close']).order('event_at').limit(101);
  if(ee||!events||events.length<2||events.length>100||events.at(-1)?.kind!=='close')return json({ok:false,error:'Complete opening and exits are required'},409);
  const start=Date.parse(events[0].event_at),end=Date.parse(events.at(-1)!.event_at);
  const {data:spec,error:se}=await db.from('e8_instrument_evidence').select('instrument_id,lot_size,quote_currency').eq('account_id',id).eq('symbol',p.symbol).lte('observed_at',events[0].event_at).order('observed_at',{ascending:false}).limit(1).maybeSingle();
  if(se||!spec||spec.quote_currency!=='USD'||!(Number(spec.lot_size)>0))return json({ok:false,error:'Pre-entry USD broker contract evidence is required'},409);
  const {data:qs,error:qe}=await db.from('e8_reference_quotes').select('bid,ask,requested_at,received_at,broker_quote_at,instrument_id,route_id')
   .eq('account_id',id).eq('symbol',p.symbol).gte('received_at',new Date(start-1000).toISOString()).lte('received_at',new Date(end).toISOString()).order('received_at').limit(10001);
  if(qe||qs?.length===10001)return json({ok:false,error:'Quote interval is unavailable or too large'},409);
  const observations:QuoteEvidence[]=(qs??[]).filter(q=>String(q.instrument_id)===String(spec.instrument_id)).map(q=>({bid:Number(q.bid),ask:Number(q.ask),requestedAt:Date.parse(q.requested_at),receivedAt:Date.parse(q.received_at),
   providerAt:q.broker_quote_at?Date.parse(q.broker_quote_at):null,accountId:String(id),instrumentId:String(spec.instrument_id),routeId:Number(q.route_id)}));
  const samples:PaperEvent[]=events.map(e=>({at:Date.parse(e.event_at),kind:e.kind,lots:Number(e.lots),quote:observations.filter(q=>q.receivedAt<=Date.parse(e.event_at)).at(-1)??null}));
  const result=pairedPaper(samples,{accountId:String(id),instrumentId:String(spec.instrument_id),side:p.trader_side,scale:Number(spec.lot_size),signedCostsA:finiteNumber(body.signed_costs_a),signedCostsB:finiteNumber(body.signed_costs_b),maxReceiveAgeMs:1000});
  const {error:save}=await db.from('e8_reference_projections').insert({id:crypto.randomUUID(),account_id:id,actor_id:user.id,assumptions:{trade_id:p.trade_id,mode:'PAIRED_PRE_EVENT_OBSERVATIONS',signed_costs_a:finiteNumber(body.signed_costs_a),signed_costs_b:finiteNumber(body.signed_costs_b),lifecycle_scope:'SOURCE_EXIT_SCHEDULE_ONLY_DESTINATION_STOPS_AND_PENDING_TRIGGER_PATH_NOT_PROVEN'},result});
  if(save)return json({ok:false,error:'Could not archive paired estimate'},503);return json({ok:true,result});
 }
 if(body.action==='project'){
  const raw=body.replay as Record<string,unknown>|null;
  if(!raw||!Array.isArray(raw.closes)||raw.closes.length>50)return json({ok:false,error:'Enter the trade and each close'},400);
  const fields=['lots','openedAt','scaleUSD','feesUSD','adverseBps','minDelayMs','maxWaitMs'];
  if(fields.some(f=>finiteNumber(raw[f])==null)||raw.closes.some(c=>!c||finiteNumber(c.at)==null||finiteNumber(c.lots)==null))return json({ok:false,error:'Every cost, size and delay assumption is required; unknown is not zero'},400);
  const replay={...raw,accountId:id} as ReplayRequest;
  if(!/^[A-Z0-9]{2,20}$/.test(String(replay.symbol))||String(replay.assumptionSource??'').length>500||
   !Number.isSafeInteger(replay.openedAt)||replay.openedAt<Date.now()-7*86400000||replay.openedAt>Date.now())return json({ok:false,error:'Choose a supported symbol and an opening time within the retained seven days'},400);
  const end=Math.max(...replay.closes.map(c=>c.at))+Number(replay.minDelayMs)+Number(replay.maxWaitMs);
  if(!Number.isFinite(end)||end>8640000000000000)return json({ok:false,error:'Invalid close time'},400);
  const {data:quotes,error:qe}=await db.from('e8_reference_quotes').select('bid,ask,received_at,requested_at,account_id,symbol').eq('account_id',id).eq('symbol',replay.symbol)
   .gte('requested_at',new Date(replay.openedAt).toISOString()).lte('received_at',new Date(end).toISOString()).order('received_at').limit(10000);
  if(qe)return json({ok:false,error:'Reference prices unavailable'},503);
  if(quotes?.length===10000)return json({ok:false,error:'Too many reference samples; compare a shorter trade'},400);
  const result=replayReference(replay,(quotes??[]).map(q=>({bid:Number(q.bid),ask:Number(q.ask),startedAt:Date.parse(q.requested_at),receivedAt:Date.parse(q.received_at),accountId:Number(q.account_id),symbol:q.symbol})));
  const {error:save}=await db.from('e8_reference_projections').insert({id:crypto.randomUUID(),account_id:id,actor_id:user.id,assumptions:replay,result});
  if(save)return json({ok:false,error:'Estimate archive unavailable'},503);
  return json({ok:true,result});
 }
 if(body.action==='configure'){
  const symbols=body.symbols,interval=Number(body.interval_ms??10000),maxAge=Number(body.max_quote_age_ms??15000);
  if(!Array.isArray(symbols)||!symbols.length||symbols.length>12||symbols.some(s=>typeof s!=='string'||!/^[A-Z0-9]{2,20}$/.test(s))||
   !Number.isInteger(interval)||interval<1000||interval>60000||!Number.isInteger(maxAge)||maxAge<1000||maxAge>60000||typeof body.enabled!=='boolean')return json({ok:false,error:'Choose supported symbols, sampling interval and start/pause'},400);
  const {error:log}=await db.from('admin_audit_log').insert({actor_id:user.id,action:'e8_reference_configure_intent',detail:{account_id:id,enabled:body.enabled,symbols,interval_ms:interval}});
  if(log)return json({ok:false,error:'Audit unavailable; settings were not changed'},503);
  const {error}=await db.from('e8_monitor_profiles').upsert({account_id:id,enabled:body.enabled,symbols:[...new Set(symbols)],interval_ms:interval,max_quote_age_ms:maxAge,
   scope:'e8:'+a.api_env+':'+String(a.server).slice(0,120),lease:null,lease_until:null,next_run:new Date().toISOString(),status:body.enabled?'AWAITING_FIRST_SAMPLE':'PAUSED',error_code:null,updated_at:new Date().toISOString()});
  if(error)return json({ok:false,error:'Could not save reference settings'},503);
  return json({ok:true});
 }
 if(body.action==='sample'){
  const {error}=await db.rpc('kick_e8_reference');if(error)return json({ok:false,error:'Sampling unavailable'},503);
  return json({ok:true,status:'QUEUED'});
 }
 return json({ok:false,error:'Unknown action'},400);
});
