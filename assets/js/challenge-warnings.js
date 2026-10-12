(function(root){
  'use strict';
  const number=v=>v==null?NaN:Number(v);
  const money=v=>'$'+Math.max(0,v).toFixed(2);
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
      `Your best day contributes ${(best*100).toFixed(1)}% of positive daily profit; the stage limit is ${(bestLimit*100).toFixed(0)}%. ${best>bestLimit?'This requirement is not met yet.':'You are approaching the limit.'} This affects progression, not an automatic account failure.`,false);
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
  root.IPFXRuleWarnings={build,announcement};
})(globalThis);
