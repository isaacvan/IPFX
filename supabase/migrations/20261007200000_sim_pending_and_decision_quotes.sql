-- Two distinct bases: exact IPFX server decision quotes and sampled E8 quotes.
-- Neither is an actual reverse broker fill. No execution/routing/policy changes.
begin;
create table public.ipfx_sim_pending_events (
 id bigint generated always as identity primary key,
 order_id uuid not null, source_account_id uuid not null, person_id uuid not null,
 kind text not null check(kind in('observed','created','amended','filled','cancelled','rejected','expired','deleted','linked')),
 status text not null, captured_at timestamptz not null default clock_timestamp(),
 snapshot jsonb not null
);
create index ipfx_sim_pending_order on public.ipfx_sim_pending_events(order_id,id desc);
create index ipfx_sim_pending_recent on public.ipfx_sim_pending_events(id desc);
create trigger ipfx_sim_pending_immutable before update or delete on public.ipfx_sim_pending_events
 for each row execute function public.e8_sim_append_only();
create function public.ipfx_sim_pending_capture() returns trigger language plpgsql security definer set search_path='' as $$
declare r public.pending_orders; a public.trading_accounts; k text;
begin
 if tg_op='DELETE' then r:=old; else r:=new; end if;
 select * into a from public.trading_accounts where id=r.account_id;
 if not found or coalesce(a.venue,'ipfx')<>'ipfx' then
  if tg_op='DELETE' then return old; else return new; end if;
 end if;
 if tg_op='INSERT' then k:='created';
 elsif tg_op='DELETE' then k:='deleted';
 elsif old.status is distinct from new.status then k:=case when new.status='pending' then 'amended' else new.status end;
 elsif old.filled_trade_id is distinct from new.filled_trade_id then k:='linked';
 elsif to_jsonb(old) is distinct from to_jsonb(new) then k:='amended';
 else return new; end if;
 insert into public.ipfx_sim_pending_events(order_id,source_account_id,person_id,kind,status,snapshot)
 values(r.id,r.account_id,public.ab_person_of(r.user_id),k,case when tg_op='DELETE' then 'deleted' else r.status end,
  jsonb_build_object('symbol',r.symbol,'side',r.side,'order_type',r.order_type,'volume',r.volume,
   'trigger_price',r.trigger_price,'sl',r.sl,'tp',r.tp,'expires_at',r.expires_at,'created_at',r.created_at,
   'resolved_at',r.resolved_at,'filled_trade_id',r.filled_trade_id,'fill_price',r.fill_price,'reject_reason',r.reject_reason,
   'source_trade_confirmed',exists(select 1 from public.trades t where t.id=r.filled_trade_id and t.account_id=r.account_id
    and t.user_id=r.user_id and t.symbol=r.symbol and t.side=r.side and t.external_source is null),
   'oco_group',to_jsonb(r)->'oco_group'));
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
create trigger ipfx_sim_pending_capture after insert or update or delete on public.pending_orders
 for each row execute function public.ipfx_sim_pending_capture();
-- Current state derives from the latest event; cancellation/removal never deletes evidence.
-- A claimed fill without a linked trade is not declared an executed position.
create view public.ipfx_sim_pending_state with(security_invoker=true) as
 select distinct on(order_id) order_id,source_account_id,person_id,kind,status,captured_at,snapshot,
  case when status='pending' then 'RESTING'
   when status='filled' and (snapshot->>'filled_trade_id' is null or not coalesce((snapshot->>'source_trade_confirmed')::boolean,false)) then 'FILL_LINK_UNCONFIRMED'
   when status='filled' then 'LINKED_SOURCE_TRADE'
   else 'REMOVED_FROM_ACTIVE' end tracking_status
 from public.ipfx_sim_pending_events order by order_id,id desc;

create table public.ipfx_sim_decision_quotes (
 audit_id bigint primary key, trade_id uuid not null, source_row_id uuid not null,
 kind text not null check(kind in('open','partial','close')), source_account_id uuid not null,
 symbol text not null, side text not null, lots numeric, bid numeric, ask numeric,
 fill_price numeric, quote_ts timestamptz, server_ts timestamptz, source_id text,
 captured_at timestamptz not null default clock_timestamp()
);
create index ipfx_sim_decision_trade on public.ipfx_sim_decision_quotes(trade_id,kind,source_row_id);
create trigger ipfx_sim_decision_immutable before update or delete on public.ipfx_sim_decision_quotes
 for each row execute function public.e8_sim_append_only();
create function public.ipfx_sim_decision_capture() returns trigger language plpgsql security definer set search_path='' as $$
declare t public.trades; p public.e8_sim_positions; root uuid; k text;
begin
 if new.event not in('open','partial_close','close') or new.trade_id is null then return new; end if;
 select * into t from public.trades where id=new.trade_id;
 if not found or t.account_id<>new.account_id or t.user_id<>new.user_id or t.symbol<>new.symbol or t.side<>new.side then return new; end if;
 root:=coalesce(t.parent_trade_id,t.id);
 select * into p from public.e8_sim_positions where trade_id=root;
 if not found then return new; end if;
 k:=case when new.event='partial_close' then 'partial' else new.event end;
 insert into public.ipfx_sim_decision_quotes(audit_id,trade_id,source_row_id,kind,source_account_id,
  symbol,side,lots,bid,ask,fill_price,quote_ts,server_ts,source_id)
 values(new.id,root,t.id,k,t.account_id,t.symbol,t.side,new.requested_volume,new.bid,new.ask,
  new.fill_price,new.quote_ts,new.server_ts,new.source_id);
 return new;
end $$;
create trigger ipfx_sim_decision_capture after insert on public.order_audit_events
 for each row execute function public.ipfx_sim_decision_capture();

create view public.ipfx_sim_decision_results with(security_invoker=true) as
with matched as (
 select e.*,p.original_lots,p.scale_usd,p.trader_side,p.selected_book,
  count(q.audit_id) matches,
  bool_and(q.bid>0 and q.ask>=q.bid and q.ask::text not in('NaN','Infinity','-Infinity')
   and q.bid::text not in('NaN','Infinity','-Infinity') and q.lots=e.lots) valid_quote,
  min(q.bid) bid,min(q.ask) ask
 from public.e8_sim_events e join public.e8_sim_positions p using(trade_id)
 left join public.ipfx_sim_decision_quotes q on q.trade_id=e.trade_id and q.source_row_id=e.source_row_id and q.kind=e.kind
 where e.kind in('open','partial','close')
 group by e.id,p.original_lots,p.scale_usd,p.trader_side,p.selected_book
), totals as (
 select trade_id,max(original_lots) original_lots,max(scale_usd) scale_usd,max(trader_side) trader_side,max(selected_book) selected_book,
  count(*) filter(where kind='open') entries,
  bool_and(matches=1 and coalesce(valid_quote,false)) all_valid,
  bool_or(matches>1) ambiguous,bool_or(matches=0) missing,
  bool_or(kind='close') fully_closed,
  coalesce(sum(lots) filter(where kind<>'open'),0) exited_lots,
  max(bid) filter(where kind='open') entry_bid,max(ask) filter(where kind='open') entry_ask,
  sum(lots*bid) filter(where kind<>'open') exit_bid_lots,sum(lots*ask) filter(where kind<>'open') exit_ask_lots
 from matched group by trade_id
), priced as (
 select *, all_valid and entries=1 and scale_usd>0 and exited_lots<=original_lots
  and (not fully_closed or exited_lots=original_lots) usable from totals
), gross as (
 select *,case when usable and exited_lots>0 then scale_usd*case when trader_side='buy'
  then exit_bid_lots-entry_ask*exited_lots else entry_bid*exited_lots-exit_ask_lots end end same_gross_usd,
 case when usable and exited_lots>0 then scale_usd*case when trader_side='buy'
  then entry_bid*exited_lots-exit_ask_lots else exit_bid_lots-entry_ask*exited_lots end end reverse_gross_usd
 from priced
)
select trade_id,entry_bid,entry_ask,original_lots,exited_lots,same_gross_usd,reverse_gross_usd,
 case when selected_book='b' then reverse_gross_usd else same_gross_usd end selected_gross_usd,
 case when exited_lots>original_lots or (fully_closed and exited_lots<>original_lots) then 'QUANTITY_MISMATCH'
  when scale_usd is null then 'USD_SCALE_UNVERIFIED' when ambiguous then 'AMBIGUOUS_DECISION_QUOTES'
  when missing then 'DECISION_QUOTE_MISSING' when not all_valid then 'DECISION_QUOTE_INVALID'
  when fully_closed and usable then 'CLOSED_DECISION_GROSS_ESTIMATE'
  when usable and exited_lots>0 then 'PARTIAL_DECISION_GROSS_ESTIMATE'
  when usable then 'OPEN_DECISION_ESTIMATE' else 'DECISION_UNAVAILABLE' end status,
 'IPFX_SERVER_DECISION_QUOTE_ZERO_DELAY_ESTIMATE_NOT_E8_FILL'::text basis,
 null::numeric net_usd,'UNVERIFIED_FEES_SWAP_AND_SLIPPAGE'::text net_status
from gross;

create or replace function public.e8_sim_summary() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('basis','E8_OBSERVED_QUOTE_ESTIMATE_NOT_BROKER_EXECUTION','net_status','UNVERIFIED_FEES_SWAP_AND_SLIPPAGE',
 'positions',(select count(*) from public.e8_sim_positions),'events',(select count(*) from public.e8_sim_events),
 'status_counts',(select coalesce(jsonb_object_agg(status,n),'{}') from(select status,count(*) n from public.e8_sim_trade_results group by status)s),
 'recent',coalesce((select jsonb_agg(x) from(select r.*,d.status decision_status,d.selected_gross_usd decision_gross_usd,d.entry_bid decision_bid,d.entry_ask decision_ask
  from public.e8_sim_trade_results r left join public.ipfx_sim_decision_results d using(trade_id) order by opened_at desc limit 50)x),'[]'),
 'pending_recent',coalesce((select jsonb_agg(x) from(select * from public.ipfx_sim_pending_state order by captured_at desc limit 50)x),'[]'),
 'pending_active',(select count(*) from public.ipfx_sim_pending_state where status='pending'),
 'pending_unconfirmed',(select count(*) from public.ipfx_sim_pending_state where tracking_status='FILL_LINK_UNCONFIRMED'));
$$;
alter table public.ipfx_sim_pending_events enable row level security;
alter table public.ipfx_sim_decision_quotes enable row level security;
revoke all on public.ipfx_sim_pending_events,public.ipfx_sim_pending_state,public.ipfx_sim_decision_quotes,public.ipfx_sim_decision_results from public,anon,authenticated;
grant select,insert on public.ipfx_sim_pending_events,public.ipfx_sim_decision_quotes to service_role;
grant select on public.ipfx_sim_pending_state,public.ipfx_sim_decision_results to service_role;
grant usage,select on sequence public.ipfx_sim_pending_events_id_seq to service_role;
revoke all on function public.ipfx_sim_pending_capture(),public.ipfx_sim_decision_capture() from public,anon,authenticated;
-- Observe currently resting orders at installation, without inventing their earlier history.
insert into public.ipfx_sim_pending_events(order_id,source_account_id,person_id,kind,status,snapshot)
select r.id,r.account_id,public.ab_person_of(r.user_id),'observed',r.status,
 jsonb_build_object('symbol',r.symbol,'side',r.side,'order_type',r.order_type,'volume',r.volume,
 'trigger_price',r.trigger_price,'sl',r.sl,'tp',r.tp,'expires_at',r.expires_at,'created_at',r.created_at,
 'filled_trade_id',r.filled_trade_id,'fill_price',r.fill_price,'oco_group',to_jsonb(r)->'oco_group')
from public.pending_orders r join public.trading_accounts a on a.id=r.account_id
where r.status='pending' and coalesce(a.venue,'ipfx')='ipfx';
-- Old decision quotes/events are not invented. No additional quote API calls.
commit;
