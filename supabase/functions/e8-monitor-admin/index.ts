// Owner/MFA controls for read-only reference sampling. Never accepts broker passwords or places orders.
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2';
import {allowRequest,readJsonObject} from '../_shared/request-guards.ts';
import {finiteNumber,replayReference,type ReplayRequest} from '../_shared/e8-reference.ts';
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
  const [summary,accounts]=await Promise.all([db.rpc('e8_reference_summary'),db.from('ladder_accounts').select('id,label,platform,api_env,account_id,server,instrument_map').eq('role','monitor').eq('execution_enabled',false)]);
  if(summary.error||accounts.error)return json({ok:false,error:'Reference monitor unavailable'},503);
  return json({ok:true,summary:summary.data,accounts:accounts.data});
 }
 const id=Number(body.account_id);if(!Number.isSafeInteger(id)||id<1)return json({ok:false,error:'Choose an E8 monitor account'},400);
 const {data:a,error:ae}=await db.from('ladder_accounts').select('role,platform,execution_enabled,server,api_env,instrument_map').eq('id',id).maybeSingle();
 if(ae||!a||a.role!=='monitor'||a.execution_enabled||a.platform!=='tradelocker')return json({ok:false,error:'Only a read-only TradeLocker monitor can be configured'},409);
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
