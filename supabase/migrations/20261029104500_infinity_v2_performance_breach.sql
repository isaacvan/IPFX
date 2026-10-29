begin;
alter table public.account_breach_events drop constraint if exists account_breach_events_reason_check;
alter table public.account_breach_events add constraint account_breach_events_reason_check check(reason in('max_drawdown','daily_loss','stop_loss_rule','performance_rule'));
do $performance$
declare src text;needle text:='p_reason not in (''max_drawdown'',''daily_loss'',''stop_loss_rule'')';
begin
 select pg_get_functiondef('public.fn_claim_account_breach(uuid,text,numeric,numeric)'::regprocedure) into src;
 if position(needle in src)=0 then raise exception 'BREACH_CLAIM_SOURCE_DRIFT';end if;
 insert into public.infinity_v2_legacy_definitions values('public.fn_claim_account_breach(uuid,text,numeric,numeric)',src);
 src:=replace(src,needle,'(p_reason not in (''max_drawdown'',''daily_loss'',''stop_loss_rule'') and not(p_reason=''performance_rule'' and exists(select 1 from public.trading_accounts v where v.id=p_account_id and v.rules_version=''infinity_v2'' and v.stage=4)))');
 execute src;
end $performance$;
commit;
