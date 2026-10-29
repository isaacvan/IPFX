begin;
-- A passed v2 parent can recover a missing child without becoming active again.
-- Recheck its qualification, review evidence and saved loss floors atomically.
do $recover$
declare src text;needle text;
begin
 select pg_get_functiondef('public.fn_advance_infinity_stage(uuid,uuid)'::regprocedure) into src;
 if position('risk:=public.fn_enforce_infinity_from_quotes(a.id);' in src)=0 then raise exception 'V2_RECOVERY_SOURCE_DRIFT';end if;
 src:=replace(src,'a.status<>''active''','(a.status<>''active'' and not(a.rules_version=''infinity_v2'' and a.status=''passed''))');
 src:=replace(src,'risk:=public.fn_enforce_infinity_from_quotes(a.id);','if a.rules_version=''infinity_v2'' and a.status=''passed'' then
 risk:=jsonb_build_object(''checked'',a.balance>=greatest(greatest(coalesce(a.trailing_peak,a.starting_balance),a.balance)-a.starting_balance*a.max_drawdown_pct/100-coalesce(a.total_paid_out,0),a.day_start_equity-a.starting_balance*a.daily_loss_pct/100));
 else risk:=public.fn_enforce_infinity_from_quotes(a.id);end if;');
 needle:=' update public.trading_accounts set status=''passed'',updated_at=now()where id=a.id and status=''active'';';
 if position(needle in src)=0 then raise exception 'V2_RECOVERY_UPDATE_DRIFT';end if;
 src:=replace(src,needle,' if a.rules_version=''infinity_v2'' and a.status=''passed'' then null;else'||chr(10)||needle);
 src:=replace(src,' if not found then raise exception ''PARENT_STATUS_CHANGED'';end if;',' if not found then raise exception ''PARENT_STATUS_CHANGED'';end if;'||chr(10)||' end if;');
 execute src;
end $recover$;
commit;
