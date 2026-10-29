begin;
-- Revalue v2 accounts using the same spread profile used for their fills.
-- The shared quote-equity implementation keeps its v1 expression unchanged.
do $mark$
declare src text;
begin
 select pg_get_functiondef('public.fn_infinity_quote_equity(uuid)'::regprocedure) into src;
 if position('q.bid-t.open_price' in src)=0 or position('t.open_price-q.ask' in src)=0 then raise exception 'V2_MARK_SOURCE_DRIFT';end if;
 insert into public.infinity_v2_legacy_definitions values('public.fn_infinity_quote_equity(uuid)',src);
 src:=replace(src,'q.bid-t.open_price','(case when a.rules_version=''infinity_v2'' then (public.infinity_v2_price(t.symbol)->>''bid'')::numeric else q.bid end)-t.open_price');
 src:=replace(src,'t.open_price-q.ask','t.open_price-(case when a.rules_version=''infinity_v2'' then (public.infinity_v2_price(t.symbol)->>''ask'')::numeric else q.ask end)');execute src;
end $mark$;

create function public.infinity_v2_read_progress(p_account uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select case when c.account_id is null or c.dirty or c.updated_at<clock_timestamp()-interval '1 minute' then
 coalesce(c.result,jsonb_build_object('applies',true,'n',0,'score',0,'combined_score',0,'counted_profit',0,'rules',a.infinity_rules_snapshot,
 'target',a.starting_balance*(a.infinity_rules_snapshot->>'target_pct')::numeric/100)) || jsonb_build_object('eligible',false,'scoring_pending',true,'unmet',jsonb_build_array('SCORING_UPDATE_PENDING'))
 else c.result end
 from public.trading_accounts a left join public.infinity_v2_progress_cache c on c.account_id=a.id where a.id=p_account and a.rules_version='infinity_v2';
$$;
revoke all on function public.infinity_v2_read_progress(uuid) from public,anon,authenticated;
grant execute on function public.infinity_v2_read_progress(uuid) to service_role;

-- Retain the canonical warning/claim transaction so the breach audit is never skipped.
do $strike$
declare src text;needle text:='if n>=3 and a.status=''active''';
begin
 select pg_get_functiondef('public.fn_sl_warning_on_close()'::regprocedure) into src;
 if position(needle in src)=0 then raise exception 'SL_WARNING_SOURCE_DRIFT';end if;
 insert into public.infinity_v2_legacy_definitions values('public.fn_sl_warning_on_close()',src);
 src:=replace(src,needle,'if n>=(case when a.rules_version=''infinity_v2'' then (a.infinity_rules_snapshot->>''sl_strikes_max'')::int else 3 end) and a.status=''active''');execute src;
end $strike$;
commit;
