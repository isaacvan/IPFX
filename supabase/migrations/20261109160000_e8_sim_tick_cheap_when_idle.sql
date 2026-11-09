-- Disk IO (9 Nov 2026): e8_sim_tick runs every 10 s and had written ~141 GB of temp files. Its candidate query joined
-- every simulated event with its position and an EXISTS over e8_reference_quotes (~115 MB), even when no event was
-- waiting (normally 0). Same logic, two changes:
--  1. the events still waiting for a price are found first (a cheap anti-join on the primary keys); none -> heartbeat
--     and return, no further reads;
--  2. only those few events are joined to positions and reference quotes.
create or replace function public.e8_sim_tick()
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare e record; q public.e8_reference_quotes; n int:=0; waiting int; t timestamptz:=clock_timestamp(); reason text; pending_ids bigint[];
begin
 -- One worker; bounded batch, no network or broker access.
 if not pg_try_advisory_xact_lock(hashtext('e8-sim-tick')) then return jsonb_build_object('busy',true); end if;
 select array_agg(v.id order by v.id) into pending_ids from (
   select v.id from public.e8_sim_events v
    where v.kind in('open','partial','close') and not exists(select 1 from public.e8_sim_prices x where x.event_id=v.id)
    order by v.id limit 1000) v;
 if pending_ids is not null then
  for e in select v.*,p.reference_account_id,p.symbol,p.min_delay_ms,p.max_wait_ms,p.scale_usd
   from public.e8_sim_events v join public.e8_sim_positions p using(trade_id)
   where v.id = any(pending_ids)
   and (p.reference_account_id is null or p.scale_usd is null
    or t>v.event_at+make_interval(secs=>(p.min_delay_ms+p.max_wait_ms)/1000.0)
    or exists(select 1 from public.e8_reference_quotes ready
     where ready.account_id=p.reference_account_id and ready.symbol=p.symbol
      and ready.requested_at>=v.event_at+make_interval(secs=>p.min_delay_ms/1000.0)
      and ready.received_at<=v.event_at+make_interval(secs=>(p.min_delay_ms+p.max_wait_ms)/1000.0)
      and ready.received_at<=t))
   order by v.id loop
   reason:=null;
   if e.reference_account_id is null then reason:='NO_ENABLED_REFERENCE_FOR_SYMBOL';
   elsif e.scale_usd is null then reason:='USD_SCALE_UNVERIFIED'; end if;
   if reason is not null then
    insert into public.e8_sim_prices(event_id,status,reason) values(e.id,'UNAVAILABLE',reason); n:=n+1; continue;
   end if;
   select * into q from public.e8_reference_quotes where account_id=e.reference_account_id and symbol=e.symbol
    and requested_at>=e.event_at+make_interval(secs=>e.min_delay_ms/1000.0)
    and received_at<=e.event_at+make_interval(secs=>(e.min_delay_ms+e.max_wait_ms)/1000.0)
    and received_at<=t order by received_at,id limit 1;
   if found then
    insert into public.e8_sim_prices(event_id,quote_id,status,bid,ask,requested_at,received_at,sampling_wait_ms)
    values(e.id,q.id,'PRICED',q.bid,q.ask,q.requested_at,q.received_at,extract(epoch from q.received_at-e.event_at)*1000);
    n:=n+1;
   elsif t>e.event_at+make_interval(secs=>(e.min_delay_ms+e.max_wait_ms)/1000.0) then
    insert into public.e8_sim_prices(event_id,status,reason) values(e.id,'UNAVAILABLE','REFERENCE_QUOTE_MISSING_WITHIN_WINDOW'); n:=n+1;
   end if;
  end loop;
 end if;
 select count(*) into waiting from public.e8_sim_events pending where kind in('open','partial','close')
  and not exists(select 1 from public.e8_sim_prices x where x.event_id=pending.id);
 insert into public.ab_heartbeats(worker,ok,at,detail) values('e8-simulator',waiting<1000,t,jsonb_build_object('processed',n,'waiting',waiting,'basis','E8_QUOTE_ESTIMATE','fees','UNVERIFIED'))
 on conflict(worker) do update set ok=excluded.ok,at=excluded.at,detail=excluded.detail;
 return jsonb_build_object('processed',n,'waiting',waiting);
end $function$;
