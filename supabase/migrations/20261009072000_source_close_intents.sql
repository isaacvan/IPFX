-- Persist a full-close request before broker hedging; it blocks concurrent partial resizes.
alter table public.trades add column if not exists close_requested_at timestamptz;
alter table public.trades add column if not exists close_decision jsonb;
create or replace function public.fn_request_ipfx_full_close(p_trade uuid,p_account uuid,p_user uuid,p_volume numeric,p_decision jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.trades;
begin
 select * into t from public.trades where id=p_trade and account_id=p_account and user_id=p_user for update;
 if not found or t.status<>'open' or t.volume is distinct from p_volume then return jsonb_build_object('ok',false,'reason','POSITION_CHANGED');end if;
 update public.trades set close_requested_at=coalesce(close_requested_at,clock_timestamp()),close_decision=coalesce(close_decision,p_decision) where id=t.id;
 return jsonb_build_object('ok',true,'remaining',t.volume);
end $$;
revoke all on function public.fn_request_ipfx_full_close(uuid,uuid,uuid,numeric,jsonb) from public,anon,authenticated;
grant execute on function public.fn_request_ipfx_full_close(uuid,uuid,uuid,numeric,jsonb) to service_role;
create or replace function public.fn_commit_ipfx_partial(
 p_trade_id uuid,p_account_id uuid,p_user_id uuid,p_expected_volume numeric,p_expected_open_price numeric,
 p_volume numeric,p_exit numeric,p_pnl numeric,p_costs_enabled boolean,p_commission numeric,p_shortfall numeric,p_slice_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.trades; a public.trading_accounts; bal numeric; stamp timestamptz:=clock_timestamp();
begin
 if p_slice_id is null or p_volume is null or p_exit is null or p_pnl is null
  or p_volume::text in('NaN','Infinity','-Infinity') or p_exit::text in('NaN','Infinity','-Infinity')
  or p_pnl::text in('NaN','Infinity','-Infinity') or p_volume<0.01 or p_volume<>round(p_volume,2) or p_exit<=0
 then raise exception 'INVALID_CLOSE_VALUES'; end if;
 select * into t from public.trades where id=p_trade_id and account_id=p_account_id and user_id=p_user_id for update;
 if not found or t.status<>'open' or t.volume is distinct from p_expected_volume or t.open_price is distinct from p_expected_open_price
 then return jsonb_build_object('ok',false,'reason','POSITION_CHANGED'); end if;
 select * into a from public.trading_accounts where id=p_account_id and user_id=p_user_id for update;
 if not found or coalesce(a.venue,'ipfx')<>'ipfx' or a.status not in('active','demo')
 then return jsonb_build_object('ok',false,'reason','ACCOUNT_UNAVAILABLE'); end if;
 if t.close_requested_at is not null then return jsonb_build_object('ok',false,'reason','FULL_CLOSE_IN_PROGRESS');end if;
 if p_volume>=t.volume or round(t.volume-p_volume,2)<0.01 then return jsonb_build_object('ok',false,'reason','INVALID_PARTIAL_QUANTITY'); end if;
 update public.trades set volume=round(t.volume-p_volume,2) where id=t.id;
 insert into public.trades(id,parent_trade_id,account_id,user_id,symbol,side,volume,open_price,sl,tp,status,close_price,pnl,close_reason,opened_at,closed_at,commission,execution_shortfall,pnl_basis)
 values(p_slice_id,t.id,a.id,t.user_id,t.symbol,t.side,p_volume,t.open_price,t.sl,t.tp,'closed',p_exit,round(p_pnl,2),'partial',t.opened_at,stamp,
  case when p_costs_enabled then p_commission end,case when p_costs_enabled then p_shortfall end,
  case when p_costs_enabled then 'NET_AFTER_COSTS' end);
 update public.trading_accounts set balance=round(balance+round(p_pnl,2),2),updated_at=stamp where id=a.id returning balance into bal;
 return jsonb_build_object('ok',true,'slice_id',p_slice_id,'balance',bal,'remaining_volume',round(t.volume-p_volume,2));
end $$;


revoke all on function public.fn_commit_ipfx_partial(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,boolean,numeric,numeric,uuid) from public,anon,authenticated;
grant execute on function public.fn_commit_ipfx_partial(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,boolean,numeric,numeric,uuid) to service_role;
