begin;
-- Source bookkeeping only. Broker routing/fills remain in the engine. A failed
-- slice insert or balance credit rolls the entire source close back.
create function public.fn_commit_ipfx_partial(
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
 if p_volume>=t.volume or round(t.volume-p_volume,2)<0.01 then return jsonb_build_object('ok',false,'reason','INVALID_PARTIAL_QUANTITY'); end if;
 update public.trades set volume=round(t.volume-p_volume,2) where id=t.id;
 insert into public.trades(id,parent_trade_id,account_id,user_id,symbol,side,volume,open_price,sl,tp,status,close_price,pnl,close_reason,opened_at,closed_at,commission,execution_shortfall,pnl_basis)
 values(p_slice_id,t.id,a.id,t.user_id,t.symbol,t.side,p_volume,t.open_price,t.sl,t.tp,'closed',p_exit,round(p_pnl,2),'partial',t.opened_at,stamp,
  case when p_costs_enabled then p_commission end,case when p_costs_enabled then p_shortfall end,
  case when p_costs_enabled then 'NET_AFTER_COSTS' end);
 update public.trading_accounts set balance=round(balance+round(p_pnl,2),2),updated_at=stamp where id=a.id returning balance into bal;
 return jsonb_build_object('ok',true,'slice_id',p_slice_id,'balance',bal,'remaining_volume',round(t.volume-p_volume,2));
end $$;

create function public.fn_commit_ipfx_close(
 p_trade_id uuid,p_account_id uuid,p_user_id uuid,p_expected_volume numeric,p_expected_open_price numeric,
 p_exit numeric,p_pnl numeric,p_reason text,p_costs_enabled boolean,p_commission numeric,p_shortfall numeric,p_stripped_profit numeric
) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.trades; a public.trading_accounts; bal numeric; stamp timestamptz:=clock_timestamp();
begin
 if p_exit is null or p_pnl is null or p_exit<=0 or p_exit::text in('NaN','Infinity','-Infinity')
  or p_pnl::text in('NaN','Infinity','-Infinity') then raise exception 'INVALID_CLOSE_VALUES'; end if;
 select * into t from public.trades where id=p_trade_id and account_id=p_account_id and user_id=p_user_id for update;
 if not found or t.status<>'open' or t.volume is distinct from p_expected_volume or t.open_price is distinct from p_expected_open_price
 then return jsonb_build_object('ok',false,'reason','POSITION_CHANGED'); end if;
 select * into a from public.trading_accounts where id=p_account_id and user_id=p_user_id for update;
 -- Breached/revoked accounts must still flatten their remaining source positions.
 if not found or coalesce(a.venue,'ipfx')<>'ipfx' then return jsonb_build_object('ok',false,'reason','ACCOUNT_UNAVAILABLE'); end if;
 update public.trades set status='closed',close_price=p_exit,pnl=round(p_pnl,2),close_reason=p_reason,closed_at=stamp,
  stripped_profit=case when p_stripped_profit is not null then p_stripped_profit else stripped_profit end,
  commission=case when p_costs_enabled then p_commission else commission end,
  execution_shortfall=case when p_costs_enabled then coalesce(execution_shortfall,0)+coalesce(p_shortfall,0) else execution_shortfall end,
  pnl_basis=case when p_costs_enabled then 'NET_AFTER_COSTS' else pnl_basis end where id=t.id;
 update public.trading_accounts set balance=round(balance+round(p_pnl,2),2),updated_at=stamp where id=a.id returning balance into bal;
 return jsonb_build_object('ok',true,'balance',bal);
end $$;
revoke all on function public.fn_commit_ipfx_partial(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,boolean,numeric,numeric,uuid),
 public.fn_commit_ipfx_close(uuid,uuid,uuid,numeric,numeric,numeric,numeric,text,boolean,numeric,numeric,numeric) from public,anon,authenticated;
grant execute on function public.fn_commit_ipfx_partial(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,boolean,numeric,numeric,uuid),
 public.fn_commit_ipfx_close(uuid,uuid,uuid,numeric,numeric,numeric,numeric,text,boolean,numeric,numeric,numeric) to service_role;
commit;
