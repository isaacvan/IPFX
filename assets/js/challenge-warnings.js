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
    const L=a.limits||{},P=a.progress||{},Q=P.qualification||{},R=Q.rules||{};
    const rows=[],read=[];
    const add=(id,text,done)=>{rows.push({id,text,done:done===true});};
    const target=number(L.target_balance),eligible=number(P.eligible_closed_balance);
    if(target>0){
      add('target',`Eligible closed balance: ${Number.isFinite(eligible)?money(eligible):'awaiting verification'} / ${money(target)} target`,Number.isFinite(eligible)&&eligible>=target);
      read.push(`Reach ${money(target-number(a.starting_balance))} eligible net closed profit. Winning trades held under 60 seconds do not count; losses still count.`);
    }
    if(Q.applies&&Q.rules){
      if(number(R.min_elapsed_days)>0){
        add('elapsed',`Elapsed calendar days: ${Number.isFinite(number(Q.elapsed_days))?number(Q.elapsed_days).toFixed(1):'awaiting verification'} / ${R.min_elapsed_days}`,number(Q.elapsed_days)>=number(R.min_elapsed_days));
        read.push(`Complete at least ${R.min_elapsed_days} elapsed calendar days in this stage.`);
      }
      if(number(R.min_trading_days)>0){
        add('days',`Qualifying trading days: ${Q.meaningful_days??'awaiting verification'} / ${R.min_trading_days}`,number(Q.meaningful_days)>=number(R.min_trading_days)&&number(P.trading_days)>=number(P.min_trading_days));
        read.push(`Trade on at least ${R.min_trading_days} qualifying days. Several trades in one day do not create extra trading days.`);
      }
      if(number(R.min_sessions)>0){
        add('sessions',`Exposure sessions: ${Q.exposure_sessions??'awaiting verification'} / ${R.min_sessions}`,number(Q.exposure_sessions)>=number(R.min_sessions));
        read.push(`Complete ${R.min_sessions} exposure sessions. Overlapping positions count together; a new session starts after being flat for more than ${R.session_flat_gap_minutes??60} minutes.`);
      }
      if(number(R.max_best_day_share)>0){
        const best=number(Q.best_day_share),limit=number(R.max_best_day_share)*100;
        add('consistency',`Best-day contribution: ${Number.isFinite(best)?(best*100).toFixed(1)+'%':'not yet measurable'} / ${limit.toFixed(0)}% maximum`,Number.isFinite(best)&&best<=number(R.max_best_day_share));
        read.push(`Keep your best day at or below ${limit.toFixed(0)}% of total positive daily profit.`);
      }
    }else{
      add('qualification','Saved qualification rules unavailable — wait for verification',false);
    }
    if(number(P.min_trades)>0){
      add('trades',`Qualifying completed trades: ${P.trades_closed??'awaiting verification'} / ${P.min_trades}`,number(P.trades_closed)>=number(P.min_trades));
      read.push(`Complete ${P.min_trades} qualifying trades, held at least 60 seconds. Partial closes do not create extra counted trades.`);
    }
    if(number(P.min_profitable_days_pct)>0){
      add('profitable',`Qualifying profitable days: ${P.profitable_days_pct??'awaiting verification'}% / ${P.min_profitable_days_pct}% minimum`,number(P.profitable_days_pct)>=number(P.min_profitable_days_pct));
      read.push(`At least ${P.min_profitable_days_pct}% of your trading days must qualify as profitable${Number.isFinite(number(P.min_profitable_day_net_usd))?` with net closed profit above ${money(number(P.min_profitable_day_net_usd))}`:''}.`);
    }
    add('flat',`Open positions: ${(state.open_trades||[]).length} — close all before promotion`,(state.open_trades||[]).length===0);
    read.push('Close all open positions before promotion. Reaching the profit target alone does not pass the stage.');
    add('standing',`Account in good standing; stop-loss strikes ${a.sl_strikes??0}/${a.sl_strikes_max??3}`,a.status==='active'&&number(a.sl_strikes??0)<number(a.sl_strikes_max??3));
    if(number(L.daily_loss_allowance_usd)>0)read.push(`Daily loss allowance: ${money(number(L.daily_loss_allowance_usd))}. Equity touching the loss floor ends this run, including floating losses.`);
    if(number(L.drawdown_allowance_usd)>0)read.push(`Drawdown allowance: ${money(number(L.drawdown_allowance_usd))}. ${L.drawdown_mode==='trailing_eod'?'The peak updates at the end of the UTC day.':'The trailing peak can rise intraday.'} Watch the live floor.`);
    if(number(L.base_risk_per_trade_usd)>0)read.push(`Base risk per trade: ${money(number(L.base_risk_per_trade_usd))}; your current limit can be lower as loss room is used. Total open risk must not exceed ${L.total_open_risk_multiple??3} times the current per-trade limit.`);
    if(number(L.stop_loss_deadline_seconds)>0)read.push(`Set a stop-loss on every position within ${L.stop_loss_deadline_seconds} seconds. A missed deadline closes it and records a strike; ${a.sl_strikes_max??3} strikes end the run.`);
    if(number(L.daily_profit_cap_usd)>0)read.push(`At ${money(number(L.daily_profit_cap_usd))} daily gain, new entries pause until 00:00 UTC. Existing positions can close above the cap; this is not a breach.`);
    read.push('Make your own trading decisions. Do not share accounts, copy between participants or coordinate opposing positions to game the challenge.');
    read.push('A failed run cannot be restarted until the next eligible month. These acknowledgements do not change or replace your accepted rules.');
    add('server',P.requirements_met===true?'Server progression checks verified':'Server progression checks still pending',P.requirements_met===true);
    const ready=Q.applies===true&&Q.eligible===true&&rows.every(r=>r.done);
    // Stable saved-rule identity: changing live P&L never resets an acknowledgement.
    const key='stage-read-v1:'+a.id+':'+JSON.stringify(read);
    return {stage:Number(a.stage),rows,read,key,available:Q.applies===true&&!!Q.rules,ready};
  }
  root.IPFXRuleWarnings={build,announcement,checklist,consistency,consistencyText};
})(globalThis);
