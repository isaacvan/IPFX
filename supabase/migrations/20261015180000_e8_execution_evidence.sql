-- Additive evidence only: no routing, execution enablement, balances or classifier policy changes.
begin;
alter table public.e8_reference_quotes add column if not exists instrument_id text;
alter table public.e8_reference_quotes add column if not exists route_id bigint;
alter table public.e8_reference_quotes add column if not exists request_duration_ms numeric;
create table public.e8_event_quote_demands(
 demand_id bigint generated always as identity primary key,event_id bigint unique references public.e8_sim_events(id),pending_event_id bigint unique references public.ipfx_sim_pending_events(id),
 account_id bigint not null references public.e8_monitor_profiles(account_id),
 symbol text not null,event_at timestamptz not null,kind text not null,captured_at timestamptz not null default clock_timestamp(),
 decision_quote_id bigint references public.e8_reference_quotes(id) on delete set null,observed_quote_id bigint references public.e8_reference_quotes(id) on delete set null,
 decision_quote jsonb,observed_quote jsonb,check((event_id is null)<>(pending_event_id is null))
);
create index e8_event_quote_waiting on public.e8_event_quote_demands(account_id,symbol,event_at) where observed_quote is null;
create index e8_event_quote_recent on public.e8_event_quote_demands(captured_at desc);
create index if not exists e8_sim_events_recent on public.e8_sim_events(captured_at desc);
create index if not exists e8_pending_events_recent on public.ipfx_sim_pending_events(captured_at desc);
create table public.e8_event_quote_wakeups(account_id bigint primary key references public.e8_monitor_profiles,last_at timestamptz not null);
create table public.e8_dispatch_evidence(
 operation_id bigint primary key references public.book_orders(id),account_id bigint references public.ladder_accounts(id),
 sent_at timestamptz not null,ack_at timestamptz,ack_ms numeric,receipt_lookup_ms numeric,
 -- Logical quote ID plus immutable snapshot: short-term quote retention must not mutate the dispatch journal.
 quote_id bigint,quote_snapshot jsonb,fill_price numeric,fill_qty numeric,fill_confirmed boolean not null,
 created_at timestamptz not null default clock_timestamp(),
 check(ack_at is null or ack_at>=sent_at),check(ack_ms is null or ack_ms>=0),check(receipt_lookup_ms is null or receipt_lookup_ms>=0),
 check(fill_price is null or fill_price>0),check(fill_qty is null or fill_qty>0)
);
create table public.e8_position_receipts(
 id uuid primary key default gen_random_uuid(),account_id bigint not null references public.ladder_accounts(id),
 position_id text not null,opening_order_id text not null,closing_order_ids text[] not null,
 quantity numeric not null check(quantity>0),gross numeric not null,net numeric not null,
 signed_fee numeric not null,signed_commission numeric,signed_swap numeric not null,fee_includes_commission boolean not null,
 actor_id uuid not null,evidence_note text not null,content_fingerprint text not null,
 basis text not null default 'OWNER_REVIEWED_POSITION_RECEIPT' check(basis='OWNER_REVIEWED_POSITION_RECEIPT'),
 statement_authenticated boolean not null default false check(not statement_authenticated),
 created_at timestamptz not null default clock_timestamp(),unique(account_id,position_id,content_fingerprint)
);
create index e8_receipts_recent on public.e8_position_receipts(created_at desc);
create index if not exists e8_cost_fill_position on public.cost_fills(account_id,(raw->>'positionId'));
create function public.e8_demand_capture() returns trigger language plpgsql security definer set search_path='' as $$
declare p public.e8_sim_positions; q bigint;t timestamptz:=clock_timestamp();w bigint;
begin
 select * into p from public.e8_sim_positions where trade_id=new.trade_id;
 if p.reference_account_id is null or not exists(select 1 from public.e8_monitor_profiles where account_id=p.reference_account_id and enabled) then return new;end if;
 select id into q from public.e8_reference_quotes where account_id=p.reference_account_id and symbol=p.symbol
  and received_at<=new.event_at and received_at>=new.event_at-interval '1 second' order by received_at desc,id desc limit 1;
 insert into public.e8_event_quote_demands(event_id,account_id,symbol,event_at,kind,decision_quote_id,decision_quote)
 values(new.id,p.reference_account_id,p.symbol,new.event_at,case when new.source_snapshot->>'phase'='close_intent' then 'close_intent' else new.kind end,q,(select to_jsonb(x) from public.e8_reference_quotes x where id=q)) on conflict do nothing;
 -- Coalesce wake-ups; the existing profile lease and shared provider budgets still gate every read.
 insert into public.e8_event_quote_wakeups(account_id,last_at) values(p.reference_account_id,t)
 on conflict(account_id) do update set last_at=excluded.last_at where public.e8_event_quote_wakeups.last_at<t-interval '1 second'
 returning account_id into w;
 if w is not null then
  update public.e8_monitor_profiles set next_run=least(next_run,t) where account_id=w and enabled;
  begin perform public.kick_e8_reference();exception when others then raise warning 'E8_EVENT_WAKEUP_UNAVAILABLE';end;
 end if;
 return new;
exception when others then
 -- Observation outages must not roll back a trade. Archive coverage still exposes missing observations.
 raise warning 'E8_EVENT_RECORDER_UNAVAILABLE';return new;
end $$;
create trigger e8_event_quote_capture after insert on public.e8_sim_events for each row execute function public.e8_demand_capture();
-- Full-close intent is durable before broker dispatch; waiting for the final source close would be too late.
create function public.e8_close_intent_capture() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.close_requested_at is not null and old.close_requested_at is distinct from new.close_requested_at
  and exists(select 1 from public.e8_sim_positions where trade_id=new.id) then
  insert into public.e8_sim_events(trade_id,source_row_id,kind,event_at,lots,source_snapshot)
  values(new.id,new.id,'amend',new.close_requested_at,new.volume,jsonb_build_object('phase','close_intent','status',new.status));
 end if;
 return new;
exception when others then raise warning 'E8_CLOSE_INTENT_RECORDER_UNAVAILABLE';return new;
end $$;
create trigger e8_close_intent_capture after update of close_requested_at on public.trades for each row execute function public.e8_close_intent_capture();
create function public.e8_pending_demand_capture() returns trigger language plpgsql security definer set search_path='' as $$
declare a bigint;t timestamptz:=clock_timestamp();w bigint;q bigint;s text:=new.snapshot->>'symbol';
begin
 select account_id into a from public.e8_monitor_profiles where enabled and s=any(symbols) order by account_id limit 1;
 if a is null then return new;end if;
 select id into q from public.e8_reference_quotes where account_id=a and symbol=s and received_at<=new.captured_at
  and received_at>=new.captured_at-interval '1 second' order by received_at desc,id desc limit 1;
 insert into public.e8_event_quote_demands(pending_event_id,account_id,symbol,event_at,kind,decision_quote_id,decision_quote)
 values(new.id,a,s,new.captured_at,'pending_'||new.kind,q,(select to_jsonb(x) from public.e8_reference_quotes x where id=q)) on conflict do nothing;
 insert into public.e8_event_quote_wakeups(account_id,last_at) values(a,t)
 on conflict(account_id) do update set last_at=excluded.last_at where public.e8_event_quote_wakeups.last_at<t-interval '1 second' returning account_id into w;
 if w is not null then
  update public.e8_monitor_profiles set next_run=least(next_run,t) where account_id=w and enabled;
  begin perform public.kick_e8_reference();exception when others then raise warning 'E8_PENDING_WAKEUP_UNAVAILABLE';end;
 end if;
 return new;
exception when others then raise warning 'E8_PENDING_RECORDER_UNAVAILABLE';return new;
end $$;
create trigger e8_pending_quote_capture after insert on public.ipfx_sim_pending_events for each row execute function public.e8_pending_demand_capture();
create function public.e8_event_quote_due(p_account bigint) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(x),'[]'::jsonb) from(
  select symbol,min(event_at) first_event_at,count(*) events,
   min(case when kind in('close','close_intent','partial','pending_cancelled','pending_deleted') then 0 else 1 end) priority
  from public.e8_event_quote_demands where account_id=p_account and observed_quote is null
   and captured_at>now()-interval '30 seconds'
  group by symbol order by priority,min(event_at),symbol limit 6
 )x;
$$;
create function public.e8_event_quote_link(p_account bigint,p_symbol text,p_quote bigint) returns integer
language plpgsql security definer set search_path='' as $$
declare q public.e8_reference_quotes;n integer;
begin
 select * into q from public.e8_reference_quotes where id=p_quote and account_id=p_account and symbol=p_symbol;
 if not found then raise exception 'QUOTE_BINDING_MISMATCH';end if;
 update public.e8_event_quote_demands set observed_quote_id=q.id,observed_quote=to_jsonb(q) where account_id=p_account and symbol=p_symbol
  and observed_quote is null and captured_at<=q.requested_at and event_at<=q.requested_at
  and event_at>=q.requested_at-interval '30 seconds';
 get diagnostics n=row_count;return n;
end $$;
create function public.e8_record_dispatch(p_operation bigint,p_sent timestamptz,p_ack timestamptz,p_ack_ms numeric,
 p_receipt_ms numeric,p_fill_price numeric,p_fill_qty numeric,p_confirmed boolean,p_instrument text default null) returns void
language plpgsql security definer set search_path='' as $$
declare o public.book_orders;a bigint;q bigint;
begin
 select * into o from public.book_orders where id=p_operation;
 if not found then raise exception 'UNKNOWN_OPERATION';end if;
 if p_sent is null or p_sent<o.created_at-interval '1 second' or p_sent>clock_timestamp()+interval '1 second'
  or p_ack>clock_timestamp()+interval '1 second' or p_ack<p_sent then raise exception 'INVALID_DISPATCH_TIMING';end if;
 if o.book ~ '^l[0-9]+$' then a:=substring(o.book from 2)::bigint;end if;
 select id into q from public.e8_reference_quotes where account_id=a and symbol=o.symbol and instrument_id=p_instrument and received_at<=p_sent
  and received_at>=p_sent-interval '1 second' order by received_at desc,id desc limit 1;
 insert into public.e8_dispatch_evidence(operation_id,account_id,sent_at,ack_at,ack_ms,receipt_lookup_ms,quote_id,quote_snapshot,fill_price,fill_qty,fill_confirmed)
 values(o.id,a,p_sent,p_ack,p_ack_ms,p_receipt_ms,q,(select to_jsonb(x) from public.e8_reference_quotes x where id=q),p_fill_price,p_fill_qty,coalesce(p_confirmed,false)) on conflict do nothing;
end $$;
create function public.e8_import_position_receipt(p_account bigint,p_actor uuid,p_receipt jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.ladder_accounts;o public.cost_fills;c record;ids text[];qty numeric;g numeric;n numeric;f numeric;com numeric;sw numeric;
 includes boolean;note text;fingerprint text;receipt_id uuid;
begin
 select * into a from public.ladder_accounts where id=p_account and platform='tradelocker' and role in('monitor','ladder');
 if not found or a.account_id is distinct from p_receipt->>'brokerAccountId' then raise exception 'EXACT_BROKER_ACCOUNT_REQUIRED';end if;
 if p_actor is null or coalesce(p_receipt->>'positionId','')!~'^[0-9]{1,24}$'
  or coalesce(p_receipt->>'openingOrderId','')!~'^[0-9]{1,24}$' or jsonb_typeof(p_receipt->'closingOrderIds') is distinct from 'array'
  then raise exception 'EXACT_POSITION_AND_ORDER_IDS_REQUIRED';end if;
 select array_agg(value order by value) into ids from jsonb_array_elements_text(p_receipt->'closingOrderIds');
 if coalesce(array_length(ids,1),0) not between 1 and 100 or exists(select 1 from unnest(ids)v where v!~'^[0-9]{1,24}$')
  or array_length(ids,1)<>(select count(distinct v) from unnest(ids)v) then raise exception 'INVALID_CLOSING_ORDER_IDS';end if;
 foreach note in array array['quantity','gross','net','fee','swap'] loop
  if jsonb_typeof(p_receipt->note) is distinct from 'number' then raise exception 'EXPLICIT_NUMERIC_COSTS_REQUIRED';end if;
 end loop;
 if jsonb_typeof(p_receipt->'feeIncludesCommission') is distinct from 'boolean' then raise exception 'FEE_DEFINITION_REQUIRED';end if;
 qty:=(p_receipt->>'quantity')::numeric;g:=(p_receipt->>'gross')::numeric;n:=(p_receipt->>'net')::numeric;
 f:=(p_receipt->>'fee')::numeric;sw:=(p_receipt->>'swap')::numeric;includes:=(p_receipt->>'feeIncludesCommission')::boolean;
 if not includes then
  if jsonb_typeof(p_receipt->'commission') is distinct from 'number' then raise exception 'SEPARATE_COMMISSION_REQUIRED';end if;
  com:=(p_receipt->>'commission')::numeric;
 end if;
 if qty<=0 or abs(g+f+sw+case when includes then 0 else com end-n)>0.010000001 then raise exception 'RECEIPT_NET_DOES_NOT_RECONCILE';end if;
 select * into o from public.cost_fills where account_id=p_account and ref=p_receipt->>'openingOrderId'
  and raw->>'positionId'=p_receipt->>'positionId' and raw->>'isOpen'='true' and lower(raw->>'status')='filled';
 if not found or o.qty<>qty or o.price<=0 or o.side not in('buy','sell') then raise exception 'OPENING_FILL_NOT_MATCHED';end if;
 select count(*) count,sum(x.qty) quantity,sum((x.price-o.price)*x.qty*case when o.side='buy' then 1 else -1 end) move,
  bool_and(x.qty>0 and x.price>0 and x.side<>o.side and x.symbol=o.symbol) valid into c
 from public.cost_fills x where x.account_id=p_account and x.ref=any(ids) and x.raw->>'positionId'=p_receipt->>'positionId'
  and x.raw->>'isOpen'='false' and lower(x.raw->>'status')='filled';
 if c.count<>array_length(ids,1) or c.quantity<>qty or c.valid is distinct from true then raise exception 'CLOSING_QUANTITY_NOT_MATCHED';end if;
 -- Prove the whole position, including partials, is represented; no selective receipt subset.
 if (select sum(x.qty) from public.cost_fills x where x.account_id=p_account and x.raw->>'positionId'=p_receipt->>'positionId'
  and x.raw->>'isOpen'='false' and lower(x.raw->>'status')='filled')<>qty then raise exception 'POSITION_HISTORY_INCOMPLETE';end if;
 -- A symbol specification observed before entry is required for independent gross checking.
 if not exists(select 1 from(select e.* from public.e8_instrument_evidence e where e.account_id=p_account and e.broker_symbol=o.symbol
  and e.observed_at<=coalesce(o.filled_at,o.created_at) order by e.observed_at desc limit 1)e
  where e.quote_currency='USD' and e.lot_size>0 and abs(c.move*e.lot_size-g)<=0.010000001) then raise exception 'GROSS_OR_CONTRACT_NOT_MATCHED';end if;
 note:=btrim(p_receipt->>'evidenceNote');if note is null or length(note) not between 10 and 500 then raise exception 'RECEIPT_PROVENANCE_REQUIRED';end if;
 fingerprint:=md5(jsonb_build_array(ids,qty,g,n,f,com,sw,includes)::text);
 insert into public.e8_position_receipts(account_id,position_id,opening_order_id,closing_order_ids,quantity,gross,net,
 signed_fee,signed_commission,signed_swap,fee_includes_commission,actor_id,evidence_note,content_fingerprint)
 values(p_account,p_receipt->>'positionId',o.ref,ids,qty,g,n,f,com,sw,includes,p_actor,note,fingerprint)
 on conflict do nothing returning id into receipt_id;
 if receipt_id is null then select id into receipt_id from public.e8_position_receipts where account_id=p_account
  and position_id=p_receipt->>'positionId' and content_fingerprint=fingerprint;end if;
 return jsonb_build_object('ok',true,'id',receipt_id,'basis','OWNER_REVIEWED_POSITION_RECEIPT','statementAuthenticated',false,'canEnableLive',false);
end $$;
create function public.e8_evidence_overview() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',id,'label',label,'account_id',account_id,'role',role)) from public.ladder_accounts where platform='tradelocker' and role in('monitor','ladder')),'[]'::jsonb),
 'candidates',coalesce((select jsonb_agg(to_jsonb(r)) from(
  select o.account_id,o.raw->>'positionId' position_id,o.ref opening_order_id,x.closing_order_ids,o.qty quantity,
   case when spec.quote_currency='USD' and spec.lot_size>0 then round(x.move*spec.lot_size,2) end fill_gross
  from public.cost_fills o join public.ladder_accounts a on a.id=o.account_id and a.platform='tradelocker' and a.role in('monitor','ladder')
  cross join lateral(select array_agg(c.ref order by c.ref) closing_order_ids,sum(c.qty) quantity,
   sum((c.price-o.price)*c.qty*case when o.side='buy' then 1 else -1 end) move
   from public.cost_fills c where c.account_id=o.account_id and c.raw->>'positionId'=o.raw->>'positionId'
    and c.raw->>'isOpen'='false' and lower(c.raw->>'status')='filled' and c.side<>o.side and c.symbol=o.symbol)x
  left join lateral(select e.lot_size,e.quote_currency from public.e8_instrument_evidence e where e.account_id=o.account_id and e.broker_symbol=o.symbol
   and e.observed_at<=o.filled_at order by e.observed_at desc limit 1)spec on true
  where o.raw->>'isOpen'='true' and lower(o.raw->>'status')='filled' and o.qty>0 and o.qty=x.quantity
   and o.filled_at>now()-interval '7 days' order by o.filled_at desc limit 20
 )r),'[]'::jsonb),
 'receipts',coalesce((select jsonb_agg(to_jsonb(r)) from(select id,account_id,position_id,gross,net,signed_fee,signed_commission,signed_swap,
  basis,created_at,(select count(distinct content_fingerprint)>1 from public.e8_position_receipts x where x.account_id=p.account_id and x.position_id=p.position_id) conflict
  from public.e8_position_receipts p order by created_at desc limit 30)r),'[]'::jsonb),
 'dispatches',coalesce((select jsonb_agg(to_jsonb(r)) from(select e.operation_id,e.account_id,o.source_trade_id,o.event,o.side,e.sent_at,e.ack_ms,e.receipt_lookup_ms,
  e.fill_confirmed,e.fill_price,(e.quote_snapshot->>'bid')::numeric bid,(e.quote_snapshot->>'ask')::numeric ask,
  extract(epoch from(e.sent_at-(e.quote_snapshot->>'received_at')::timestamptz))*1000 received_age_ms,
  extract(epoch from(e.sent_at-(e.quote_snapshot->>'broker_quote_at')::timestamptz))*1000 provider_age_ms,
  case when e.fill_confirmed and e.quote_snapshot is not null then (case when o.side='buy' then e.fill_price-(e.quote_snapshot->>'ask')::numeric else (e.quote_snapshot->>'bid')::numeric-e.fill_price end) end quote_shortfall,
  'OBSERVED_QUOTE_SHORTFALL_NOT_GUARANTEED_EXECUTABLE_LIQUIDITY' benchmark_basis
  from public.e8_dispatch_evidence e join public.book_orders o on o.id=e.operation_id left join public.e8_reference_quotes q on q.id=e.quote_id
  order by e.sent_at desc limit 40)r),'[]'::jsonb),
 'event_quotes',coalesce((select jsonb_agg(to_jsonb(r)) from(select d.event_id,d.pending_event_id,d.symbol,d.kind,d.event_at,d.decision_quote_id,d.observed_quote_id,
  extract(epoch from((d.observed_quote->>'received_at')::timestamptz-d.event_at))*1000 sampling_wait_ms,d.observed_quote->>'broker_quote_at' broker_quote_at
  from public.e8_event_quote_demands d left join public.e8_reference_quotes q on q.id=d.observed_quote_id order by demand_id desc limit 40)r),'[]'::jsonb),
 'snapshots',coalesce((select jsonb_agg(to_jsonb(r)) from(select id,account_id,received_at,amounts,currency from public.e8_account_snapshots order by id desc limit 40)r),'[]'::jsonb),
 'coverage',jsonb_build_object('events',(select count(*) from public.e8_sim_events where captured_at>now()-interval '1 day'),
  'pending_events',(select count(*) from public.ipfx_sim_pending_events where captured_at>now()-interval '1 day'),
  'requested',(select count(*) from public.e8_event_quote_demands where captured_at>now()-interval '1 day'),
  'observed',(select count(*) from public.e8_event_quote_demands where captured_at>now()-interval '1 day' and observed_quote is not null)),
 'net_accuracy_certified',false,'canEnableLive',false);
$$;
do $$ declare name text;begin
 foreach name in array array['e8_event_quote_demands','e8_event_quote_wakeups','e8_dispatch_evidence','e8_position_receipts'] loop
  execute format('alter table public.%I enable row level security',name);
  execute format('revoke all on public.%I from public,anon,authenticated',name);
  execute format('grant select,insert,update on public.%I to service_role',name);
 end loop;
end $$;
create trigger e8_dispatch_immutable before update or delete on public.e8_dispatch_evidence for each row execute function public.e8_revision_immutable();
create trigger e8_receipt_immutable before update or delete on public.e8_position_receipts for each row execute function public.e8_revision_immutable();
revoke all on function public.e8_demand_capture(),public.e8_event_quote_due(bigint),public.e8_event_quote_link(bigint,text,bigint),
 public.e8_close_intent_capture(),public.e8_pending_demand_capture(),public.e8_record_dispatch(bigint,timestamptz,timestamptz,numeric,numeric,numeric,numeric,boolean,text),public.e8_import_position_receipt(bigint,uuid,jsonb),public.e8_evidence_overview() from public,anon,authenticated;
grant execute on function public.e8_event_quote_due(bigint),public.e8_event_quote_link(bigint,text,bigint),
 public.e8_record_dispatch(bigint,timestamptz,timestamptz,numeric,numeric,numeric,numeric,boolean,text),public.e8_import_position_receipt(bigint,uuid,jsonb),public.e8_evidence_overview() to service_role;
commit;
