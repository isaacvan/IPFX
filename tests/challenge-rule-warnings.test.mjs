import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code=fs.readFileSync(new URL('../assets/js/challenge-warnings.js',import.meta.url),'utf8');
const ctx=vm.createContext({});vm.runInContext(code,ctx);const {build,announcement}=ctx.IPFXRuleWarnings;
const now=Date.parse('2026-10-12T12:00:00Z');
function state(){return {account:{id:'test-account',challenge_type:'infinity',stage:1,status:'active',equity:1000,balance:1000,day_start_equity:1000,sl_strikes:0,sl_strikes_max:3,
limits:{daily_floor:975,max_dd_floor:950,drawdown_allowance_usd:50,daily_loss_allowance_usd:25,stop_loss_deadline_seconds:30,daily_profit_cap_usd:14,daily_profit_gain_usd:0,target_balance:1040},progress:{trading_days:2,min_trading_days:10}},open_trades:[]};}
test('loss warnings use the fixed allowance even after the trailing floor rises above starting balance',()=>{
 const s=state();s.account.equity=1013;s.account.limits.max_dd_floor=1000;
 const w=build(s,now).find(x=>x.code==='drawdown');assert.equal(w.level,'warning');assert.match(w.message,/\$13.00 left/);
 s.account.equity=1004;assert.equal(build(s,now).find(x=>x.code==='drawdown').level,'critical');
 s.account.equity=1020;assert.equal(build(s,now).some(x=>x.code==='drawdown'),false);
});
test('daily loss warnings escalate at ten percent room and missing numeric data cannot produce invented warnings',()=>{
 const s=state();s.account.equity=982.5;assert.equal(build(s,now).find(x=>x.code==='daily-loss').level,'warning');
 s.account.equity=977.5;assert.equal(build(s,now).find(x=>x.code==='daily-loss').level,'critical');
 s.account.limits.daily_floor=null;assert.equal(build(s,now).some(x=>x.code==='daily-loss'),false);
});
test('stop-loss countdown uses the configured deadline and warns before another strike ends the run',()=>{
 const s=state();s.open_trades=[{sl:null,opened_at:new Date(now-21000).toISOString()}];
 let w=build(s,now).find(x=>x.code==='missing-stop');assert.equal(w.level,'critical');assert.match(w.message,/9s until/);
 s.account.sl_strikes=2;assert.match(build(s,now).find(x=>x.code==='stop-strikes').message,/1 more ends/);
 s.open_trades[0].sl=995;assert.equal(build(s,now).some(x=>x.code==='missing-stop'),false);
 s.open_trades[0].sl=null;s.account.limits.stop_loss_deadline_seconds=null;assert.equal(build(s,now).some(x=>x.code==='missing-stop'),false);
});
test('profit-cap and concentration notices never describe these conditions as automatic breaches',()=>{
 const s=state();s.account.limits.daily_profit_gain_usd=12;
 let w=build(s,now).find(x=>x.code==='profit-cap');assert.match(w.message,/\$2.00 left/);assert.match(w.message,/not a breach/);
 s.account.limits.daily_profit_cap_reached=true;assert.equal(build(s,now).some(x=>x.code==='profit-cap'),false);
 s.account.progress.qualification={applies:true,best_day_share:.36,meaningful_days:3,rules:{max_best_day_share:.35,min_trading_days:10}};
 w=build(s,now).find(x=>x.code==='consistency');assert.match(w.message,/not an automatic account failure/);assert.equal(w.notify,false);
});
test('profit target alone does not pass the stage; meaningful days come from the actual saved rules',()=>{
 const s=state();s.account.balance=1040;
 assert.match(build(s,now).find(x=>x.code==='minimum-days').message,/2\/10 qualifying trading days/);
 s.account.progress.qualification={applies:true,meaningful_days:4,rules:{min_trading_days:15}};
 assert.match(build(s,now).find(x=>x.code==='minimum-days').message,/4\/15/);
});
test('practice, failed and other programmes do not get Infinity reminders',()=>{
 for(const patch of [{is_demo:true},{status:'breached'},{challenge_type:'traditional'}]){
 const s=state();Object.assign(s.account,patch);s.account.equity=976;assert.equal(build(s,now).length,0);
 }
});
test('notifications deduplicate across refresh, immediately escalate and stay independent per account',()=>{
 const seen={},amber={code:'daily-loss',level:'warning',notify:true},red={...amber,level:'critical'};
 assert.equal(announcement([amber],'a',now,seen),amber);
 assert.equal(announcement([amber],'a',now+1000,JSON.parse(JSON.stringify(seen))),null);
 assert.equal(announcement([red],'a',now+1000,seen),red);
 assert.equal(announcement([red],'a',now+2000,seen),null);
 assert.equal(announcement([red],'b',now+3000,seen),red);
 assert.equal(announcement([red],'a',now+31*60000,seen),red);
});
test('personal consistency amount rounds up and uses net UTC daily profit',()=>{
 const s=state();s.account.progress.qualification={applies:true,best_day_share:1,rules:{max_best_day_share:.35}};
 s.closed_trades=[{closed_at:'2026-10-12T12:00:00Z',pnl:25},{closed_at:'2026-10-12T13:00:00Z',pnl:-5}];
 const c=ctx.IPFXRuleWarnings.consistency(s);assert.equal(c.best,20);assert.equal(c.required,57.15);assert.equal(c.remaining,37.15);
 s.closed_trades.push({closed_at:'2026-10-13T12:00:00Z',pnl:10});s.account.progress.qualification.best_day_share=20/30;
 assert.equal(ctx.IPFXRuleWarnings.consistency(s).remaining,27.15);
 s.account.progress.qualification.best_day_share=.9;assert.equal(ctx.IPFXRuleWarnings.consistency(s),null);
});
