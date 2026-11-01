(function(root){
  'use strict';
  const number=v=>v==null?NaN:Number(v);
  const money=v=>'$'+Math.max(0,v).toFixed(2);
  function consistency(state){
    const a=state&&state.account,Q=a&&a.progress&&a.progress.qualification;
    const limit=number(Q&&Q.rules&&Q.rules.max_best_day_share),share=number(Q&&Q.best_day_share);
    if(!Q||!Q.applies||!(limit>0&&limit<1)||!Array.isArray(state.closed_trades))return null;
    const days={};
    for(const t of state.closed_trades){
      const time=Date.parse(t.closed_at),pnl=number(t.pnl);
      if(!Number.isFinite(time)||!Number.isFinite(pnl))continue;
      const day=new Date(time).toISOString().slice(0,10);days[day]=(days[day]||0)+pnl;
    }
    const positive=Object.values(days).filter(v=>v>0),total=positive.reduce((sum,v)=>sum+v,0),best=positive.length?Math.max(...positive):0;
    // Never show an amount from partial history that disagrees with server qualification evidence.
    if(!(total>0)||!Number.isFinite(share)||Math.abs(best/total-share)>0.0001)return null;
    const required=Math.ceil((best/limit-1e-9)*100)/100,remaining=Math.max(0,Math.ceil((required-total-1e-9)*100)/100);
    return {best,total,required,remaining,limit};
  }
  function consistencyText(state){
    const c=consistency(state);if(!c)return '';
    return `Your best day: ${money(c.best)}. Winning-day profit so far: ${money(c.total)}. Required winning-day total at ${(c.limit*100).toFixed(0)}%: ${money(c.required)}. ${c.remaining>0?`Make at least ${money(c.remaining)} more net profit on other UTC days.`:'This consistency requirement is met.'} A new best day raises the required total. Losing days still count against your separate stage profit target; all other rules and daily caps still apply.`;
  }
  function build(state,now){
    const a=state&&state.account;
    if(!a||a.is_demo||a.challenge_type!=='infinity'||a.status!=='active')return [];
    const L=a.limits||{},P=a.progress||{},Q=P.qualification||{},rules=Q.rules||{};
    const warnings=[];
    const add=(code,level,message,notify=true)=>warnings.push({code,level,message,notify});
    const equity=number(a.equity);
    for(const [code,label,floor,allowance] of [
      ['daily-loss','daily loss limit',number(L.daily_floor),number(L.daily_loss_allowance_usd)],
      ['drawdown','trailing drawdown limit',number(L.max_dd_floor),number(L.drawdown_allowance_usd)]
    ]){
      if(!Number.isFinite(equity)||!Number.isFinite(floor)||!(allowance>0))continue;
      const room=equity-floor,remaining=room/allowance;
      if(remaining<=.30)add(code,remaining<=.10?'critical':'warning',
        `${money(room)} left before your ${label}. Touching ${money(floor)} equity ends this run. Stop adding risk; reduce or close exposure. Prices can move before a close completes.`);
    }
    const deadline=number(L.stop_loss_deadline_seconds);
    if(deadline>0){
      const missing=(state.open_trades||[]).filter(t=>!(number(t.sl)>0));
      if(missing.length){
        const remaining=missing.map(t=>deadline-(now-Date.parse(t.opened_at))/1000).filter(Number.isFinite);
        const seconds=remaining.length?Math.max(0,Math.ceil(Math.min(...remaining))):null;
        add('missing-stop',seconds!=null&&seconds<=10?'critical':'warning',
          `${missing.length} open position${missing.length===1?' has':'s have'} no stop-loss. Add a valid stop now${seconds==null?'':` — ${seconds}s until the earliest deadline`}. After ${deadline}s the position is closed, winning profit is removed and one strike is recorded.`);
      }
    }
    const strikes=number(a.sl_strikes),max=number(a.sl_strikes_max);
    if(strikes>0&&max>0)add('stop-strikes',strikes>=max-1?'critical':'warning',
      `Stop-loss strikes: ${strikes}/${max}. ${Math.max(0,max-strikes)} more ends this run. Set a stop on every order. If the run fails, a fresh entry must wait until your next eligible month.`);
    const cap=number(L.daily_profit_cap_usd),gain=number(L.daily_profit_gain_usd);
    if(cap>0&&gain>=cap*.8&&!L.daily_profit_cap_reached)add('profit-cap','warning',
      `${money(Math.max(0,cap-gain))} left before today's ${money(cap)} profit cap pauses new entries until 00:00 UTC. This is not a breach; existing positions remain manageable.`);
    const best=number(Q.best_day_share),bestLimit=number(rules.max_best_day_share);
    if(Q.applies&&bestLimit>0&&Number.isFinite(best)&&best>=bestLimit*.8)add('consistency','reminder',
      `Your best day contributes ${(best*100).toFixed(1)}% of positive daily profit; the stage limit is ${(bestLimit*100).toFixed(0)}%. ${best>bestLimit?'This requirement is not met yet.':'You are approaching the limit.'} This affects progression, not an automatic account failure. ${consistencyText(state)}`,false);
    const days=number(Q.applies?rules.min_trading_days:P.min_trading_days);
    const completed=number(Q.applies?Q.meaningful_days:P.trading_days);
    if(days>0&&completed<days&&number(a.balance)>=number(L.target_balance)&&number(L.target_balance)>0)add('minimum-days','reminder',
      `Profit target reached, but you have ${completed}/${days} qualifying trading days. You must meet all stage requirements before promotion; do not increase risk to rush the stage.`,false);
    const rank={critical:0,warning:1,reminder:2};
    return warnings.sort((x,y)=>rank[x.level]-rank[y.level]);
  }
  // A severity escalation announces immediately. Unchanged conditions cannot
  // repeat on every quote or poll, including after a page refresh.
  function announcement(warnings,accountId,now,seen){
    for(const warning of warnings){
      if(!warning.notify)continue;
      const key=accountId+':'+warning.code+':'+warning.level;
      if(seen[key]!=null&&now-seen[key]<30*60*1000)continue;
      // Space different messages apart; urgent escalation is never delayed.
      if(warning.level!=='critical'&&seen.lastAt!=null&&now-seen.lastAt<10000)continue;
      seen[key]=now;
      seen.lastAt=now;
      return warning;
    }
    return null;
  }
  function checklist(state){
    const a=state&&state.account;
    if(!a||a.is_demo||a.challenge_type!=='infinity'||Number(a.stage)>3)return null;
    // Infinity v2 accounts: their own rows and their own six short "read before trading" lines, all from the account's saved rules.
    if(a.rules_version==='infinity_v2'){
      const Q2=a.infinity_v2||(a.progress&&a.progress.qualification)||{},R2=Q2.rules||{},L2=a.limits||{};
      const start2=number(a.starting_balance),pc=v=>Number(v)+'%',min=v=>Number(v)/60,f1=v=>Number.isInteger(Number(v))?Number(v).toFixed(1):String(Number(v));
      const rows2=[],read2=[],add2=(id,text,done)=>{rows2.push({id,text,done:done===true});};
      const target2=number(Q2.target),profit2=number(Q2.counted_profit),n2=number(Q2.n);
      if(target2>0)add2('target',`Counted profit: ${money(profit2)} / ${money(target2)} target`,profit2>=target2);
      if(number(R2.min_counted_trades)>0)add2('trades',`Counted trades this stage: ${Number.isFinite(n2)?n2:'awaiting verification'} / ${R2.min_counted_trades}`,n2>=number(R2.min_counted_trades));
      if(R2.stage_score!=null)add2('score',`Stage consistency score: ${Number.isFinite(number(Q2.score))?number(Q2.score).toFixed(2):'awaiting verification'} / ${f1(R2.stage_score)}`,number(Q2.score)>=number(R2.stage_score));
      if(R2.combined_score!=null)add2('overall',`Overall consistency score: ${Number.isFinite(number(Q2.combined_score))?number(Q2.combined_score).toFixed(2):'awaiting verification'} / ${f1(R2.combined_score)}`,number(Q2.combined_score)>=number(R2.combined_score));
      if(R2.best_day_share!=null){const best=number(Q2.best_day_share);add2('consistency',`Best-day share: ${Number.isFinite(best)?(best*100).toFixed(1)+'%':'not yet measurable'} / ${(R2.best_day_share*100).toFixed(0)}% maximum`,Number.isFinite(best)&&best<=number(R2.best_day_share));}
      add2('flat',`Open positions: ${(state.open_trades||[]).length} — close all before promotion`,(state.open_trades||[]).length===0&&!(state.pending_orders||[]).length);
      add2('standing',`Account in good standing; stop-loss strikes ${a.sl_strikes??0}/${a.sl_strikes_max??3}`,a.status==='active'&&number(a.sl_strikes??0)<number(a.sl_strikes_max??3));
      if(Q2.identity_required===true)add2('identity','Verify your identity to move up to Stage 3 (you keep trading meanwhile)',false);
      add2('server',Q2.eligible===true?'Server progression checks verified':'Server progression checks still pending',Q2.eligible===true);
      const sc=[R2.stage_score!=null?`a consistency score of ${f1(R2.stage_score)}`:null,R2.combined_score!=null?`an overall score of ${f1(R2.combined_score)}`:null].filter(Boolean).join(' and ');
      if(target2>0)read2.push(`To pass: make ${money(target2)} profit with at least ${R2.min_counted_trades} counted trades${sc?', '+sc:''}${R2.best_day_share!=null?' and no day over '+pc(R2.best_day_share*100)+' of your profit':''}, then close every trade. No minimum days.`);
      read2.push(`A counted trade is one trade, or several on the same instrument and direction within ${R2.group_gap_minutes||15} minutes. They count once and share one risk limit.`);
      const base2=number(L2.base_risk_per_trade_usd)>0?number(L2.base_risk_per_trade_usd):start2*number(R2.risk_pct)/100;
      read2.push(`Every trade needs a stop-loss within ${R2.stop_deadline_seconds||30}s, at least ${R2.stop_spread_multiple||8}× the spread away. Tighten it, never widen or remove it. Risk up to ${money(base2)} per counted trade and ${money(base2*number(R2.total_risk_multiple||3))} across open trades. ${R2.sl_strikes_max||a.sl_strikes_max||3} missing stops end the run.`);
      read2.push(`Profit counts only on trades held ${min(R2.min_hold_seconds||300)} minutes or more; losses always count. After a stop-out, that instrument pauses for ${min(R2.stop_pause_seconds||600)} minutes.`);
      const dl2=number(L2.daily_loss_allowance_usd)>0?number(L2.daily_loss_allowance_usd):start2*number(R2.daily_loss_pct)/100,dd2=number(L2.drawdown_allowance_usd)>0?number(L2.drawdown_allowance_usd):start2*number(R2.max_drawdown_pct)/100;
      read2.push(`The run ends if you lose ${money(dl2)} in one day (from your closed balance at 00:00 UTC) or drop ${money(dd2)} below your highest closed balance. Open trades count. You can restart next month.`);
      read2.push('Trade your own account with your own decisions: no sharing, copying or hedging with others.');
      return {stage:Number(a.stage),rows:rows2,read:read2,key:'stage-read-iv2:'+a.id+':'+JSON.stringify(read2),available:Q2.applies===true&&!!Q2.rules,ready:Q2.applies===true&&Q2.eligible===true&&rows2.every(r=>r.done)};
    }
    const L=a.limits||{},P=a.progress||{},Q=P.qualification||{},R=Q.rules||{};
    const rows=[],read=[],need=[];
    const add=(id,text,done)=>{rows.push({id,text,done:done===true});};
    const target=number(L.target_balance),eligible=number(P.eligible_closed_balance);
    if(target>0){
      add('target',`Eligible closed balance: ${Number.isFinite(eligible)?money(eligible):'awaiting verification'} / ${money(target)} target`,Number.isFinite(eligible)&&eligible>=target);
    }
    if(Q.applies&&Q.rules){
      if(number(R.min_elapsed_days)>0){
        need.push(`${R.min_elapsed_days} days`);
        add('elapsed',`Elapsed calendar days: ${Number.isFinite(number(Q.elapsed_days))?number(Q.elapsed_days).toFixed(1):'awaiting verification'} / ${R.min_elapsed_days}`,number(Q.elapsed_days)>=number(R.min_elapsed_days));
      }
      if(number(R.min_trading_days)>0){
        need.push(`${R.min_trading_days} trading days`);
        add('days',`Qualifying trading days: ${Q.meaningful_days??'awaiting verification'} / ${R.min_trading_days}`,number(Q.meaningful_days)>=number(R.min_trading_days)&&number(P.trading_days)>=number(P.min_trading_days));
      }
      if(number(R.min_sessions)>0){
        need.push(`${R.min_sessions} sessions (trades within an hour of each other count as one)`);
        add('sessions',`Exposure sessions: ${Q.exposure_sessions??'awaiting verification'} / ${R.min_sessions}`,number(Q.exposure_sessions)>=number(R.min_sessions));
      }
      if(number(R.max_best_day_share)>0){
        const best=number(Q.best_day_share),limit=number(R.max_best_day_share)*100;
        need.push(`no single day over ${(number(R.max_best_day_share)*100).toFixed(0)}% of your profit`);
        add('consistency',`Best-day contribution: ${Number.isFinite(best)?(best*100).toFixed(1)+'%':'not yet measurable'} / ${limit.toFixed(0)}% maximum`,Number.isFinite(best)&&best<=number(R.max_best_day_share));
      }
    }else{
      add('qualification','Saved qualification rules unavailable — wait for verification',false);
    }
    if(number(P.min_trades)>0){
      need.push(`${P.min_trades} trades`);
      add('trades',`Qualifying completed trades: ${P.trades_closed??'awaiting verification'} / ${P.min_trades}`,number(P.trades_closed)>=number(P.min_trades));
    }
    if(number(P.min_profitable_days_pct)>0){
      need.push(`${P.min_profitable_days_pct}% of trading days in profit${Number.isFinite(number(P.min_profitable_day_net_usd))?` (over ${money(number(P.min_profitable_day_net_usd))})`:''}`);
      add('profitable',`Qualifying profitable days: ${P.profitable_days_pct??'awaiting verification'}% / ${P.min_profitable_days_pct}% minimum`,number(P.profitable_days_pct)>=number(P.min_profitable_days_pct));
    }
    add('flat',`Open positions: ${(state.open_trades||[]).length} — close all before promotion`,(state.open_trades||[]).length===0);
    add('standing',`Account in good standing; stop-loss strikes ${a.sl_strikes??0}/${a.sl_strikes_max??3}`,a.status==='active'&&number(a.sl_strikes??0)<number(a.sl_strikes_max??3));
    add('server',P.requirements_met===true?'Server progression checks verified':'Server progression checks still pending',P.requirements_met===true);
    // What the trader ticks before trading: five short lines, same rules and numbers (wording only).
    if(target>0)read.push(`To pass: make ${money(target-number(a.starting_balance))} profit${need.length?' with at least '+need.join(', '):''}, then close every trade. Trades held under 1 minute don't count.`);
    const lossBits=[];
    if(number(L.daily_loss_allowance_usd)>0)lossBits.push(`lose ${money(number(L.daily_loss_allowance_usd))} in one day`);
    if(number(L.drawdown_allowance_usd)>0)lossBits.push(`drop ${money(number(L.drawdown_allowance_usd))} below your ${L.drawdown_mode==='trailing_balance'?'highest closed balance':L.drawdown_mode==='trailing_eod'?'highest end-of-day balance':'highest equity'}`);
    if(lossBits.length)read.push(`The run ends if you ${lossBits.join(' or ')} (open trades count). You can restart next month.`);
    const tradeBits=[];
    if(number(L.stop_loss_deadline_seconds)>0)tradeBits.push(`every trade needs a stop-loss within ${L.stop_loss_deadline_seconds}s (the ticket adds it for you; ${a.sl_strikes_max??3} misses end the run)`);
    if(number(L.base_risk_per_trade_usd)>0)tradeBits.push(`risk up to ${money(number(L.base_risk_per_trade_usd))} per trade and ${money(number(L.base_risk_per_trade_usd)*number(L.total_open_risk_multiple??3))} across open trades`);
    if(tradeBits.length)read.push(tradeBits.join('; ').replace(/^./,c=>c.toUpperCase())+'.');
    if(number(L.daily_profit_cap_usd)>0)read.push(`Up ${money(number(L.daily_profit_cap_usd))} in a day? New trades pause until 00:00 UTC. That's not a breach.`);
    read.push('Trade your own account with your own decisions: no sharing, copying or hedging with others.');
    const ready=Q.applies===true&&Q.eligible===true&&rows.every(r=>r.done);
    // Stable saved-rule identity: changing live P&L never resets an acknowledgement.
    const key='stage-read-v2:'+a.id+':'+JSON.stringify(read);
    return {stage:Number(a.stage),rows,read,key,available:Q.applies===true&&!!Q.rules,ready};
  }
  root.IPFXRuleWarnings={build,announcement,checklist,consistency,consistencyText};
})(globalThis);
