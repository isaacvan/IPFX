-- Automatic reference replay, never a broker order or live/classifier evidence.
-- Durable lifecycle evidence survives account/provider reconnects. USD instruments
-- use the frozen IPFX contract size as an explicit model assumption. Unknown E8
-- commission/swap/slippage remain unknown. A 10-second quote sampler is not an
-- execution feed. New trades only; no invented historical opens/backfill.
begin;
alter table public.trades add column if not exists parent_trade_id uuid;
create index if not exists trades_parent_replay on public.trades(parent_trade_id) where parent_trade_id is not null;
create table public.e8_sim_positions (
 trade_id uuid primary key, source_account_id uuid not null, person_id uuid not null,
 reference_account_id bigint, symbol text not null, trader_side text not null check(trader_side in('buy','sell')),
 selected_book text not null check(selected_book in('a','b')), book_state text not null,
 original_lots numeric not null check(original_lots>0), source_size_usd numeric,
 scale_usd numeric, scale_basis text not null, opened_at timestamptz not null,
 is_practice boolean not null, min_delay_ms int not null default 500,
 max_wait_ms int not null default 30000, created_at timestamptz not null default clock_timestamp()
);
create table public.e8_sim_events (
 id bigint generated always as identity primary key, trade_id uuid not null references public.e8_sim_positions,
 source_row_id uuid not null, kind text not null check(kind in('open','amend','quantity','partial','close')),
 event_at timestamptz not null, lots numeric not null check(lots>0),
 source_snapshot jsonb not null, captured_at timestamptz not null default clock_timestamp()
);
create unique index e8_sim_one_fill_event on public.e8_sim_events(source_row_id,kind) where kind in('open','partial','close');
create index e8_sim_events_trade on public.e8_sim_events(trade_id,id);
create table public.e8_sim_prices (
 event_id bigint primary key references public.e8_sim_events,
 quote_id bigint, status text not null check(status in('PRICED','UNAVAILABLE')),
 reason text, bid numeric, ask numeric, requested_at timestamptz, received_at timestamptz,
 sampling_wait_ms numeric, created_at timestamptz not null default clock_timestamp(),
 check((status='PRICED' and bid>0 and ask>=bid and requested_at is not null and received_at>=requested_at)
 or (status='UNAVAILABLE' and reason is not null))
);
create function public.e8_sim_append_only() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'E8 simulator archive is append-only'; end $$;
create trigger e8_sim_positions_immutable before update or delete on public.e8_sim_positions for each row execute function public.e8_sim_append_only();
create trigger e8_sim_events_immutable before update or delete on public.e8_sim_events for each row execute function public.e8_sim_append_only();
create trigger e8_sim_prices_immutable before update or delete on public.e8_sim_prices for each row execute function public.e8_sim_append_only();

create function public.e8_sim_capture() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts; root uuid; ev text; at_time timestamptz;
 ref bigint; who uuid; state text; spec public.symbol_specs; parent public.trades;
begin
 -- Venue-owned/external executions are not IPFX simulation inputs.
 if new.external_source is not null then return new; end if;
 select * into a from public.trading_accounts where id=new.account_id;
 if not found or coalesce(a.venue,'ipfx')<>'ipfx' then return new; end if;
 root:=new.id;
 if tg_op='INSERT' and new.status='open' then
  if new.parent_trade_id is not null then raise exception 'Open trade cannot be a partial slice'; end if;
  who:=public.ab_person_of(new.user_id);
  select book_state into state from public.ab_trader_profiles where person_id=who;
  state:=coalesce(state,'BB_DEMO');
  select p.account_id into ref from public.e8_monitor_profiles p
   join public.ladder_accounts l on l.id=p.account_id and l.role='monitor' and not l.execution_enabled
   where p.enabled and new.symbol=any(p.symbols) order by p.account_id limit 1;
  select * into spec from public.symbol_specs where symbol=new.symbol;
  insert into public.e8_sim_positions(trade_id,source_account_id,person_id,reference_account_id,symbol,trader_side,
   selected_book,book_state,original_lots,source_size_usd,scale_usd,scale_basis,opened_at,is_practice)
  values(new.id,a.id,who,ref,new.symbol,new.side,case when state in('AB_DEMO','AB_LIVE') then 'a' else 'b' end,
   state,new.volume,a.starting_balance,case when spec.quote_currency='USD' and spec.contract_size>0 then spec.contract_size end,
   case when spec.quote_currency='USD' and spec.contract_size>0 then 'IPFX_USD_CONTRACT_ASSUMPTION' else 'USD_SCALE_UNVERIFIED' end,
   new.opened_at,coalesce(a.challenge_type='demo' or a.status='demo',false));
  ev:='open'; at_time:=new.opened_at;
 elsif tg_op='INSERT' and new.status='closed' and new.close_reason='partial' and new.parent_trade_id is not null then
  root:=new.parent_trade_id;
  select * into parent from public.trades where id=root;
  if not found or parent.account_id<>new.account_id or parent.user_id<>new.user_id or parent.symbol<>new.symbol
   or parent.side<>new.side or parent.opened_at<>new.opened_at or parent.open_price<>new.open_price then
   raise exception 'Partial slice does not match its source trade';
  end if;
  ev:='partial'; at_time:=new.closed_at;
 elsif tg_op='UPDATE' and old.status='open' and new.status='closed' then
  ev:='close'; at_time:=new.closed_at;
 elsif tg_op='UPDATE' and old.status='open' and new.status='open' then
  if old.volume is distinct from new.volume then ev:='quantity';
  elsif old.sl is distinct from new.sl or old.tp is distinct from new.tp or old.trail_distance is distinct from new.trail_distance
   or old.open_price is distinct from new.open_price then ev:='amend';
  else return new; end if;
  at_time:=clock_timestamp();
 else return new; end if;
 -- Trades opened before installation have no reliable entry snapshot: do not guess one.
 if not exists(select 1 from public.e8_sim_positions where trade_id=root) then return new; end if;
 insert into public.e8_sim_events(trade_id,source_row_id,kind,event_at,lots,source_snapshot)
 values(root,new.id,ev,at_time,new.volume,jsonb_build_object('status',new.status,'side',new.side,'open_price',new.open_price,
  'close_price',new.close_price,'sl',new.sl,'tp',new.tp,'trail_distance',new.trail_distance,
  'pnl',new.pnl,'commission',new.commission,'financing',new.financing,'close_reason',new.close_reason))
 on conflict do nothing;
 return new;
end $$;
create trigger e8_sim_capture after insert or update on public.trades for each row execute function public.e8_sim_capture();

create function public.e8_sim_tick() returns jsonb language plpgsql security definer set search_path='' as $$
declare e record; q public.e8_reference_quotes; n int:=0; waiting int; t timestamptz:=clock_timestamp(); reason text;
begin
 -- One worker; bounded batch, no network or broker access.
 if not pg_try_advisory_xact_lock(hashtext('e8-sim-tick')) then return jsonb_build_object('busy',true); end if;
 for e in select v.*,p.reference_account_id,p.symbol,p.min_delay_ms,p.max_wait_ms,p.scale_usd
  from public.e8_sim_events v join public.e8_sim_positions p using(trade_id)
  where v.kind in('open','partial','close') and not exists(select 1 from public.e8_sim_prices x where x.event_id=v.id)
  order by v.id limit 1000 loop
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
 select count(*) into waiting from public.e8_sim_events pending where kind in('open','partial','close')
  and not exists(select 1 from public.e8_sim_prices x where x.event_id=pending.id);
 insert into public.ab_heartbeats(worker,ok,at,detail) values('e8-simulator',waiting<1000,t,jsonb_build_object('processed',n,'waiting',waiting,'basis','E8_QUOTE_ESTIMATE','fees','UNVERIFIED'))
 on conflict(worker) do update set ok=excluded.ok,at=excluded.at,detail=excluded.detail;
 return jsonb_build_object('processed',n,'waiting',waiting);
end $$;

create view public.e8_sim_trade_results with(security_invoker=true) as
with entry as (
 select p.*,v.id entry_event_id,x.status entry_status,x.bid entry_bid,x.ask entry_ask,x.received_at entry_quote_at,
  x.reason entry_error,x.sampling_wait_ms entry_wait_ms
 from public.e8_sim_positions p join public.e8_sim_events v on v.trade_id=p.trade_id and v.kind='open'
 left join public.e8_sim_prices x on x.event_id=v.id
), exits as (
 select e.trade_id,count(*) exits,count(*)filter(where x.status='PRICED') priced_exits,
  bool_or(e.kind='close') fully_closed,sum(e.lots) exited_lots,
  min(e.event_at) first_exit_at,max(e.event_at) last_exit_at,
  sum(e.lots*x.bid) bid_lot_sum,sum(e.lots*x.ask) ask_lot_sum,
  sum((e.source_snapshot->>'pnl')::numeric) source_pnl_usd,
  max(x.sampling_wait_ms) max_exit_wait_ms,
  jsonb_agg(jsonb_build_object('event_id',e.id,'kind',e.kind,'lots',e.lots,'event_at',e.event_at,
   'quote_at',x.received_at,'bid',x.bid,'ask',x.ask,'status',x.status,'reason',x.reason) order by e.id) exit_detail
 from public.e8_sim_events e left join public.e8_sim_prices x on x.event_id=e.id
 where e.kind in('partial','close') group by e.trade_id
), valid as (
 select p.*,coalesce(e.fully_closed,false) fully_closed,e.exited_lots,e.source_pnl_usd,e.last_exit_at,e.max_exit_wait_ms,e.exit_detail,
  p.entry_status='PRICED' and e.exits=e.priced_exits and p.entry_quote_at<e.first_exit_at and
   e.exited_lots<=p.original_lots+0.000000001 and (not e.fully_closed or abs(e.exited_lots-p.original_lots)<=0.000000001) as valid_priced,
  abs(e.exited_lots-p.original_lots)<=0.000000001 as quantity_complete,
  e.first_exit_at,e.exits,e.priced_exits,e.bid_lot_sum,e.ask_lot_sum
 from entry p left join exits e on e.trade_id=p.trade_id
), totals as (
 select v.*,
 case when valid_priced then scale_usd*case when trader_side='buy' then bid_lot_sum-entry_ask*exited_lots
  else entry_bid*exited_lots-ask_lot_sum end end same_gross_usd,
 case when valid_priced then scale_usd*case when trader_side='buy' then entry_bid*exited_lots-ask_lot_sum
  else bid_lot_sum-entry_ask*exited_lots end end reverse_gross_usd
 from valid v
)
select trade_id,source_account_id,person_id,reference_account_id,symbol,trader_side,selected_book,book_state,is_practice,
 original_lots,exited_lots,opened_at,last_exit_at,entry_bid,entry_ask,entry_quote_at,entry_wait_ms,max_exit_wait_ms,
 source_pnl_usd,scale_usd,scale_basis,same_gross_usd,reverse_gross_usd,
 case when selected_book='b' then reverse_gross_usd else same_gross_usd end selected_gross_usd,
 case when source_size_usd>0 then (case when selected_book='b' then reverse_gross_usd else same_gross_usd end)*50000/source_size_usd end selected_gross_50k_usd,
 null::numeric net_usd,'UNVERIFIED_FEES_SWAP_AND_SLIPPAGE'::text net_status,
 'E8_OBSERVED_QUOTE_ESTIMATE_NOT_BROKER_EXECUTION'::text basis,
 case when entry_status='UNAVAILABLE' then entry_error when fully_closed and not quantity_complete then 'QUANTITY_MISMATCH'
  when entry_quote_at>=first_exit_at then 'ENTRY_OBSERVATION_AFTER_EXIT'
  when priced_exits<exits and exists(select 1 from public.e8_sim_prices p join public.e8_sim_events e on e.id=p.event_id where e.trade_id=totals.trade_id and p.status='UNAVAILABLE') then 'EXIT_REFERENCE_UNAVAILABLE'
  when fully_closed and valid_priced and quantity_complete then 'CLOSED_GROSS_ESTIMATE'
  when valid_priced then 'PARTIALLY_CLOSED_GROSS_ESTIMATE' when entry_status='PRICED' and exits is null then 'OPEN_REFERENCE_ESTIMATE'
  else 'AWAITING_REFERENCE' end status,
 exit_detail
from totals;

create function public.e8_sim_summary() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('basis','E8_OBSERVED_QUOTE_ESTIMATE_NOT_BROKER_EXECUTION','net_status','UNVERIFIED_FEES_SWAP_AND_SLIPPAGE',
 'positions',(select count(*) from public.e8_sim_positions),'events',(select count(*) from public.e8_sim_events),
 'status_counts',(select coalesce(jsonb_object_agg(status,n),'{}') from(select status,count(*) n from public.e8_sim_trade_results group by status)s),
 'recent',coalesce((select jsonb_agg(x) from(select * from public.e8_sim_trade_results order by opened_at desc limit 50)x),'[]'));
$$;
alter table public.e8_sim_positions enable row level security;
alter table public.e8_sim_events enable row level security;
alter table public.e8_sim_prices enable row level security;
revoke all on public.e8_sim_positions,public.e8_sim_events,public.e8_sim_prices,public.e8_sim_trade_results from public,anon,authenticated;
grant select,insert on public.e8_sim_positions,public.e8_sim_events,public.e8_sim_prices to service_role;
grant select on public.e8_sim_trade_results to service_role;
grant usage,select on sequence public.e8_sim_events_id_seq to service_role;
revoke all on function public.e8_sim_capture(),public.e8_sim_tick(),public.e8_sim_summary(),public.e8_sim_append_only() from public,anon,authenticated;
grant execute on function public.e8_sim_tick(),public.e8_sim_summary() to service_role;
select cron.schedule('ipfx-e8-simulator','10 seconds','select public.e8_sim_tick();');
commit;
