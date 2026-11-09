-- Infinity v2: a stop loss can be moved either way (tightened or widened) as long as the trade keeps one.
-- It still cannot be taken off. A widened stop is checked against the per-trade and total open-risk limits, and the
-- trade's recorded initial risk grows to the new stop so the run score and copy checks measure the true risk.
-- Rest of the function is byte-for-byte the live definition (checked 2026-11-09).
CREATE OR REPLACE FUNCTION public.infinity_v2_trade_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.trading_accounts;g public.infinity_v2_groups;root public.trades;p jsonb;scale numeric;mark numeric;eq numeric;
 lim numeric;room numeric;total numeric;margin numeric;group_risk numeric;proposed numeric;other record;r jsonb;widened boolean:=false;wrisk numeric:=0;
begin
 select * into a from public.trading_accounts where id=new.account_id;
 -- A legacy fill already in flight must serialize with a voluntary switch or
 -- restart too. Keep the legacy fast path while new v2 starts are disabled.
 if a.challenge_type='infinity' and (a.rules_version='infinity_v2' or exists(
   select 1 from public.infinity_v2_settings where singleton and infinity_v2_enabled and clock_timestamp()>=cutover_at)) then
   select * into a from public.trading_accounts where id=new.account_id for update;
 end if;
 if new.status='open' and a.access_revoked_reason='voluntary_infinity_v2_restart' then raise exception 'ACCOUNT_FROZEN';end if;
 if a.rules_version is distinct from 'infinity_v2' then return new;end if;
 r:=a.infinity_rules_snapshot;
 if new.parent_trade_id is not null then
   select * into root from public.trades where id=new.parent_trade_id and account_id=a.id;
   if not found or new.status<>'closed' or new.opened_at<>root.opened_at then raise exception 'INVALID_PARTIAL_LINEAGE';end if;
   new.infinity_group_id:=root.infinity_group_id;new.initial_volume:=null;
   new.initial_sl:=null;new.initial_sl_at:=null;new.initial_risk_usd:=null;
   return new;
 end if;
 if tg_op='INSERT' and new.execution_rules_version is distinct from a.rules_version then raise exception 'RULES_CHANGED_REFRESH_REQUIRED';end if;
 if tg_op='UPDATE' and (new.infinity_group_id is distinct from old.infinity_group_id or new.initial_volume is distinct from old.initial_volume
   or new.account_id is distinct from old.account_id or new.open_price is distinct from old.open_price or new.opened_at is distinct from old.opened_at
   or new.symbol is distinct from old.symbol or new.side is distinct from old.side) then raise exception 'OPENING_IDENTITY_IMMUTABLE';end if;
 if new.status<>'open' then return new;end if;
 if a.status<>'active' or a.access_revoked_at is not null then raise exception 'ACCOUNT_FROZEN';end if;
 if tg_op='UPDATE' and new.sl is not distinct from old.sl and new.volume<=old.volume and new.trail_distance is not distinct from old.trail_distance and new.tp is not distinct from old.tp then return new;end if;
 if tg_op='UPDATE' and new.volume>old.volume then raise exception 'POSITION_VOLUME_CANNOT_INCREASE';end if;
 p:=public.infinity_v2_price(new.symbol);
 if p is null or (p->>'spread')::numeric<=0 then raise exception 'LIVE_SPREAD_UNAVAILABLE';end if;
 scale:=public.infinity_v2_usd_scale(new.symbol);
 if scale is null then raise exception 'USD_CONVERSION_UNAVAILABLE';end if;
 mark:=case when new.side='buy' then (p->>'bid')::numeric else (p->>'ask')::numeric end;
 if tg_op='INSERT' then
   if (select count(*) from public.trades where account_id=a.id and status='open')>=(r->>'max_open_positions')::int then raise exception 'MAX_OPEN_POSITIONS';end if;
   if new.infinity_pending_id is null and ((select count(*) from public.trades where account_id=a.id and parent_trade_id is null and infinity_pending_id is null and opened_at between clock_timestamp()-make_interval(secs=>(r->>'order_burst_window_seconds')::int) and clock_timestamp())+
     (select count(*) from public.pending_orders where account_id=a.id and created_at between clock_timestamp()-make_interval(secs=>(r->>'order_burst_window_seconds')::int) and clock_timestamp())) >= (r->>'order_burst_limit')::int then raise exception 'ORDER_BURST_LIMIT';end if;
   if exists(select 1 from public.infinity_v2_pauses where account_id=a.id and symbol=new.symbol and until_at>clock_timestamp()) then raise exception 'STOP_OUT_PAUSE';end if;
   if new.volume<coalesce((p->>'min_lot')::numeric,0.01) or new.volume<>trunc(new.volume/coalesce((p->>'min_lot')::numeric,0.01))*coalesce((p->>'min_lot')::numeric,0.01) then raise exception 'INVALID_LOT_STEP';end if;
   select * into g from public.infinity_v2_groups x where x.account_id=a.id and x.symbol=new.symbol and x.side=new.side
    and (new.opened_at<=x.last_entry+make_interval(secs=>(r->>'group_gap_minutes')::int*60)
       or exists(select 1 from public.trades t where t.infinity_group_id=x.id and t.status='open')) order by x.last_entry desc limit 1;
   if not found then insert into public.infinity_v2_groups(account_id,symbol,side,last_entry) values(a.id,new.symbol,new.side,new.opened_at) returning * into g;
   else update public.infinity_v2_groups set last_entry=greatest(last_entry,new.opened_at) where id=g.id;end if;
   new.infinity_group_id:=g.id;new.initial_volume:=new.volume;
 else
   -- A stop may be moved either way; it just cannot be taken off. A widened stop is re-checked against the per-trade and total risk limits below.
   if old.sl is not null and new.sl is null then raise exception 'STOP_CANNOT_BE_REMOVED';end if;
   widened:=old.sl is not null and ((new.side='buy' and new.sl<old.sl) or (new.side='sell' and new.sl>old.sl));
   if widened then wrisk:=greatest(coalesce(old.initial_risk_usd,0),abs(new.open_price-new.sl)*coalesce(new.initial_volume,new.volume)*scale);end if;
 end if;
 if new.sl is not null and (tg_op='INSERT' or new.sl is distinct from old.sl or new.tp is distinct from old.tp or new.trail_distance is distinct from old.trail_distance) then
   if (case when new.side='buy' then (case when tg_op='INSERT' then new.open_price else mark end)-new.sl
     else new.sl-(case when tg_op='INSERT' then new.open_price else mark end) end) < (p->>'spread')::numeric*(r->>'stop_spread_multiple')::numeric then raise exception 'STOP_TOO_CLOSE';end if;
   if new.initial_sl is null then
     if clock_timestamp()>new.opened_at+make_interval(secs=>(r->>'stop_deadline_seconds')::int) then raise exception 'OPENING_STOP_TOO_LATE';end if;
     new.initial_sl:=new.sl;new.initial_sl_at:=case when tg_op='INSERT' then new.opened_at else clock_timestamp() end;
     new.initial_risk_usd:=abs(new.open_price-new.sl)*new.initial_volume*scale;
   end if;
 end if;
 if new.trail_distance is not null and (tg_op='INSERT' or new.trail_distance is distinct from old.trail_distance)
 and new.trail_distance<(p->>'spread')::numeric*(r->>'stop_spread_multiple')::numeric then raise exception 'TRAIL_TOO_CLOSE';end if;
 if tg_op='UPDATE' and old.initial_sl is not null and not widened then return new;end if;
 eq:=public.fn_infinity_quote_equity(a.id);
 if eq is null then raise exception 'PORTFOLIO_MARK_UNAVAILABLE';end if;
 room:=least((eq-(greatest(coalesce(a.trailing_peak,a.starting_balance),a.balance)-a.starting_balance*a.max_drawdown_pct/100-coalesce(a.total_paid_out,0)))*0.20,
 (eq-(case when a.day_start_date is distinct from (clock_timestamp() at time zone 'UTC')::date then a.balance else a.day_start_equity end-a.starting_balance*a.daily_loss_pct/100))*0.25);
 lim:=round(greatest(0,least(a.starting_balance*(r->>'risk_pct')::numeric/100,room)),2);
 proposed:=case when new.sl is null then lim else greatest(0,case when new.side='buy' then new.open_price-new.sl else new.sl-new.open_price end)*new.volume*scale end;
 margin:=new.open_price*new.volume*scale/100;
 total:=proposed;group_risk:=case when widened then wrisk else coalesce(new.initial_risk_usd,lim) end;
 for other in select t.* from public.trades t where t.account_id=a.id and t.id<>new.id and t.parent_trade_id is null
  and (t.status='open' or t.infinity_group_id=new.infinity_group_id) loop
   if other.infinity_group_id=new.infinity_group_id then group_risk:=group_risk+coalesce(other.initial_risk_usd,lim);end if;
   if other.status='open' then
     scale:=public.infinity_v2_usd_scale(other.symbol);if scale is null then raise exception 'USD_CONVERSION_UNAVAILABLE';end if;
     margin:=margin+other.open_price*other.volume*scale/100;
     total:=total+case when other.sl is null then lim else greatest(0,case when other.side='buy' then other.open_price-other.sl else other.sl-other.open_price end)*other.volume*scale end;
   end if;
 end loop;
 if margin>eq then raise exception 'INSUFFICIENT_MARGIN';end if;
 if proposed>lim+0.000001 or group_risk>lim+0.000001 then raise exception 'COUNTED_TRADE_RISK_LIMIT';end if;
 if total>lim*(r->>'total_risk_multiple')::numeric+0.000001 then raise exception 'TOTAL_OPEN_RISK_LIMIT';end if;
 if widened then new.initial_risk_usd:=wrisk;end if;
 return new;
end $function$;
