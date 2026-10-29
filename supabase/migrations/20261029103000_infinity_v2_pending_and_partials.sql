begin;
insert into public.infinity_v2_pricing_profiles(symbol) select symbol from public.symbol_specs where symbol is not null on conflict(symbol) do nothing;
create function public.infinity_v2_pending_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts;p jsonb;mark numeric;
begin
 select * into a from public.trading_accounts where id=new.account_id;
 if a.challenge_type='infinity' and (a.rules_version='infinity_v2' or exists(
   select 1 from public.infinity_v2_settings where singleton and infinity_v2_enabled and clock_timestamp()>=cutover_at)) then
   select * into a from public.trading_accounts where id=new.account_id for update;
 end if;
 if new.status='pending' and a.access_revoked_reason='voluntary_infinity_v2_restart' then raise exception 'ACCOUNT_FROZEN';end if;
 if a.rules_version is distinct from 'infinity_v2' or new.status<>'pending' then return new;end if;
 if a.status<>'active' or a.access_revoked_at is not null then raise exception 'ACCOUNT_FROZEN';end if;
 if tg_op='INSERT' then
 if (select count(*) from public.pending_orders where account_id=a.id and status='pending')>=(a.infinity_rules_snapshot->>'max_pending_orders')::int then raise exception 'MAX_PENDING_ORDERS';end if;
 if ((select count(*) from public.trades where account_id=a.id and parent_trade_id is null and infinity_pending_id is null and opened_at between clock_timestamp()-make_interval(secs=>(a.infinity_rules_snapshot->>'order_burst_window_seconds')::int) and clock_timestamp())+
 (select count(*) from public.pending_orders where account_id=a.id and created_at between clock_timestamp()-make_interval(secs=>(a.infinity_rules_snapshot->>'order_burst_window_seconds')::int) and clock_timestamp()))>=(a.infinity_rules_snapshot->>'order_burst_limit')::int then raise exception 'ORDER_BURST_LIMIT';end if;
 end if;
 if exists(select 1 from public.infinity_v2_pauses where account_id=a.id and symbol=new.symbol and until_at>clock_timestamp()) then raise exception 'STOP_OUT_PAUSE';end if;
 p:=public.infinity_v2_price(new.symbol);
 if p is null then raise exception 'LIVE_SPREAD_UNAVAILABLE';end if;
 if new.sl is not null and (case when new.side='buy' then new.trigger_price-new.sl else new.sl-new.trigger_price end)<(p->>'spread')::numeric*(a.infinity_rules_snapshot->>'stop_spread_multiple')::numeric then raise exception 'STOP_TOO_CLOSE';end if;
 if new.volume<coalesce((p->>'min_lot')::numeric,.01) or new.volume<>trunc(new.volume/coalesce((p->>'min_lot')::numeric,.01))*coalesce((p->>'min_lot')::numeric,.01) then raise exception 'INVALID_LOT_STEP';end if;
 return new;
end $$;
create trigger z_infinity_v2_pending_guard before insert or update on public.pending_orders for each row execute function public.infinity_v2_pending_guard();
revoke all on function public.infinity_v2_pending_guard() from public,anon,authenticated;

do $partial$
declare src text;needle text;
begin
 select pg_get_functiondef('public.fn_commit_ipfx_partial(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,boolean,numeric,numeric,uuid)'::regprocedure) into src;
 insert into public.infinity_v2_legacy_definitions values('public.fn_commit_ipfx_partial',src);
 if position('round(t.volume-p_volume,2)' in src)=0 or position('p_volume<0.01' in src)=0 then raise exception 'V2_PARTIAL_SOURCE_DRIFT';end if;
 execute replace(src,'FUNCTION public.fn_commit_ipfx_partial(','FUNCTION public.fn_commit_ipfx_partial_v1(');
 src:=replace(src,'FUNCTION public.fn_commit_ipfx_partial(','FUNCTION public.fn_commit_ipfx_partial_v2(');
 src:=replace(src,'declare t public.trades;','declare minimum numeric; t public.trades;');
 src:=replace(src,'begin','begin'||chr(10)||' select coalesce(p.min_lot,.01) into minimum from public.trades source_trade left join public.infinity_v2_pricing_profiles p on p.symbol=source_trade.symbol where source_trade.id=p_trade_id;');
 src:=replace(src,'p_volume<0.01','p_volume<minimum');src:=replace(src,'p_volume<>round(p_volume,2)','p_volume<>trunc(p_volume/minimum)*minimum');
 src:=replace(src,'round(t.volume-p_volume,2)','round(t.volume-p_volume,3)');src:=replace(src,'<0.01','<minimum');
 execute src;
end $partial$;
create or replace function public.fn_commit_ipfx_partial(p_trade_id uuid,p_account_id uuid,p_user_id uuid,p_expected_volume numeric,p_expected_open_price numeric,
 p_volume numeric,p_exit numeric,p_pnl numeric,p_costs_enabled boolean,p_commission numeric,p_shortfall numeric,p_slice_id uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.trading_accounts where id=p_account_id and rules_version='infinity_v2') then
 return public.fn_commit_ipfx_partial_v2(p_trade_id,p_account_id,p_user_id,p_expected_volume,p_expected_open_price,p_volume,p_exit,p_pnl,p_costs_enabled,p_commission,p_shortfall,p_slice_id);
 end if;
 return public.fn_commit_ipfx_partial_v1(p_trade_id,p_account_id,p_user_id,p_expected_volume,p_expected_open_price,p_volume,p_exit,p_pnl,p_costs_enabled,p_commission,p_shortfall,p_slice_id);
end $$;
revoke all on function public.fn_commit_ipfx_partial(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,boolean,numeric,numeric,uuid),
public.fn_commit_ipfx_partial_v2(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,boolean,numeric,numeric,uuid),
public.fn_commit_ipfx_partial_v1(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,boolean,numeric,numeric,uuid) from public,anon,authenticated;
grant execute on function public.fn_commit_ipfx_partial(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,boolean,numeric,numeric,uuid) to service_role;
commit;
