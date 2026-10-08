// Dedicated read-only reference worker. Observed E8 quotes are not executed simulator fills.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { readClient, type TlEnv } from "../_shared/tradelocker-read.ts";
import { decryptSecret, encryptSecret, jwtExpiresAt } from "../_shared/tradelocker-crypto.ts";
import { applicableRules, finiteNumber, measuredFill, referenceRules, type RateRule } from "../_shared/e8-reference.ts";
import { TL_SYMBOLS } from "../_shared/tradelocker-feed.ts";
// E8 names the stock indices differently from the HeroFX feed that IPFX prices come from (matched on the start of the name).
const E8_ALIASES: Record<string, string> = { DJI: "DOW", GER40: "DAX", JPN225: "NIKKEI", NSXUSD: "NSDQ", SPXUSD: "SP" };
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
const norm=(s:string)=>s.toUpperCase().replace(/[^A-Z0-9]/g,"");
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function equal(a:string,b:string){const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);let d=x.length^y.length;for(let i=0;i<Math.max(x.length,y.length);i++)d|=(x[i]??0)^(y[i]??0);return d===0;}
function stable(value:unknown):string{if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';return JSON.stringify(value);}
async function digest(value:unknown){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stable(value)))),x=>x.toString(16).padStart(2,'0')).join('');}
Deno.serve(async req=>{
 const secret=Deno.env.get('COST_MONITOR_SECRET')??'';
 if(req.method!=='POST'||secret.length<32||!equal(req.headers.get('x-cost-secret')??'',secret))return json({ok:false,error:'unauthorised'},401);
 const key=Deno.env.get('TRADELOCKER_TOKEN_ENCRYPTION_KEY');if(!key)return json({ok:false,error:'TOKEN_ENCRYPTION_UNAVAILABLE'},503);
 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
 const {data:p,error:claimError}=await db.rpc('e8_monitor_claim');
 if(claimError)return json({ok:false,error:'MONITOR_QUEUE_UNAVAILABLE'},503);
 if(!p)return json({ok:true,status:'IDLE'});
 const started=Date.now();let rules:RateRule[]=p.rate_rules??[],samples=0,fills=0,lastQuote:string|null=null,lastHistory:string|null=null;
 let config=p.broker_config,configAt=p.config_at,status='READY',errorCode:string|null=null,historyError:string|null=p.history_error_code;
 const finish=async()=>{
  const {data:saved,error}=await db.from('e8_monitor_profiles').update({lease:null,lease_until:null,last_run:new Date().toISOString(),
   last_quote_at:lastQuote??p.last_quote_at,last_history_at:lastHistory??p.last_history_at,broker_config:config,rate_rules:rules,
   config_at:configAt,status,error_code:errorCode,history_error_code:historyError,
   ...(errorCode?{next_run:new Date(Date.now()+60000).toISOString()}:{}),updated_at:new Date().toISOString()}).eq('account_id',p.account_id).eq('lease',p.lease).gt('lease_until',new Date().toISOString()).select('account_id');
  if(error||saved?.length!==1)throw Error('MONITOR_STATE_WRITE_FAILED');
 };
 try{
  const {data:a,error}=await db.from('ladder_accounts').select('*').eq('id',p.account_id).eq('role','monitor').eq('execution_enabled',false).eq('platform','tradelocker').maybeSingle();
  if(error||!a)throw Error('READ_ONLY_ACCOUNT_UNAVAILABLE');
  const before=async(path:string)=>{
   const route=path.includes('/quotes?')?'QUOTES':path.startsWith('/trade/instruments/')?'INSTRUMENT_DETAILS':path.endsWith('/ordersHistory')?'ORDERS_HISTORY':path.includes('/refresh')?'REFRESH':'CONFIG';
   let selected=applicableRules(rules,route);
   // Configuration/auth do not have route limits in the official SDK config. Pace bootstrap
   // reads conservatively; this is a local ceiling, never a claim of a provider entitlement.
   if(!selected.length&&(route==='CONFIG'||route==='REFRESH'))selected=[{type:route,limit:1,windowMs:60000}];
   if(!selected.length)throw Error('BROKER_RATE_SCHEMA_UNAVAILABLE');
   for(let attempt=0;attempt<2;attempt++){
    const {data:allow,error:e}=await db.rpc('e8_monitor_take',{p_scope:p.scope,p_route:route,p_rules:selected});
    if(e)throw Error('REQUEST_BUDGET_UNAVAILABLE');if(allow?.ok)return;
    const wait=Number(allow?.wait_ms??10000);if(attempt||!Number.isFinite(wait)||wait<0||Date.now()-started+wait>25000)throw Error('SAMPLING_DEFERRED_API_BUDGET');
    await delay(wait);
   }
  };
  const tl=readClient(a.api_env as TlEnv,before);let token=await decryptSecret(a.access_token_ciphertext,key);
  if(!a.access_expires_at||Date.parse(a.access_expires_at)-Date.now()<5*60000){
   const next=await tl.refresh(await decryptSecret(a.refresh_token_ciphertext,key));token=next.accessToken;
   const {error:e}=await db.from('ladder_accounts').update({access_token_ciphertext:await encryptSecret(next.accessToken,key),
    refresh_token_ciphertext:await encryptSecret(next.refreshToken,key),access_expires_at:jwtExpiresAt(next.accessToken),updated_at:new Date().toISOString()}).eq('id',a.id).eq('role','monitor');
   if(e)throw Error('REFRESH_TOKEN_SAVE_FAILED');
  }
  if(!config||!configAt||Date.now()-Date.parse(configAt)>15*60000){config=await tl.config(token,String(a.acc_num));rules=referenceRules(config);configAt=new Date().toISOString();}
  if(!applicableRules(rules,'QUOTES').length)throw Error('BROKER_RATE_SCHEMA_UNAVAILABLE');
  const map=(a.instrument_map??[]) as Array<Record<string,unknown>>;
  // The 5 main instruments every run (10 s) plus TWO of the slow list in rotation, so every other instrument is refreshed about every
  // 100 s. Deterministic from the clock (no stored state). Doing the whole slow list in one burst was refused by the broker (HTTP 429).
  const slow=(p.slow_symbols??[]) as string[];
  const slowPick=slow.length?[0,1].map(i=>slow[(Math.floor(started/10000)*2+i)%slow.length]).filter((x,i,a)=>a.indexOf(x)===i):[];
  const symbolsNow=[...(p.symbols as string[]),...slowPick];
  const {data:ipfx,error:ipfxError}=await db.from('live_quotes').select('symbol,bid,ask,received_at').in('symbol',symbolsNow);
  const ix=new Map((ipfxError?[]:ipfx??[]).map(q=>[q.symbol,q]));
  for(const symbol of symbolsNow){
   if(Date.now()-started>24000){status='PARTIAL_COVERAGE';break;}
   const target=norm(E8_ALIASES[symbol]??TL_SYMBOLS[symbol]??symbol),exact=map.filter(m=>norm(String(m.symbol))===target);
   const candidates=exact.length?exact:map.filter(m=>norm(String(m.symbol)).startsWith(target));
   if(candidates.length!==1||candidates[0].info_route_id==null){status='PARTIAL_COVERAGE';continue;}
   const inst=candidates[0],requested=new Date().toISOString();
   const quote=await tl.quote(token,String(a.acc_num),Number(inst.info_route_id),String(inst.tradable_instrument_id));
   const received=new Date().toISOString();if(!quote){status='PARTIAL_COVERAGE';continue;}
   const {error:qe}=await db.from('e8_reference_quotes').insert({account_id:a.id,symbol,bid:quote.bid,ask:quote.ask,requested_at:requested,received_at:received});
   if(qe)throw Error('REFERENCE_QUOTE_SAVE_FAILED');
   const x=ix.get(symbol),age=x?Date.now()-Date.parse(x.received_at):NaN,fresh=x&&Number.isFinite(age)&&age>=0&&age<=15000;
   const {error:se}=await db.from('cost_samples').insert({account_id:a.id,role:'monitor',symbol,bid:quote.bid,ask:quote.ask,spread:quote.ask-quote.bid,
    requested_at:requested,received_at:received,ipfx_received_at:fresh?x.received_at:null,
    ipfx_bid:fresh?x.bid:null,ipfx_ask:fresh?x.ask:null,ipfx_spread:fresh?Number(x.ask)-Number(x.bid):null});
   if(se)throw Error('COST_SAMPLE_SAVE_FAILED');samples++;lastQuote=received;
  }
  if(!p.last_history_at||Date.now()-Date.parse(p.last_history_at)>=60000){
   try{
   const history=await tl.historyWithConfig(token,String(a.account_id),String(a.acc_num),config);
   const names=new Map(map.map(m=>[String(m.tradable_instrument_id),String(m.symbol)]));
   const revisions=[],records=[];
   for(const row of history){
    const rec=measuredFill(row,a.id,'monitor',names);if(!rec)continue;
    revisions.push({account_id:a.id,ref:rec.ref,revision_sha256:await digest(rec.raw),data:rec});
    records.push({...rec,observed_at:new Date().toISOString()});
   }
   for(let i=0;i<records.length;i+=100){
    if(Date.now()-started>35000)throw Error('FILL_HISTORY_PARTIAL_RETRY_REQUIRED');
    const {error:re}=await db.from('e8_fill_revisions').upsert(revisions.slice(i,i+100),{onConflict:'account_id,ref,revision_sha256',ignoreDuplicates:true});
    if(re)throw Error('FILL_REVISION_SAVE_FAILED');
    const {error:fe}=await db.from('cost_fills').upsert(records.slice(i,i+100),{onConflict:'account_id,ref'});
    if(fe)throw Error('FILL_HISTORY_SAVE_FAILED');fills+=records.slice(i,i+100).length;
   }
   lastHistory=new Date().toISOString();historyError=null;
   }catch(e){const msg=(e as Error)?.message??'';historyError=/^[A-Z0-9_]+$/.test(msg)?msg:'FILL_HISTORY_UNAVAILABLE';}
  }
  // One specification read per run, after quotes/history. Preserve broker limits;
  // missing metadata never stops quote collection or becomes a zero fee.
  if(Date.now()-started<20000){
   try{
    const {data:evidence,error:metaError}=await db.from('e8_instrument_evidence').select('symbol,observed_at').eq('account_id',a.id).order('observed_at',{ascending:false}).limit(200);
    if(metaError)throw Error('INSTRUMENT_EVIDENCE_UNAVAILABLE');
    const latest=new Map<string,string>();for(const e of evidence??[])if(!latest.has(e.symbol))latest.set(e.symbol,e.observed_at);
    const eligible=[...new Set([...(p.symbols as string[]),...slow])].filter(s=>!latest.has(s)||Date.now()-Date.parse(latest.get(s)!)>6*3600000);
    for(const symbol of eligible){
     const target=norm(E8_ALIASES[symbol]??TL_SYMBOLS[symbol]??symbol),exact=map.filter(m=>norm(String(m.symbol))===target);
     const found=exact.length?exact:map.filter(m=>norm(String(m.symbol)).startsWith(target));
     if(found.length!==1||found[0].info_route_id==null)continue;
     const inst=found[0],details=await tl.instrumentDetails(token,String(a.acc_num),Number(inst.info_route_id),String(inst.tradable_instrument_id)) as Record<string,unknown>;
     const lot=finiteNumber(details?.lotSize),ccy=String(details?.quotingCurrency??'').toUpperCase();
     const {error:saveError}=await db.from('e8_instrument_evidence').insert({account_id:a.id,symbol,instrument_id:String(inst.tradable_instrument_id),
      broker_symbol:String(inst.symbol),lot_size:lot!=null&&lot>0?lot:null,quote_currency:/^[A-Z]{3}$/.test(ccy)?ccy:null,details});
     if(saveError)throw Error('INSTRUMENT_EVIDENCE_SAVE_FAILED');
     await db.from('ab_heartbeats').upsert({worker:'e8-instruments',ok:true,at:new Date().toISOString(),detail:{symbol,lot_size:lot,quote_currency:ccy}});break;
    }
   }catch(e){const msg=(e as Error)?.message??'';await db.from('ab_heartbeats').upsert({worker:'e8-instruments',ok:false,at:new Date().toISOString(),detail:{error:/^[A-Z0-9_]+$/.test(msg)?msg:'INSTRUMENT_READ_UNAVAILABLE'}});}
  }
  if(!samples)status='NO_FRESH_QUOTES';
 }catch(e){const message=(e as Error)?.message??'';errorCode=/^[A-Z0-9_]+$/.test(message)?message:'READ_ONLY_MONITOR_FAILED';status='UNAVAILABLE';}
 try{await finish();await db.from('ab_heartbeats').upsert({worker:'e8-reference',ok:errorCode==null&&samples>0,at:new Date().toISOString(),detail:{account_id:p.account_id,status,samples,fills,error_code:errorCode}});}
 catch{return json({ok:false,error:'MONITOR_STATE_WRITE_FAILED'},503);}
 return json({ok:errorCode==null,status,samples,fills,error_code:errorCode},errorCode?503:200);
});
