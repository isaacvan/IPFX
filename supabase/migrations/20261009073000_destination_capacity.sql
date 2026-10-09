-- Limits must be based on documented account/provider capacity; unknown limits block opens, never exits.
create table public.book_capacity_limits(book text primary key,position_limit integer not null check(position_limit>0),margin_per_lot_usd numeric not null check(margin_per_lot_usd>0),provider_evidence text not null,updated_at timestamptz not null default now());
create table public.book_capacity_state(book text primary key,observed_at timestamptz not null,open_positions integer not null check(open_positions>=0),pending_orders integer not null check(pending_orders>=0),free_margin_usd numeric not null check(free_margin_usd>=0));
create table public.book_position_slots(book text not null,source_trade_id uuid not null,qty numeric not null check(qty>0),state text not null default 'reserved' check(state in('reserved','sent','unknown','confirmed','released')),reserved_at timestamptz not null default now(),primary key(book,source_trade_id));
alter table public.book_capacity_limits enable row level security;alter table public.book_capacity_state enable row level security;alter table public.book_position_slots enable row level security;
revoke all on public.book_capacity_limits,public.book_capacity_state,public.book_position_slots from public,anon,authenticated;
grant select,insert,update on public.book_capacity_limits,public.book_capacity_state,public.book_position_slots to service_role;
create or replace function public.fn_reserve_book_slot(p_book text,p_trade uuid,p_qty numeric) returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.book_capacity_limits;s public.book_capacity_state;outstanding integer;margin numeric;old public.book_position_slots;
begin
 if p_qty is null or p_qty<=0 or p_qty::text in('NaN','Infinity','-Infinity')then raise exception 'INVALID_QTY';end if;
 perform pg_advisory_xact_lock(hashtext('book_capacity:'||p_book));
 select * into old from public.book_position_slots where book=p_book and source_trade_id=p_trade;
 if found then return jsonb_build_object('ok',false,'reason','EXISTING_ORDER_REQUIRES_RECONCILIATION','state',old.state);end if;
 select * into l from public.book_capacity_limits where book=p_book;
 if not found then return jsonb_build_object('ok',false,'reason','DOCUMENTED_CAPACITY_NOT_CONFIGURED');end if;
 select * into s from public.book_capacity_state where book=p_book;
 if not found or s.observed_at<now()-interval '5 seconds' or s.observed_at>now()+interval '1 second' then return jsonb_build_object('ok',false,'reason','BROKER_INVENTORY_STALE');end if;
 select count(*),coalesce(sum(qty*l.margin_per_lot_usd),0) into outstanding,margin from public.book_position_slots where book=p_book and state in('reserved','sent','unknown');
 if s.open_positions+s.pending_orders+outstanding>=l.position_limit then return jsonb_build_object('ok',false,'reason','POSITION_CAPACITY_FULL');end if;
 if s.free_margin_usd-margin<p_qty*l.margin_per_lot_usd then return jsonb_build_object('ok',false,'reason','INSUFFICIENT_MARGIN');end if;
 insert into public.book_position_slots(book,source_trade_id,qty)values(p_book,p_trade,p_qty);
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.fn_reserve_book_slot(text,uuid,numeric)from public,anon,authenticated;
grant execute on function public.fn_reserve_book_slot(text,uuid,numeric)to service_role;
create or replace function public.fn_publish_book_capacity(p_book text,p_observed timestamptz,p_positions integer,p_orders integer,p_margin numeric,p_position_ids text[])returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtext('book_capacity:'||p_book));
 insert into public.book_capacity_state(book,observed_at,open_positions,pending_orders,free_margin_usd)values(p_book,p_observed,p_positions,p_orders,p_margin)
 on conflict(book)do update set observed_at=excluded.observed_at,open_positions=excluded.open_positions,pending_orders=excluded.pending_orders,free_margin_usd=excluded.free_margin_usd
 where public.book_capacity_state.observed_at<=excluded.observed_at;
 if not found then return;end if;
 if p_book ~ '^s[0-9]+$' then
  update public.book_position_slots s set state='confirmed' where s.book=p_book and s.state in('reserved','sent','unknown') and exists(
   select 1 from public.shadow_orders o where o.account_id=substring(p_book from 2)::bigint and o.source_trade_id=s.source_trade_id and o.event='open' and o.status='filled' and o.broker_position_id=any(p_position_ids));
 else
  update public.book_position_slots s set state='confirmed' where s.book=p_book and s.state in('reserved','sent','unknown') and exists(
   select 1 from public.book_orders o where o.book=p_book and o.source_trade_id=s.source_trade_id and o.event='open' and o.status='filled' and o.broker_position_id=any(p_position_ids));
 end if;
end $$;
revoke all on function public.fn_publish_book_capacity(text,timestamptz,integer,integer,numeric,text[])from public,anon,authenticated;
grant execute on function public.fn_publish_book_capacity(text,timestamptz,integer,integer,numeric,text[])to service_role;
