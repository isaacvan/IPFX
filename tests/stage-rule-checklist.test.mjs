import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const html=fs.readFileSync(new URL('../trading.html',import.meta.url),'utf8');
const code=fs.readFileSync(new URL('../assets/js/challenge-warnings.js',import.meta.url),'utf8');
const ctx=vm.createContext({});vm.runInContext(code,ctx);const {checklist}=ctx.IPFXRuleWarnings;
function fixture(){return{account:{id:'a',challenge_type:'infinity',stage:1,status:'active',equity:1010,balance:1010,starting_balance:1000,sl_strikes:0,sl_strikes_max:3,limits:{target_balance:1040,daily_loss_allowance_usd:25,drawdown_allowance_usd:50,drawdown_mode:'trailing_intraday',base_risk_per_trade_usd:5,total_open_risk_multiple:3,daily_profit_cap_usd:14,stop_loss_deadline_seconds:30},progress:{eligible_closed_balance:1010,trading_days:4,min_trading_days:10,trades_closed:12,min_trades:30,requirements_met:false,qualification:{applies:true,eligible:false,elapsed_days:6,meaningful_days:4,exposure_sessions:8,best_day_share:.4,rules:{min_elapsed_days:14,min_trading_days:10,min_sessions:30,max_best_day_share:.35,session_flat_gap_minutes:60}}}},open_trades:[]};}
test('checklist covers all Stage 1 gates with actual values, including eligible profit and flat positions',()=>{
 const s=fixture(),c=checklist(s),row=id=>c.rows.find(r=>r.id===id);
 for(const id of ['target','elapsed','days','sessions','consistency','trades','flat','standing','server'])assert.ok(row(id),id);
 assert.match(row('days').text,/4 \/ 10/);assert.match(row('target').text,/1010.00.*1040.00/);
 assert.equal(row('target').done,false);assert.equal(c.ready,false);assert.equal(row('flat').done,true);
 s.account.balance=1100;assert.equal(checklist(s).rows.find(r=>r.id==='target').done,false,'short-held winning profit does not falsely meet target');
 s.open_trades=[{id:'open'}];assert.equal(checklist(s).rows.find(r=>r.id==='flat').done,false);
 assert.ok(c.read.length<=5,'five short lines at most');
 for(const rule of ['14 days','10 trading days','30 sessions','30 trades','35%','25.00','50.00','5.00','30s','14.00'])assert.ok(c.read.some(text=>text.includes(rule)),rule);
});
test('Stage 2 uses saved rules instead of hard-coded old targets and profitable-day bar',()=>{
 const s=fixture(),a=s.account;a.stage=2;a.starting_balance=5000;a.limits.target_balance=5350;
 a.progress.min_profitable_days_pct=40;a.progress.profitable_days_pct=35;a.progress.min_profitable_day_net_usd=2.5;
 a.progress.qualification.rules.min_trading_days=15;
 const c=checklist(s);assert.match(c.rows.find(r=>r.id==='days').text,/15/);assert.match(c.read.find(t=>t.startsWith('To pass')),/350.00/);
 assert.equal(c.rows.find(r=>r.id==='profitable').done,false);assert.match(c.read.find(t=>t.includes('40% of trading days')),/2.50/);
});
test('read acknowledgements remain stable across live P&L changes, reset for new accounts and cannot make a stage ready',()=>{
 const s=fixture(),key=checklist(s).key;s.account.equity=980;s.account.progress.eligible_closed_balance=980;
 assert.equal(checklist(s).key,key);assert.equal(checklist(s).ready,false);
 s.account.id='next-stage';assert.notEqual(checklist(s).key,key);
 s.account.progress.qualification=null;assert.equal(checklist(s).available,false);assert.equal(checklist(s).ready,false);
 assert.equal(checklist(s).read.some(t=>t.includes('NaN')),false);
});
test('only complete verified results enable readiness, and Stage 4 has no invented pass checklist',()=>{
 const s=fixture(),a=s.account,P=a.progress,Q=P.qualification;
 P.eligible_closed_balance=1040;P.trading_days=10;P.trades_closed=30;P.requirements_met=true;
 Q.elapsed_days=14;Q.meaningful_days=10;Q.exposure_sessions=30;Q.best_day_share=.3;Q.eligible=true;
 assert.equal(checklist(s).ready,true);P.requirements_met=false;assert.equal(checklist(s).ready,false);
 a.stage=4;assert.equal(checklist(s),null);a.stage=1;a.is_demo=true;assert.equal(checklist(s),null);
});
test('critical warnings and stage review use accessible dialogs, and new entries require checked acknowledgements',()=>{
 assert.match(html,/<dialog id="ruleCriticalDialog"[^>]*aria-labelledby="ruleCriticalTitle"/);
 assert.match(html,/<dialog id="stageRulesDialog"[^>]*aria-labelledby="stageRulesTitle"/);
 assert.match(html,/if\(stageRulesBlockEntry\(\)\)return;/);
 assert.match(html,/!checks.every\(box=>box.checked\)\)return;/);
 assert.match(html,/box.disabled=true;box.checked=r.done;/);
 assert.match(html,/Manage existing positions/);
 assert.match(html,/Manual acknowledgements cannot complete a requirement/);
});

// ---- Infinity v2 accounts get their own rows and their own six short lines (never the v1 session / day / 1-minute wording) ----
function v2fixture(){return{account:{id:'v2a',challenge_type:'infinity',rules_version:'infinity_v2',stage:2,status:'active',equity:5100,balance:5100,starting_balance:5000,sl_strikes:0,sl_strikes_max:3,
 limits:{daily_loss_allowance_usd:100,drawdown_allowance_usd:200,base_risk_per_trade_usd:17.5},progress:{},
 infinity_v2:{applies:true,eligible:false,n:12,score:1.2,combined_score:1.5,counted_profit:120,target:350,best_day_share:.3,identity_required:true,
  rules:{target_pct:7,min_counted_trades:40,stage_score:1.65,combined_score:2,best_day_share:.35,group_gap_minutes:15,stop_deadline_seconds:30,stop_spread_multiple:8,total_risk_multiple:3,sl_strikes_max:3,min_hold_seconds:300,stop_pause_seconds:600,risk_pct:.35,daily_loss_pct:2,max_drawdown_pct:4}}},
 open_trades:[],pending_orders:[]};}
test('v2 account: rows show counted profit, counted trades, both scores, best day, flat, standing and identity',()=>{
 const c=checklist(v2fixture()),row=id=>c.rows.find(r=>r.id===id);
 for(const id of ['target','trades','score','overall','consistency','flat','standing','identity','server'])assert.ok(row(id),id);
 for(const id of ['elapsed','days','sessions','profitable'])assert.equal(row(id),undefined,'no v1 row '+id);
 assert.match(row('target').text,/\$120\.00 \/ \$350\.00/);assert.match(row('trades').text,/12 \/ 40/);assert.match(row('score').text,/1\.20 \/ 1\.65/);assert.match(row('overall').text,/1\.50 \/ 2\.0/);
 assert.equal(row('identity').done,false);assert.equal(c.ready,false);assert.equal(c.available,true);
});
test('v2 account: six short read-before-trading lines carry the v2 rules and numbers from the saved rules',()=>{
 const c=checklist(v2fixture());assert.equal(c.read.length,6);
 const all=c.read.join(' | ');
 for(const re of [/To pass: make \$350\.00 profit with at least 40 counted trades, a consistency score of 1\.65 and an overall score of 2\.0 and no day over 35% of your profit, then close every trade\. No minimum days/,
  /counted trade is one trade, or several on the same instrument and direction within 15 minutes/,/stop-loss within 30s, at least 8× the spread away\. Move it either way, never remove it/,
  /Risk up to \$17\.50 per counted trade and \$52\.50 across open trades\. 3 missing stops end the run/,/held 5 minutes or more; losses always count\. After a stop-out, that instrument pauses for 10 minutes/,
  /lose \$100\.00 in one day \(from your closed balance at 00:00 UTC\) or drop \$200\.00 below your highest closed balance/])assert.match(all,re,String(re));
 assert.doesNotMatch(all,/under 1 minute|sessions|trading days|profitable days|Daily profit cap|NaN|undefined/i);
});
test('v2 acknowledgement key is separate from v1, stable across live P&L, new for each account, and Stage 4 has no checklist',()=>{
 const s=v2fixture(),key=checklist(s).key;assert.match(key,/^stage-read-iv2:/);
 s.account.equity=4900;s.account.infinity_v2.counted_profit=-50;assert.equal(checklist(s).key,key);
 s.account.id='v2b';assert.notEqual(checklist(s).key,key);
 s.account.infinity_v2.eligible=true;s.account.infinity_v2.identity_required=false;s.account.infinity_v2.n=40;s.account.infinity_v2.score=2;s.account.infinity_v2.combined_score=2.1;s.account.infinity_v2.counted_profit=400;
 assert.equal(checklist(s).ready,true);s.account.infinity_v2.eligible=false;assert.equal(checklist(s).ready,false);
 s.account.stage=4;assert.equal(checklist(s),null);
});
test('v1 accounts keep their existing checklist untouched',()=>{
 const s=fixture();assert.notEqual(s.account.rules_version,'infinity_v2');const c=checklist(s);assert.match(c.key,/^stage-read-v2:/);assert.ok(c.rows.some(r=>r.id==='sessions'));
});
