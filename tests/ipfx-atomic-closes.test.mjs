import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {fixture,account,user,root,slice} from './helpers/e8-db-fixture.mjs';
const deps=process.env.DEMO_TEST_DEPS;
const partial='select fn_commit_ipfx_partial($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) r';
const full='select fn_commit_ipfx_close($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) r';
const pArgs=(id=slice)=>[root,account,user,.02,1.1,.01,1.101,1.23,false,0,0,id];
const fArgs=(volume=.01)=>[root,account,user,volume,1.1,1.102,-4.56,'manual',false,0,0,null];

test('20 duplicate partial submissions and full-close replays credit each quantity exactly once',{skip:!deps},async()=>{
 const {db,open}=await fixture({atomic:true});try{
  await open();const requests=await Promise.all(Array.from({length:20},(_,i)=>db.query(partial,pArgs('50000000-0000-4000-8000-'+i.toString(16).padStart(12,'0')))));
  assert.equal(requests.filter(r=>r.rows[0].r.ok).length,1);
  assert.equal((await db.query(full,fArgs(.02))).rows[0].r.ok,false,'stale full-close quantity must not overcredit');
  const closes=await Promise.all(Array.from({length:20},()=>db.query(full,fArgs())));assert.equal(closes.filter(r=>r.rows[0].r.ok).length,1);
  assert.equal(Number((await db.query('select balance from trading_accounts')).rows[0].balance),99996.67);
  assert.equal((await db.query("select count(*) n from trades where status='closed'")).rows[0].n,2);
  assert.equal(Number((await db.query("select sum(volume) q from trades where status='closed'")).rows[0].q),.02);
 }finally{await db.close();}
});

test('failed partial archive/credit and failed full credit roll back position, exit and archive together',{skip:!deps},async()=>{
 for(const failure of ['slice','balance']){
  const {db,open}=await fixture({atomic:true});try{
   await open();const before=(await db.query('select count(*) n from e8_sim_events')).rows[0].n;
   if(failure==='slice')await db.exec(`create function inject_failure() returns trigger language plpgsql as $$begin if new.parent_trade_id is not null then raise exception 'INJECTED_SLICE_FAILURE';end if;return new;end$$;create trigger fail_slice before insert on trades for each row execute function inject_failure();`);
   else await db.exec(`create function inject_failure() returns trigger language plpgsql as $$begin raise exception 'INJECTED_CREDIT_FAILURE';end$$;create trigger fail_balance before update on trading_accounts for each row execute function inject_failure();`);
   await assert.rejects(db.query(partial,pArgs()),/INJECTED_/);
   assert.equal(Number((await db.query('select volume from trades where id=$1',[root])).rows[0].volume),.02);
   assert.equal((await db.query('select count(*) n from trades')).rows[0].n,1);
   assert.equal((await db.query('select count(*) n from e8_sim_events')).rows[0].n,before);
   assert.equal(Number((await db.query('select balance from trading_accounts')).rows[0].balance),100000);
   if(failure==='balance'){await assert.rejects(db.query(full,fArgs(.02)),/INJECTED_CREDIT/);assert.equal((await db.query('select status from trades')).rows[0].status,'open');}
  }finally{await db.close();}
 }
});

test('ownership, modified entry prices, invalid quantities, frozen accounts and public RPC access fail safely',{skip:!deps},async()=>{
 const {db,open}=await fixture({atomic:true});try{
  await open();for(const change of [{index:2,value:'90000000-0000-4000-8000-000000000001'},{index:4,value:1.2},{index:5,value:.03},{index:5,value:.02}]){const args=pArgs();args[change.index]=change.value;assert.equal((await db.query(partial,args)).rows[0].r.ok,false);}
  for(const value of ['NaN','Infinity','-Infinity',null]){const args=pArgs();args[5]=value;await assert.rejects(db.query(partial,args),/INVALID_CLOSE_VALUES/);}
  await db.exec("update trading_accounts set status='breached'");assert.equal((await db.query(partial,pArgs())).rows[0].r.ok,false);
  assert.equal((await db.query(full,fArgs(.02))).rows[0].r.ok,true,'a frozen account can still flatten an existing position');
  await db.exec('set role authenticated');await assert.rejects(db.query(partial,pArgs()),/permission denied/);
 }finally{await db.close();}
});

test('the real engine calculates before commit and never performs a compensating volume overwrite',async()=>{
 const source=fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts',import.meta.url),'utf8');
 const start=source.indexOf('    // Price first;'),end=source.indexOf('    // trade_id here',start),block=source.slice(start,end);
 for(const scenario of ['price_failure','commit_failure','stale','success']){
  const calls=[],acct={id:account,balance:100000},ctx=vm.createContext({target:{id:root,volume:.02,open_price:1.1},vol:.01,full:.02,exit:1.101,specP:null,v2p:false,sliceShortfall:0,user:{id:user},acct,crypto:{randomUUID:()=>slice},Number,String,round2:x=>Math.round(x*100)/100,tradePnl:async()=>scenario==='price_failure'?null:1.23,err:(message,status)=>({message,status}),db:{rpc:async(name,args)=>{calls.push({name,args});return scenario==='commit_failure'?{error:{code:'INJECTED'}}:{data:scenario==='stale'?{ok:false}:{ok:true,slice_id:slice,balance:100001.23}};}}});
  vm.runInContext(stripTypeScriptTypes('async function run(){'+block+'return {ok:true};}'),ctx);const result=await ctx.run();
  assert.equal(calls.length,scenario==='price_failure'?0:1);
  if(scenario==='success'){assert.equal(acct.balance,100001.23);assert.equal(result.ok,true);assert.equal(calls[0].name,'fn_commit_ipfx_partial');}
  else{assert.equal(acct.balance,100000);assert.equal(result.status,scenario==='price_failure'?503:scenario==='stale'?409:500);}
 }
});

test('a stale enforcement pass cannot overwrite a source balance credited by another close',async()=>{
 const source=fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts',import.meta.url),'utf8');
 const start=source.indexOf('  const expectedStatus = acct.status;'),end=source.indexOf('  if (!saved.data?.length)',start),block=source.slice(start,end);
 for(const venueMode of [false,true]){
  let patch;const acct={id:account,status:'demo',balance:100000};
  const q={eq(){return q;},select:async()=>({data:[{balance:99990}]})};
  const ctx=vm.createContext({acct,venueMode,equity:100003,Number,Date,round2:x=>Math.round(x*100)/100,db:{from:()=>({update:value=>{patch=value;return q;}})}});
  vm.runInContext('async function run(){'+block+'return equity;}',ctx);const equity=await ctx.run();
  if(!venueMode){assert.equal('balance' in patch,false);assert.equal(acct.balance,99990);assert.equal(equity,99993);}
  else assert.equal(patch.balance,100000,'broker-owned venue synchronisation retains its existing path');
 }
});

test('the actual close handler strips only positive Infinity no-stop profits before its atomic credit',async()=>{
 const source=fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts',import.meta.url),'utf8');
 const start=source.indexOf('async function closeTrade('),end=source.indexOf('// Third stop-loss warning',start),body=source.slice(start,end);
 for(const challenge of ['infinity','demo'])for(const gross of [-10,10]){
  let committed;const acct={id:account,user_id:user,challenge_type:challenge,balance:100000};
  const ctx=vm.createContext({acct,Number,Math,console,round2:x=>Math.round(x*100)/100,bookLegs:async()=>({a:false,b:false}),hedgeCloseFirst:async()=>({state:'unhedged'}),tradePnl:async()=>gross,rulesV2:()=>false,fireMirror:()=>Promise.resolve(),mirrorLater(){},shadowLater(){},logAudit:async()=>{},db:{rpc:async(name,args)=>{committed={name,args};return {data:{ok:true,balance:100000+args.p_pnl}};}}});
  vm.runInContext(stripTypeScriptTypes(body),ctx);assert.equal(await ctx.closeTrade(ctx.db,acct,{id:root,volume:.02,open_price:1.1,symbol:'EURUSD',side:'buy'},1.102,'no_stop_loss'),true);
  const stripped=challenge==='infinity'&&gross>0;
  assert.equal(committed.name,'fn_commit_ipfx_close');assert.equal(committed.args.p_pnl,stripped?0:gross);assert.equal(committed.args.p_stripped_profit,stripped?10:null);assert.equal(acct.balance,100000+(stripped?0:gross));
 }
});
