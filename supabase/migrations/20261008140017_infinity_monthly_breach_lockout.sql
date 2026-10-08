-- Owner: a failed Infinity run blocks further Infinity orders/restarts until
-- the next UTC calendar month. The failed account itself never reactivates.
begin;
create index infinity_breach_month_lookup on public.trading_accounts(user_id,breached_at desc)
 where challenge_type='infinity' and status='breached';
create function public.fn_infinity_breach_lockout(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare who uuid:=public.ab_person_of(p_user); failed record; reset_at timestamptz;
begin
 select a.id,coalesce(a.breached_at,e.triggered_at) failed_at into failed
 from public.trading_accounts a left join public.account_breach_events e on e.account_id=a.id
 where a.challenge_type='infinity' and a.status='breached' and a.user_id in(
  select u.id from auth.users u where u.id=p_user or u.id=who
   or u.raw_app_meta_data->'suspension'->>'kept_user_id'=who::text)
 order by coalesce(a.breached_at,e.triggered_at) desc nulls first,a.id limit 1;
 if not found then return jsonb_build_object('locked',false);end if;
 if failed.failed_at is null then
  return jsonb_build_object('locked',true,'source_account_id',failed.id,'blocked_until',null,
   'code','INFINITY_BREACH_DATE_UNAVAILABLE','message','Account has been breached. Your restart date needs review.');end if;
 reset_at:=(date_trunc('month',failed.failed_at at time zone 'UTC')+interval '1 month') at time zone 'UTC';
 return jsonb_build_object('locked',clock_timestamp()<reset_at,'source_account_id',failed.id,'breached_at',failed.failed_at,
  'blocked_until',reset_at,'code','INFINITY_ACCOUNT_BREACHED',
  'message','Account has been breached. Infinity trading is locked until the next month.');
end $$;
revoke all on function public.fn_infinity_breach_lockout(uuid) from public,anon,authenticated;
grant execute on function public.fn_infinity_breach_lockout(uuid) to service_role;

create function public.fn_require_infinity_month_unlocked() returns trigger
language plpgsql security definer set search_path='' as $$
declare lockout jsonb; who uuid; applies boolean:=false;
begin
 if tg_table_name='trading_accounts' then
  applies:=new.challenge_type='infinity' and new.status='active';who:=new.user_id;
 elsif tg_table_name='commerce_orders' then
  applies:=new.sku='challenge_continue' and exists(select 1 from public.trading_accounts
   where id=nullif(to_jsonb(new)->>'source_account_id','')::uuid and challenge_type='infinity');who:=new.user_id;
  if tg_op='UPDATE' and to_jsonb(new)->>'source_account_id' is not distinct from to_jsonb(old)->>'source_account_id' then applies:=false;end if;
 else
  applies:=exists(select 1 from public.trading_accounts where id=new.account_id and challenge_type='infinity');who:=new.user_id;
  if tg_table_name='trades' then applies:=applies and new.status='open';
  else applies:=applies and new.status='pending';end if;
 end if;
 if applies then
  lockout:=public.fn_infinity_breach_lockout(who);
  if coalesce((lockout->>'locked')::boolean,false) then
   raise exception 'INFINITY_ACCOUNT_BREACHED_UNTIL_NEXT_MONTH:%',coalesce(lockout->>'blocked_until','REVIEW_REQUIRED');end if;
 end if;
 return new;
end $$;
revoke all on function public.fn_require_infinity_month_unlocked() from public,anon,authenticated;
create trigger infinity_month_account_insert before insert on public.trading_accounts
 for each row execute function public.fn_require_infinity_month_unlocked();
create trigger infinity_month_trade_insert before insert on public.trades
 for each row execute function public.fn_require_infinity_month_unlocked();
create trigger infinity_month_pending_insert before insert on public.pending_orders
 for each row execute function public.fn_require_infinity_month_unlocked();
-- The checkout links its source before creating a provider payment intent.
-- Blocking that link prevents charging for an ineligible continuation.
create trigger infinity_month_checkout_insert before insert on public.commerce_orders
 for each row execute function public.fn_require_infinity_month_unlocked();
-- The deployed checkout schema may not have its continuation source column
-- yet. JSON access keeps this guard valid and protects linking when present.
create trigger infinity_month_checkout_link before update on public.commerce_orders
 for each row execute function public.fn_require_infinity_month_unlocked();
commit;
