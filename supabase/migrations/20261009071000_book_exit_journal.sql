-- Exit ownership and dispatch are durable; ambiguous dispatches never release risk or get blindly retried.
alter table public.book_orders add column if not exists dispatch_state text not null default 'unknown'
 check(dispatch_state in('planned','sent','unknown','confirmed'));
alter table public.book_orders add column if not exists source_initial_volume numeric;
alter table public.book_orders add column if not exists lot_step numeric;
alter table public.book_orders add column if not exists broker_confirmed_qty numeric;
alter table public.book_orders add column if not exists risk_release_applied boolean not null default false;
update public.book_orders set dispatch_state='confirmed',broker_confirmed_qty=qty where event<>'open' and status='closed';
alter table public.shadow_orders add column if not exists dispatch_state text not null default 'unknown' check(dispatch_state in('planned','sent','unknown','confirmed'));
alter table public.shadow_orders add column if not exists broker_confirmed_qty numeric;
update public.shadow_orders set dispatch_state='confirmed',broker_confirmed_qty=qty where event='close' and status='closed';
create index if not exists book_exit_unresolved on public.book_orders(book,source_trade_id,dispatch_state) where event<>'open' and dispatch_state<>'confirmed';
create or replace function public.fn_plan_book_exit(p_open_id bigint,p_full boolean,p_slice text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare root public.book_orders;op public.book_orders;source public.trades;initial numeric;remaining numeric;target numeric;qty numeric;step numeric;key text;
begin
 select * into root from public.book_orders where id=p_open_id and event='open' and status='filled' for update;
 if not found then return jsonb_build_object('ok',false,'reason','OPEN_LEG_UNAVAILABLE');end if;
 if root.book not in('a','b') and root.book !~ '^l[0-9]+$' then raise exception 'INVALID_MANAGED_BOOK';end if;
 select * into source from public.trades where id=root.source_trade_id;
 if not found then return jsonb_build_object('ok',false,'reason','SOURCE_UNAVAILABLE');end if;
 key:=root.book||':'||root.source_trade_id||':'||case when p_full then 'close' else 'partial:'||p_slice end;
 select * into op from public.book_orders where idempotency_key=key;
 if found then
  select root.qty-coalesce(sum(broker_confirmed_qty),0) into remaining from public.book_orders where book=root.book and source_trade_id=root.source_trade_id and event<>'open' and dispatch_state='confirmed';
  return jsonb_build_object('ok',true,'claim',to_jsonb(op),'remaining',remaining,'duplicate',true);
 end if;
 select * into op from public.book_orders where book=root.book and source_trade_id=root.source_trade_id and event<>'open' and dispatch_state<>'confirmed' order by id limit 1;
 if found then return jsonb_build_object('ok',false,'reason','PRIOR_EXIT_RECONCILIATION_REQUIRED','operation_id',op.id);end if;
 initial:=root.source_initial_volume;
 if initial is null then select source.volume+coalesce(sum(t.volume),0) into initial from public.trades t where t.parent_trade_id=source.id and t.close_reason='partial';end if;
 if initial<=0 or initial is null then return jsonb_build_object('ok',false,'reason','SOURCE_QUANTITY_UNAVAILABLE');end if;
 select root.qty-coalesce(sum(broker_confirmed_qty),0) into remaining from public.book_orders where book=root.book and source_trade_id=root.source_trade_id and event<>'open' and dispatch_state='confirmed';
 step:=coalesce(root.lot_step,0.01);
 target:=case when p_full or source.status='closed' then 0 else ceil(root.qty*source.volume/initial/step)*step end;
 qty:=round(greatest(0,remaining-target),8);
 if qty<=0 then return jsonb_build_object('ok',true,'skipped','BELOW_STEP_OR_ALREADY_CLOSED');end if;
 insert into public.book_orders(book,source_trade_id,person_id,event,idempotency_key,symbol,side,qty,status,dispatch_state,price_scale_per_lot,broker_position_id)
 values(root.book,root.source_trade_id,root.person_id,case when p_full then 'close' else 'partial_close' end,key,root.symbol,case when root.side='buy' then 'sell' else 'buy' end,qty,'sent','planned',root.price_scale_per_lot,root.broker_position_id) returning * into op;
 return jsonb_build_object('ok',true,'claim',to_jsonb(op),'remaining',remaining,'duplicate',false);
end $$;
revoke all on function public.fn_plan_book_exit(bigint,boolean,text) from public,anon,authenticated;
grant execute on function public.fn_plan_book_exit(bigint,boolean,text) to service_role;
create or replace function public.fn_finalize_book_exit(p_exit_id bigint)returns void language plpgsql security definer set search_path='' as $$
declare op public.book_orders;root public.book_orders;remaining numeric;
begin
 select * into op from public.book_orders where id=p_exit_id;
 if not found or op.event='open' then raise exception 'EXIT_NOT_FOUND';end if;
 select * into root from public.book_orders where source_trade_id=op.source_trade_id and book=op.book and event='open' for update;
 select * into op from public.book_orders where id=p_exit_id for update;
 if op.risk_release_applied then return;end if;
 if op.dispatch_state<>'confirmed' or op.status<>'closed' or op.broker_order_id is null or op.fill_price is null or op.broker_confirmed_qty is distinct from op.qty then raise exception 'EXIT_NOT_CONFIRMED';end if;
 select root.qty-coalesce(sum(broker_confirmed_qty),0) into remaining from public.book_orders where source_trade_id=root.source_trade_id and book=root.book and event<>'open' and dispatch_state='confirmed' and id<>op.id;
 if remaining>0 then perform public.ab_release_risk(op.book,op.source_trade_id,least(1,op.qty/remaining));end if;
 update public.book_orders set risk_release_applied=true where id=op.id;
 if remaining<=op.qty then update public.book_position_slots set state='released' where book=op.book and source_trade_id=op.source_trade_id;end if;
end $$;
revoke all on function public.fn_finalize_book_exit(bigint)from public,anon,authenticated;
grant execute on function public.fn_finalize_book_exit(bigint)to service_role;
