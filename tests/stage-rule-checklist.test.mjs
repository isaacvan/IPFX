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
