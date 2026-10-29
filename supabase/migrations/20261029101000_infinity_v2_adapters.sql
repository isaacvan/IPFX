begin;
-- Keep exact deployed v1 bodies for audit and regression inspection. Surgical
-- additions branch on the immutable version; drift aborts the migration.
create table public.infinity_v2_legacy_definitions(signature text primary key,definition text not null);
alter table public.infinity_v2_legacy_definitions enable row level security;
revoke all on public.infinity_v2_legacy_definitions from public,anon,authenticated;
do $patch$
declare src text;sig text;needle text;
begin
 foreach sig in array array['public.fn_enforce_infinity_from_quotes(uuid)','public.fn_infinity_daily_entry_limit(uuid)',
 'public.fn_infinity_cap_closes_positions(uuid)','public.qualification_progress_v2(uuid)','public.fn_advance_infinity_stage(uuid,uuid)',
 'public.fn_infinity_counted_profit(uuid)','public.fn_infinity_quick_trade_profit(uuid,timestamp with time zone)'] loop
 select pg_get_functiondef(sig::regprocedure) into src;
 insert into public.infinity_v2_legacy_definitions values(sig,src);
 end loop;

 select definition into src from public.infinity_v2_legacy_definitions where signature='public.fn_enforce_infinity_from_quotes(uuid)';
 needle:='day_start:=case when a.created_at>=';
 if position(needle in src)=0 then raise exception 'V2_DAILY_BASELINE_SOURCE_DRIFT';end if;
 src:=replace(src,needle,'day_start:=case when a.rules_version=''infinity_v2'' then a.balance when a.created_at>=');
 execute src;

 select definition into src from public.infinity_v2_legacy_definitions where signature='public.fn_infinity_cap_closes_positions(uuid)';
 src:=replace(src,'a.daily_profit_cap_pct is null','a.daily_profit_cap_pct is null or a.rules_version=''infinity_v2''');execute src;

 select definition into src from public.infinity_v2_legacy_definitions where signature='public.fn_infinity_daily_entry_limit(uuid)';
 -- Rename the old implementation so its entire v1 control flow stays intact.
 execute replace(src,'FUNCTION public.fn_infinity_daily_entry_limit(','FUNCTION public.fn_infinity_daily_entry_limit_v1(');
 execute $body$create or replace function public.fn_infinity_daily_entry_limit(p_account uuid) returns jsonb language plpgsql security definer set search_path='' as $$
 begin if exists(select 1 from public.trading_accounts where id=p_account and rules_version='infinity_v2') then
 return jsonb_build_object('checked',true,'blocked',false,'applies',false);end if;
 return public.fn_infinity_daily_entry_limit_v1(p_account);end $$;$body$;
 execute 'revoke all on function public.fn_infinity_daily_entry_limit(uuid) from public,anon,authenticated';
 execute 'grant execute on function public.fn_infinity_daily_entry_limit(uuid) to service_role';

 select definition into src from public.infinity_v2_legacy_definitions where signature='public.qualification_progress_v2(uuid)';
 execute replace(src,'FUNCTION public.qualification_progress_v2(','FUNCTION public.qualification_progress_infinity_v1(');
 execute $body$create or replace function public.qualification_progress_v2(p_account uuid) returns jsonb language plpgsql security definer set search_path='' as $$
 begin if exists(select 1 from public.trading_accounts where id=p_account and rules_version='infinity_v2') then return public.infinity_v2_progress(p_account);end if;
 return public.qualification_progress_infinity_v1(p_account);end $$;$body$;
 execute 'revoke all on function public.qualification_progress_v2(uuid) from public,anon,authenticated';
 execute 'grant execute on function public.qualification_progress_v2(uuid) to service_role';

 select definition into src from public.infinity_v2_legacy_definitions where signature='public.fn_infinity_counted_profit(uuid)';
 execute replace(src,'FUNCTION public.fn_infinity_counted_profit(','FUNCTION public.fn_infinity_counted_profit_v1(');
 execute $body$create or replace function public.fn_infinity_counted_profit(p_account uuid) returns jsonb language plpgsql security definer set search_path='' as $$
 declare p jsonb;begin if exists(select 1 from public.trading_accounts where id=p_account and rules_version='infinity_v2') then
 p:=public.infinity_v2_progress(p_account);return jsonb_build_object('applies',true,'counted_usd',p->'counted_profit','target_usd',p->'target','met',(p->>'counted_profit')::numeric>=(p->>'target')::numeric);
 end if;return public.fn_infinity_counted_profit_v1(p_account);end $$;$body$;
 execute 'revoke all on function public.fn_infinity_counted_profit(uuid) from public,anon,authenticated';
 execute 'grant execute on function public.fn_infinity_counted_profit(uuid) to service_role';

 select definition into src from public.infinity_v2_legacy_definitions where signature='public.fn_infinity_quick_trade_profit(uuid,timestamp with time zone)';
 needle:='interval ''60 seconds''';
 if position(needle in src)=0 then raise exception 'V2_QUICK_PROFIT_SOURCE_DRIFT';end if;
 src:=replace(src,needle,'case when exists(select 1 from public.trading_accounts a where a.id=p_account_id and a.rules_version=''infinity_v2'' and t.opened_at>=a.rules_effective_at) then
 make_interval(secs=>(select (a.infinity_rules_snapshot->>''min_hold_seconds'')::int from public.trading_accounts a where a.id=p_account_id)) else interval ''60 seconds'' end');execute src;

 -- Add v2 progression inside the existing authoritative transaction, keeping
 -- all lineage, freeze, idempotency and next-preset checks intact.
 select definition into src from public.infinity_v2_legacy_definitions where signature='public.fn_advance_infinity_stage(uuid,uuid)';
 needle:=' select * into progress from public.account_progress where account_id=a.id;';
 if position(needle in src)=0 or position(' select next.*into n' in src)=0 then raise exception 'V2_ADVANCE_SOURCE_DRIFT';end if;
 src:=replace(src,needle,' if a.rules_version=''infinity_v2'' then
 qualification:=public.infinity_v2_progress(a.id);
 if not coalesce((qualification->>''eligible'')::boolean,false) then return jsonb_build_object(''ok'',false,''reason'',''V2_QUALIFICATION_INCOMPLETE'');end if;
 else'||chr(10)||needle);
 src:=replace(src,' select next.*into n',' end if;'||chr(10)||' select next.*into n');execute src;
end $patch$;
revoke all on function public.fn_infinity_daily_entry_limit_v1(uuid),public.qualification_progress_infinity_v1(uuid),public.fn_infinity_counted_profit_v1(uuid) from public,anon,authenticated;

-- Payout admissions, including administrative and direct RPC callers, must
-- respect review holds. This trigger never alters historical payouts.
create function public.infinity_v2_payout_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts;p jsonb;
begin
 select * into a from public.trading_accounts where id=new.account_id for update;
 if a.rules_version is distinct from 'infinity_v2' then return new;end if;
 if tg_op='UPDATE' and new.status is not distinct from old.status then return new;end if;
 if new.status in('requested','approved','paid') then
 if public.infinity_v2_review_hold(a.id) then raise exception 'INTEGRITY_REVIEW_REQUIRED';end if;
 if a.stage<3 then raise exception 'PAYOUT_LOCKED_BEFORE_STAGE3';end if;
 if a.stage=3 then p:=public.infinity_v2_progress(a.id);if a.status<>'passed' or not coalesce((p->>'eligible')::boolean,false) then raise exception 'STAGE3_COMPLETION_REQUIRED';end if;end if;
 end if;return new;
end $$;
create trigger infinity_v2_payout_guard before insert or update on public.payouts for each row execute function public.infinity_v2_payout_guard();
revoke all on function public.infinity_v2_payout_guard() from public,anon,authenticated;

-- An account configuration is changed only by the version trigger on initial
-- provisioning or a consented switch. Loss state and balances are untouched.
create function public.infinity_v2_account_config() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.rules_version='infinity_v2' and (tg_op='INSERT' or old.rules_version is distinct from 'infinity_v2') then
 new.min_trading_days:=0;new.min_trades:=0;new.min_profitable_days_pct:=null;new.daily_profit_cap_pct:=null;
 new.profit_target_pct:=(new.infinity_rules_snapshot->>'target_pct')::numeric;
 new.max_risk_per_trade_pct:=(new.infinity_rules_snapshot->>'risk_pct')::numeric;
 end if;return new;
end $$;
create trigger z_infinity_v2_account_config before insert or update on public.trading_accounts for each row execute function public.infinity_v2_account_config();
revoke all on function public.infinity_v2_account_config() from public,anon,authenticated;
commit;
