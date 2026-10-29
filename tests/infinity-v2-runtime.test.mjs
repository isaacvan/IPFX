import test from 'node:test';import assert from 'node:assert/strict';import {v2db,uid,definition} from './helpers/infinity-v2-db.mjs';
import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';
const opts={skip:!process.env.DEMO_TEST_DEPS};
test('the actual shared claim, owner-grant, reset and approval provisioner assigns the gated version',opts,async()=>{
 const {db}=await v2db();try{
 const src=fs.readFileSync(new URL('../supabase/functions/_shared/provisioning.ts',import.meta.url),'utf8');
 const provision=vm.runInNewContext(stripTypeScriptTypes(src.replaceAll('export ',''))+';insertAccountFromPreset',{Date,Number,String});
 const bridge={from:table=>({insert:payload=>({select:()=>({single:async()=>{try{
  const keys=Object.keys(payload);return {data:(await db.query('insert into '+table+'('+keys.join(',')+') values('+keys.map((_,i)=>'$'+(i+1)).join(',')+') returning *',Object.values(payload))).rows[0]};
 }catch(error){return {error};}}})})}),rpc:async()=>({data:'ACCEPTED:test-fixture'})};
 const preset=(await db.query("select * from challenge_presets where id='infinity_s1'")).rows[0];
 for(const gate of ['off','future','live']){
  await db.query("update infinity_v2_settings set infinity_v2_enabled=$1,cutover_at=clock_timestamp()+make_interval(secs=>$2) where singleton",[gate!=='off',gate==='future'?86400:-86400]);
  for(const path of ['claim_infinity','grant_challenge','reset_account','approval']){
   const a=await provision(bridge,crypto.randomUUID(),preset,0);assert.ok(a,path+' must provision');
   assert.equal(a.rules_version,gate==='live'?'infinity_v2':'infinity_v1',path+' '+gate);
  }
 }
 }finally{await db.close();}
});
async function open(db,a,{symbol='EURUSD',side='buy',volume=.01,price=1.1,sl=1.099,at=new Date().toISOString()}={}){
 return (await db.query(`insert into trades(account_id,user_id,symbol,side,volume,open_price,sl,opened_at,execution_rules_version) values($1,$2,$3,$4,$5,$6,$7,$8,'infinity_v2') returning *`,[a.id,uid,symbol,side,volume,price,sl,at])).rows[0];
}
async function close(db,t,pnl=2,reason='manual',seconds=301){return db.query("update trades set status='closed',pnl=$2,closed_at=opened_at+make_interval(secs=>$3),close_reason=$4 where id=$1",[t.id,pnl,seconds,reason]);}
test('real triggers: initial stop capture, minimum distance, no widening, immutability and shared group cap',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account();
  await assert.rejects(open(db,a,{sl:1.0999}),/STOP_TOO_CLOSE/);
  const t=await open(db,a,{volume:.05});assert.equal(Number(t.initial_risk_usd),5);assert.equal(Number(t.initial_sl),1.099);
  await assert.rejects(db.query('update trades set sl=1.098 where id=$1',[t.id]),/STOP_CANNOT_WIDEN/);
  await assert.rejects(db.query('update trades set initial_risk_usd=1 where id=$1',[t.id]),/IMMUTABLE/);
  await assert.rejects(open(db,a,{volume:.01}),/COUNTED_TRADE_RISK_LIMIT/);
  await db.query('update trades set sl=1.0991 where id=$1',[t.id]);
  assert.equal(Number((await db.query('select initial_risk_usd from trades where id=$1',[t.id])).rows[0].initial_risk_usd),5);
 }finally{await db.close();}
});
test('simultaneous openings cannot spend one counted-group allowance twice',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account();
 const results=await Promise.allSettled([open(db,a,{volume:.05}),open(db,a,{volume:.05})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal((await db.query("select count(*) n from trades where status='open'")).rows[0].n,1);
 }finally{await db.close();}
});
test('stop-out pause blocks both market entries and saved pending orders, without blocking closes',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account(),t=await open(db,a);await close(db,t,-1,'sl');
 await assert.rejects(open(db,a),/STOP_OUT_PAUSE/);
 await assert.rejects(db.query("insert into pending_orders(account_id,status,symbol,side,volume,trigger_price,sl) values($1,'pending','EURUSD','buy',.01,1.1,1.099)",[a.id]),/STOP_OUT_PAUSE/);
 await db.query("update infinity_v2_pauses set until_at=clock_timestamp()-interval '1 second' where account_id=$1",[a.id]);
 await open(db,a);
 }finally{await db.close();}
});
test('reference markup is applied and missing quotes use current IPFX spread',opts,async()=>{
 const {db}=await v2db();try{
 let p=(await db.query("select infinity_v2_price('EURUSD') p")).rows[0].p;assert.equal(p.fallback,true);
 await db.exec("insert into e8_monitor_profiles values(3,true);insert into e8_reference_quotes values(1,3,'EURUSD',1.09998,1.10002,clock_timestamp(),clock_timestamp()-interval '1 millisecond')");
 p=(await db.query("select infinity_v2_price('EURUSD') p")).rows[0].p;assert.equal(p.fallback,false);assert.ok(Math.abs(Number(p.spread)-.000046)<1e-12);
 }finally{await db.close();}
});
test('partial slices retain one observation and one opening-risk denominator, including fractional gold lots',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account();const t=await open(db,a,{symbol:'XAUUSD',price:2000,sl:1998,volume:.003});
 const r=(await db.query('select fn_commit_ipfx_partial($1,$2,$3,.003,2000,.001,2001,.10,true,0,0,gen_random_uuid()) j',[t.id,a.id,uid])).rows[0].j;
 assert.equal(r.ok,true);assert.equal(Number(r.remaining_volume),.002);
 await close(db,t,.2);const g=(await db.query('select * from infinity_v2_groups_result($1)',[a.id])).rows;
 assert.equal(g.length,1);assert.equal(Number(g[0].pnl),.3);assert.ok(Math.abs(Number(g[0].r)-.5)<1e-10);
 }finally{await db.close();}
});
test('all qualification conditions and Stage 1 advance use the same authoritative score',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account();
 for(let i=0;i<20;i++){const t=await open(db,a,{at:new Date(Date.now()+1000+i*6*3600000).toISOString()});await close(db,t);}
 await db.query('update trading_accounts set balance=1040 where id=$1',[a.id]);
 const score=(await db.query('select infinity_v2_progress($1) p',[a.id])).rows[0].p;assert.equal(score.n,20);assert.equal(score.eligible,true,JSON.stringify(score));
 await db.exec('update infinity_v2_settings set infinity_v2_enabled=false where singleton');
 await db.query("update trading_accounts set status='passed' where id=$1",[a.id]);
 const pass=(await db.query('select fn_advance_infinity_stage($1,$2) p',[a.id,uid])).rows[0].p;assert.equal(pass.ok,true);
 const child=(await db.query('select * from trading_accounts where id=$1',[pass.next_account])).rows[0];assert.equal(child.rules_version,'infinity_v2');assert.equal(Number(child.profit_target_pct),7);assert.equal(child.min_trades,0);
 const retry=(await db.query('select fn_advance_infinity_stage($1,$2) p',[a.id,uid])).rows[0].p;assert.equal(retry.next_account,child.id);
 }finally{await db.close();}
});
test('five-minute exclusion affects target and payout helper, while all losses count',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account();let t=await open(db,a);await close(db,t,10,'manual',299);
 t=await open(db,a,{at:new Date(Date.now()+3600000).toISOString()});await close(db,t,-2,'manual',1);
 assert.equal(Number((await db.query('select fn_infinity_quick_trade_profit($1) n',[a.id])).rows[0].n),10);
 assert.equal(Number((await db.query('select infinity_v2_progress($1) p',[a.id])).rows[0].p.counted_profit),-2);
 }finally{await db.close();}
});
test('closed-balance midnight baseline and no daily cap preserve an overnight winner',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account();await open(db,a);
 await db.exec("update live_quotes set mid=1.12,bid=1.11995,ask=1.12005,received_at=clock_timestamp() where symbol='EURUSD'");
 await db.query("update trading_accounts set day_start_date=(clock_timestamp() at time zone 'UTC')::date-1 where id=$1",[a.id]);
 const g=(await db.query('select fn_enforce_infinity_from_quotes($1) g',[a.id])).rows[0].g;assert.equal(Number(g.day_start_equity),1000);assert.equal(g.status,'active');
 assert.equal((await db.query('select fn_infinity_daily_entry_limit($1) p',[a.id])).rows[0].p.blocked,false);
 assert.equal((await db.query('select fn_infinity_cap_closes_positions($1) p',[a.id])).rows[0].p,false);
 }finally{await db.close();}
});
test('restart is atomic, repeat-safe and preserves old payouts and archived trade history',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account({version:'infinity_v1',created:new Date(Date.now()-40*86400000).toISOString()});
 await db.query("insert into payouts(account_id,status,trader_share) values($1,'requested',700)",[a.id]);
 const call=()=>db.query("select fn_restart_infinity_v2($1,'test-v2',true,true) p",[uid]);
 const p=(await call()).rows[0].p,again=(await call()).rows[0].p;assert.equal(p.account.id,again.account.id);
 assert.equal((await db.query('select status from trading_accounts where id=$1',[a.id])).rows[0].status,'closed');
 assert.equal((await db.query('select count(*) n from infinity_v2_restarts')).rows[0].n,1);
 assert.equal(Number((await db.query('select sum(trader_share) n from payouts')).rows[0].n),700);
 await assert.rejects(open(db,a),/ACCOUNT_FROZEN/,'a delayed request cannot open on the archived v1 run');
 await assert.rejects(db.query("insert into pending_orders(account_id,status) values($1,'pending')",[a.id]),/ACCOUNT_FROZEN/);
 }finally{await db.close();}
});

test('switch rejects a stale v1 fill and exposes the v2 deadline to the hub',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account({version:'infinity_v1'});
 await db.query("select fn_switch_infinity_v2($1,$2,'stale-fill-test','test-v2',true)",[a.id,uid]);
 await assert.rejects(db.query("insert into trades(account_id,user_id,symbol,side,volume,open_price,sl) values($1,$2,'EURUSD','buy',.01,1.1,1.099)",[a.id,uid]),/RULES_CHANGED_REFRESH_REQUIRED/);
 const snap=(await db.query("select hub_snapshot('test',$1) s",[a.id])).rows[0].s;
 assert.equal(snap.accounts[0].rules_version,'infinity_v2');
 assert.equal(snap.accounts[0].v2_stop_deadline_seconds,30);
 assert.equal((await db.query('select count(*) n from trades')).rows[0].n,0);
 }finally{await db.close();}
});
test('restart rejects missing terms, pending exposure, exhausted attempt and breach lockout without archiving',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account({version:'infinity_v1',created:new Date(Date.now()-40*86400000).toISOString()});
 await assert.rejects(db.query("select fn_restart_infinity_v2($1,'test-v2',false,true)",[uid]),/TERMS_NOT_ACCEPTED/);
 await db.query("insert into pending_orders(account_id,status) values($1,'pending')",[a.id]);
 await assert.rejects(db.query("select fn_restart_infinity_v2($1,'test-v2',true,true)",[uid]),/CANCEL_PENDING/);
 await db.query("update pending_orders set status='cancelled' where account_id=$1",[a.id]);
 await db.query('update trading_accounts set created_at=clock_timestamp() where id=$1',[a.id]);
 await assert.rejects(db.query("select fn_restart_infinity_v2($1,'test-v2',true,true)",[uid]),/NO_RESTARTS_LEFT/);
 await db.exec(`create or replace function fn_infinity_breach_lockout(uuid)returns jsonb language sql as 'select ''{"locked":true}''::jsonb'`);
 await assert.rejects(db.query("select fn_restart_infinity_v2($1,'test-v2',true,true)",[uid]),/BREACH_LOCKOUT/);
 assert.equal((await db.query('select status from trading_accounts where id=$1',[a.id])).rows[0].status,'active');
 }finally{await db.close();}
});
test('Stage 4 ends the run at exactly minus 500 over any 40 consecutive groups',opts,async()=>{
 const {db,account}=await v2db();try{let a=await account();for(let stage=2;stage<=4;stage++){await db.query("update trading_accounts set status='passed' where id=$1",[a.id]);a=await account({stage,parent:a.id});}
 for(let i=0;i<40;i++){const t=await open(db,a,{at:new Date(Date.now()+1000+i*3600000).toISOString()});await close(db,t,-12.5);}
 const result=(await db.query('select * from trading_accounts where id=$1',[a.id])).rows[0];assert.equal(result.status,'breached');assert.equal(result.breach_reason,'performance_rule');
 }finally{await db.close();}
});
test('switch carries previously earned eligible profit while resetting score observations',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account({version:'infinity_v1'});
 await db.query("insert into trades(account_id,user_id,symbol,side,volume,open_price,sl,status,opened_at,closed_at,pnl) values($1,$2,'EURUSD','buy',.01,1.1,1.099,'closed',clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day'+interval '2 minutes',40)",[a.id,uid]);
 await db.query('update trading_accounts set balance=1040 where id=$1',[a.id]);
 await db.query("select fn_switch_infinity_v2($1,$2,'switch-123','test-v2',true)",[a.id,uid]);
 const p=(await db.query('select infinity_v2_progress($1) p',[a.id])).rows[0].p;assert.equal(p.n,0);assert.equal(Number(p.counted_profit),40);
 assert.equal(Number((await db.query('select fn_infinity_quick_trade_profit($1) q',[a.id])).rows[0].q),0,'pre-switch two-minute profit keeps its v1 treatment');
 }finally{await db.close();}
});
test('uncleared opposite-side ring evidence holds both traders’ payouts',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account();await db.query("insert into ab_hedge_flags(person_a,person_b,status) values(gen_random_uuid(),$1,'open')",[uid]);
 assert.equal((await db.query('select infinity_v2_review_hold($1) p',[a.id])).rows[0].p,true);
 await assert.rejects(db.query("insert into payouts(account_id,user_id,status) values($1,$2,'requested')",[a.id,uid]),/INTEGRITY_REVIEW/);
 await db.exec("update ab_hedge_flags set status='closed' where status='open'");assert.equal((await db.query('select infinity_v2_review_hold($1) p',[a.id])).rows[0].p,false);
 }finally{await db.close();}
});
test('v1 golden scenarios retain baseline daily-cap, counted-profit, hold and qualification results',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account({version:'infinity_v1'});await db.query('update trading_accounts set balance=1040 where id=$1',[a.id]);
 const scenario=async()=>({daily:(await db.query('select fn_infinity_daily_entry_limit($1) p',[a.id])).rows[0].p,
  counted:(await db.query('select fn_infinity_counted_profit($1) p',[a.id])).rows[0].p,
  hold:(await db.query('select fn_infinity_quick_trade_profit($1) p',[a.id])).rows[0].p,
  qualified:(await db.query('select qualification_progress_v2($1) p',[a.id])).rows[0].p});
 const after=await scenario();await db.exec('begin');
 for(const signature of ['public.fn_infinity_cap_closes_positions(uuid)','public.fn_infinity_counted_profit(uuid)','public.fn_infinity_quick_trade_profit(uuid,timestamp with time zone)','public.qualification_progress_v2(uuid)']){
  const saved=(await db.query('select definition from infinity_v2_legacy_definitions where signature=$1',[signature])).rows[0].definition;await db.exec(saved);
 }
 const before=await scenario();await db.exec('rollback');assert.deepEqual(after,before);
 assert.equal(after.daily.blocked,true);assert.equal(Number(after.hold),0);
 }finally{await db.close();}
});
test('actual Stage 3 payout routine preserves held Stage 2 profit, excludes quick v2 winners and caps payout at 700',opts,async()=>{
 const {db,account}=await v2db();try{
 await db.exec(definition('20261008110000_infinity_cap_700_dynamic_target','fn_request_infinity_stage3_payout'));
 await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
 let a=await account();await db.query("update trading_accounts set status='passed' where id=$1",[a.id]);
 a=await account({stage:2,parent:a.id});const s2=a;
 for(let i=0;i<40;i++){const t=await open(db,a,{at:new Date(Date.now()+1000+i*6*3600000).toISOString()});await close(db,t,8.75);}
 await db.query("update trading_accounts set balance=5350,status='passed' where id=$1",[a.id]);
 a=await account({stage:3,parent:a.id});
 for(let i=0;i<50;i++){const t=await open(db,a,{at:new Date(Date.now()+1000+i*6*3600000).toISOString()});await close(db,t,16);}
 const quick=await open(db,a,{at:new Date(Date.now()+1000+60*6*3600000).toISOString()});await close(db,quick,100,'manual',120);
 await db.query("update trading_accounts set balance=10900,status='passed' where id=$1",[a.id]);
 const method=crypto.randomUUID();await db.query('insert into payout_methods values($1,$2)',[method,uid]);
 const request=()=>db.query("select (fn_request_infinity_stage3_payout($1,$2,'payout-test-key',$3)).*",[a.id,uid,method]);
 const payout=(await request()).rows[0];assert.equal(Number(payout.trader_share),700);assert.equal(Number(payout.gross_profit),1150);assert.equal(payout.status,'requested');
 assert.equal((await request()).rows[0].id,payout.id);assert.equal(Number((await db.query('select balance from trading_accounts where id=$1',[s2.id])).rows[0].balance),5350);
 }finally{await db.close();}
});

test('v1 payout financial replay is identical with and without the v2 adapters',opts,async()=>{
 const {db,account}=await v2db();try{
 await db.exec(definition('20261008110000_infinity_cap_700_dynamic_target','fn_request_infinity_stage3_payout'));
 await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
 let a=await account({version:'infinity_v1'});await db.query("update trading_accounts set status='passed' where id=$1",[a.id]);
 a=await account({version:'infinity_v1',stage:2,parent:a.id});const s2=a;
 await db.query("update trading_accounts set balance=5350,status='passed' where id=$1",[a.id]);
 a=await account({version:'infinity_v1',stage:3,parent:a.id});
 for(const [id,pnl,seconds] of [[s2.id,350,120],[a.id,800,120],[a.id,100,30]]){
  await db.query("insert into trades(account_id,user_id,symbol,side,volume,open_price,status,pnl,opened_at,closed_at) values($1,$2,'EURUSD','buy',.01,1.1,'closed',$3,clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour'+make_interval(secs=>$4))",[id,uid,pnl,seconds]);
 }
 await db.query("update trading_accounts set balance=10900,status='passed' where id=$1",[a.id]);
 const method=crypto.randomUUID();await db.query('insert into payout_methods values($1,$2)',[method,uid]);
 const scenario=async()=>{
  const row=(await db.query("select (fn_request_infinity_stage3_payout($1,$2,'v1-payout-golden',$3)).*",[a.id,uid,method])).rows[0];
  return {gross:Number(row.gross_profit),share:Number(row.trader_share),split:Number(row.split_pct),status:row.status,event:row.programme_event};
 };
 await db.exec('begin');const after=await scenario();await db.exec('rollback');
 await db.exec('begin');
 for(const signature of ['public.fn_infinity_quick_trade_profit(uuid,timestamp with time zone)','public.qualification_progress_v2(uuid)'])await db.exec((await db.query('select definition from infinity_v2_legacy_definitions where signature=$1',[signature])).rows[0].definition);
 const before=await scenario();await db.exec('rollback');assert.deepEqual(after,before);assert.equal(after.gross,1150);assert.equal(after.share,700);
 }finally{await db.close();}
});
test('actual monthly restart path assigns v2 once and selects the v2 lifecycle email',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account({version:'infinity_v1',created:new Date(Date.now()-40*86400000).toISOString()});
 await db.query("update trading_accounts set status='breached',breached_at=clock_timestamp()-interval '40 days' where id=$1",[a.id]);
 const run=(await db.query('select fn_infinity_monthly_auto_restart() p')).rows[0].p;assert.equal(run.started,1,JSON.stringify((await db.query('select * from infinity_monthly_restarts')).rows));
 assert.equal((await db.query("select rules_version from trading_accounts where status='active'")).rows[0].rules_version,'infinity_v2');
 assert.equal((await db.query('select template_key from email_events')).rows[0].template_key,'infinity_monthly_restart_v2');
 assert.equal((await db.query('select fn_infinity_monthly_auto_restart() p')).rows[0].p.started,0);
 assert.equal((await db.query('select count(*) n from email_events')).rows[0].n,1);
 }finally{await db.close();}
});
test('review clearances require a reason, remain append-only and expire when evidence changes',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account();await db.query("insert into ab_hedge_flags(person_a,person_b,status) values(gen_random_uuid(),$1,'open')",[uid]);
 await assert.rejects(db.query("select infinity_v2_record_review($1,$2,'short')",[a.id,uid]),/REVIEW_REASON_REQUIRED/);
 const review=(await db.query("select infinity_v2_record_review($1,$2,'Reviewed identity and independent trading evidence') r",[a.id,uid])).rows[0].r;
 assert.equal(review.still_held,false);
 await db.exec("update ab_hedge_flags set shared=shared+1 where status='open'");assert.equal((await db.query('select infinity_v2_review_hold($1) r',[a.id])).rows[0].r,true);
 await assert.rejects(db.exec("delete from infinity_v2_review_clearances where true"),/APPEND_ONLY/);
 assert.equal((await db.query("select has_function_privilege('anon','public.infinity_v2_record_review(uuid,uuid,text)','EXECUTE') allowed")).rows[0].allowed,false);
 }finally{await db.close();}
});
test('actual free-restart offer creates v2, but retirement cannot erase a used monthly attempt',opts,async()=>{
 for(const currentMonth of [false,true]){const {db,account}=await v2db();try{const a=await account({version:'infinity_v1',created:new Date(Date.now()-(currentMonth?0:40*86400000)).toISOString()});
 await db.query("insert into trades(account_id,user_id,status,pnl,opened_at,closed_at) values($1,$2,'closed',20,clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day'+interval '2 minutes')",[a.id,uid]);
 const call=()=>db.query('select fn_infinity_take_fresh_restart($1,$2) p',[a.id,uid]);
 if(currentMonth){await assert.rejects(call(),/MONTHLY_ATTEMPTS_EXHAUSTED/);assert.equal((await db.query('select access_revoked_at from trading_accounts where id=$1',[a.id])).rows[0].access_revoked_at,null);}
 else{await call();assert.equal((await db.query("select rules_version from trading_accounts where access_revoked_at is null and status='active'")).rows[0].rules_version,'infinity_v2');}
 }finally{await db.close();}}
});
test('owner advance keeps the legacy v1 override but cannot bypass v2 qualification',opts,async()=>{
 for(const version of ['infinity_v1','infinity_v2']){const {db,account}=await v2db();try{const a=await account({version});await db.query('update trading_accounts set balance=1040 where id=$1',[a.id]);
 const r=(await db.query('select fn_owner_advance_infinity_stage($1,$2) p',[a.id,uid])).rows[0].p;
 assert.equal(r.ok,version==='infinity_v1');if(r.ok)assert.equal((await db.query('select rules_version from trading_accounts where id=$1',[r.next_account])).rows[0].rules_version,'infinity_v1');
 }finally{await db.close();}}
});
test('one missed stop costs a strike and excludes its undefined R, without permanently preventing a later pass',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account(),missing=await open(db,a,{sl:null});await close(db,missing,-1,'no_stop_loss',1);
 await db.query('update trading_accounts set sl_strikes=1 where id=$1',[a.id]);
 for(let i=0;i<20;i++){const t=await open(db,a,{at:new Date(Date.now()+1000+(i+1)*6*3600000).toISOString()});await close(db,t,2.05);}
 await db.query('update trading_accounts set balance=1040 where id=$1',[a.id]);const p=(await db.query('select infinity_v2_progress($1) p',[a.id])).rows[0].p;
 assert.equal(p.n,20);assert.equal(p.eligible,true,JSON.stringify(p));
 for(let i=0;i<2;i++){const t=await open(db,a,{sl:null,at:new Date(Date.now()+1000+(i+30)*6*3600000).toISOString()});await close(db,t,0,'no_stop_loss',1);}
 assert.equal((await db.query('select status from trading_accounts where id=$1',[a.id])).rows[0].status,'breached');
 assert.equal((await db.query('select reason from account_breach_events where account_id=$1',[a.id])).rows[0].reason,'stop_loss_rule');
 }finally{await db.close();}
});
test('market and pending admissions share an atomic five-order burst allowance',opts,async()=>{
 const {db,account}=await v2db();try{const a=await account();await open(db,a);await open(db,a);
 for(let i=0;i<3;i++)await db.query("insert into pending_orders(account_id,status,symbol,side,volume,trigger_price,sl) values($1,'pending','EURUSD','buy',.01,1.09,1.089)",[a.id]);
 await assert.rejects(open(db,a),/ORDER_BURST_LIMIT/);
 assert.equal((await db.query('select count(*) n from trades')).rows[0].n,2);
 }finally{await db.close();}
});
