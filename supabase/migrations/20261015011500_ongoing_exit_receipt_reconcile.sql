-- Receipt-only recovery for owned ongoing copies. No broker calls, order dispatch or execution activation.
create function public.fn_reconcile_ongoing_exit(p_exit_id bigint)returns jsonb
language plpgsql security definer set search_path='' as $$
declare op public.book_orders;root public.book_orders;c public.ongoing_copy_connections;
 opening public.cost_fills;closing public.cost_fills;candidate public.cost_fills;n int:=0;
 price numeric;gross numeric;remaining numeric;
begin
 select * into op from public.book_orders where id=p_exit_id;
 if not found or op.event='open' or op.ongoing_copy_connection_id is null then return jsonb_build_object('ok',false,'reason','OWNED_ONGOING_EXIT_REQUIRED');end if;
 -- Same root lock order as the existing planner/finalizer prevents concurrent receipt reuse.
 select * into root from public.book_orders where book=op.book and source_trade_id=op.source_trade_id and event='open'for update;
 if not found then return jsonb_build_object('ok',false,'reason','OPEN_RECEIPT_REQUIRED');end if;
 select * into op from public.book_orders where id=p_exit_id for update;
 select * into c from public.ongoing_copy_connections where id=root.ongoing_copy_connection_id;
 if not found or c.id is distinct from op.ongoing_copy_connection_id or op.book<>'l'||c.account_id
  or root.status<>'filled' or root.broker_position_id is distinct from op.broker_position_id
  or root.broker_position_id !~ '^[1-9][0-9]{0,19}$' or root.broker_order_id !~ '^[1-9][0-9]{0,19}$'
  or root.broker_order_id is null or root.broker_position_id is null
  or root.ongoing_prior_position_ids is null or array_position(root.ongoing_prior_position_ids,null)is not null
  or root.broker_position_id=any(root.ongoing_prior_position_ids)
  or root.side not in('buy','sell')or op.side<>(case root.side when 'buy'then 'sell'else 'buy'end)
  or op.qty<=0 or op.qty>root.qty or op.qty::text in('NaN','Infinity','-Infinity')
  then return jsonb_build_object('ok',false,'reason','OPEN_OWNERSHIP_UNVERIFIED');end if;
 if op.dispatch_state='planned' or op.dispatch_state not in('sent','unknown','confirmed')then return jsonb_build_object('ok',false,'reason','EXIT_NOT_DISPATCHED');end if;
 select * into opening from public.cost_fills f where f.account_id=c.account_id and f.ref=root.broker_order_id;
 if not found or opening.raw->>'id' is distinct from root.broker_order_id
  or opening.raw->>'positionId' is distinct from root.broker_position_id
  or opening.raw->>'side' is distinct from root.side or opening.raw->>'isOpen' is distinct from 'true'
  or lower(opening.raw->>'status')is distinct from 'filled'
  or coalesce(opening.raw->>'tradableInstrumentId','')!~ '^[1-9][0-9]{0,19}$'
  or coalesce(opening.raw->>'filledQty','')!~ '^[0-9]+([.][0-9]+)?$'
  or coalesce(opening.raw->>'avgPrice','')!~ '^[0-9]+([.][0-9]+)?$'
  then return jsonb_build_object('ok',false,'reason','OPEN_BROKER_EVIDENCE_REQUIRED');end if;
 if (opening.raw->>'filledQty')::numeric is distinct from root.qty
  or (opening.raw->>'avgPrice')::numeric is distinct from root.fill_price
  or root.fill_price<=0 or root.price_scale_per_lot is null or root.price_scale_per_lot<=0
  or root.price_scale_per_lot::text in('NaN','Infinity','-Infinity')
  then return jsonb_build_object('ok',false,'reason','OPEN_PRICE_OR_QUANTITY_MISMATCH');end if;
 select root.qty-coalesce(sum(x.broker_confirmed_qty),0)into remaining from public.book_orders x
  where x.book=op.book and x.source_trade_id=op.source_trade_id and x.event<>'open'and x.id<>op.id and x.dispatch_state='confirmed';
 if remaining<op.qty then return jsonb_build_object('ok',false,'reason','EXIT_EXCEEDS_OWNED_REMAINDER');end if;
 for candidate in select * from public.cost_fills f where f.account_id=c.account_id
  and f.raw->>'positionId'=root.broker_position_id and f.raw->>'side'=op.side
  and f.raw->>'isOpen'='false'and lower(f.raw->>'status')='filled'
  and f.raw->>'tradableInstrumentId'=opening.raw->>'tradableInstrumentId'
  and(op.broker_order_id is null or f.ref=op.broker_order_id)
 loop
  if candidate.ref!~ '^[1-9][0-9]{0,19}$'or candidate.raw->>'id' is distinct from candidate.ref
   or coalesce(candidate.raw->>'filledQty','')!~ '^[0-9]+([.][0-9]+)?$'
   or coalesce(candidate.raw->>'avgPrice','')!~ '^[0-9]+([.][0-9]+)?$'
   or coalesce(candidate.raw->>'createdDate','')!~ '^[0-9]{13}$'then continue;end if;
  if (candidate.raw->>'filledQty')::numeric<>op.qty or(candidate.raw->>'avgPrice')::numeric<=0
   or(candidate.raw->>'createdDate')::numeric<extract(epoch from op.created_at)*1000
   or(candidate.raw->>'createdDate')::numeric>extract(epoch from(op.created_at+interval '2 minutes'))*1000
   or(candidate.raw->>'createdDate')::numeric>extract(epoch from clock_timestamp())*1000+1000
   then continue;end if;
  n:=n+1;closing:=candidate;
 end loop;
 if n=0 then return jsonb_build_object('ok',false,'reason','WAITING_EXACT_CLOSING_RECEIPT');end if;
 if n<>1 then return jsonb_build_object('ok',false,'reason','AMBIGUOUS_CLOSING_RECEIPTS');end if;
 if exists(select 1 from public.book_orders x where x.book=op.book and x.event<>'open'and x.id<>op.id and x.broker_order_id=closing.ref)
  then return jsonb_build_object('ok',false,'reason','CLOSING_RECEIPT_ALREADY_USED');end if;
 if op.dispatch_state='confirmed'and op.status='closed'and op.broker_order_id=closing.ref and op.broker_confirmed_qty=op.qty and op.risk_release_applied then
  return jsonb_build_object('ok',true,'id',op.id,'broker_order_id',closing.ref,'unchanged',true,'broker_execution_changed',false);end if;
 price:=(closing.raw->>'avgPrice')::numeric;
 gross:=round((price-root.fill_price)*case root.side when 'buy'then 1 else -1 end*op.qty*root.price_scale_per_lot,2);
 update public.book_orders set status='closed',dispatch_state='confirmed',broker_confirmed_qty=qty,
  broker_order_id=closing.ref,fill_price=price,pnl_usd=gross,error=null,updated_at=clock_timestamp()where id=op.id;
 -- Exact-once risk release and receipt update share this transaction, including audit failure rollback.
 perform public.fn_finalize_book_exit(op.id);
 update public.ongoing_copy_intents set reason='Broker exit receipt matched; gross confirmed, per-trade net costs unverified.'
  where connection_id=c.id and source_trade_id=op.source_trade_id;
 insert into public.admin_audit_log(actor_id,action,detail)values(c.actor_id,'ongoing_exit_receipt_reconciled',jsonb_build_object(
  'automated',true,'exit_id',op.id,'source_trade_id',op.source_trade_id,'broker_order_id',closing.ref,
  'broker_position_id',root.broker_position_id,'broker_fill_ref',closing.id,'gross_pnl_usd',gross,
  'net_verified',false,'receipt_fingerprint',md5(closing.raw::text),'broker_execution_changed',false));
 return jsonb_build_object('ok',true,'id',op.id,'broker_order_id',closing.ref,'gross_pnl_usd',gross,'net_verified',false,'broker_execution_changed',false);
end $$;
revoke all on function public.fn_reconcile_ongoing_exit(bigint)from public,anon,authenticated;
grant execute on function public.fn_reconcile_ongoing_exit(bigint)to service_role;
