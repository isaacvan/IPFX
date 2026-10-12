-- Descriptive coverage, not a 95% certificate, predictive score, live gate or policy change.
create function public.e8_accuracy_readiness() returns jsonb
language sql stable security definer set search_path='' as $quality$
 with source as materialized (
  select t.id,a.id account_id from public.trades t join public.trading_accounts a on a.id=t.account_id
  where t.status='closed' and t.parent_trade_id is null and t.external_source is null
   and a.challenge_type='infinity' and a.status<>'demo' and coalesce(a.venue,'ipfx')='ipfx'
   and t.closed_at>now()-interval '30 days'
 ), observed as materialized (
  select s.id,r.trade_id captured,r.status,r.net_usd,
   case when r.status='USD_SCALE_UNVERIFIED' then public.e8_currency_model(s.id) end fx
  from source s left join public.e8_sim_trade_results r on r.trade_id=s.id and r.source_account_id=s.account_id and not r.is_practice
 ) select jsonb_build_object('target',0.95,'relative_net_tolerance',0.05,'minimum_usd_tolerance',0.01,'window_days',30,
  'status','NET_ACCURACY_NOT_VERIFIED','measured_net_accuracy',null,'certified_95',false,
  'source_closed_roots',count(*),'captured_roots',count(captured),
  'legacy_complete_gross',count(*) filter(where status='CLOSED_GROSS_ESTIMATE'),
  'currency_supplement_gross',count(*) filter(where fx->>'available'='true' and fx->>'fully_closed'='true'),
  'missing_archive',count(*) filter(where captured is null),
  'late_entry',count(*) filter(where status='ENTRY_OBSERVATION_AFTER_EXIT'),
  'missing_quotes',count(*) filter(where status in('REFERENCE_QUOTE_MISSING_WITHIN_WINDOW','EXIT_REFERENCE_UNAVAILABLE')),
  'unsupported_symbol',count(*) filter(where status='NO_ENABLED_REFERENCE_FOR_SYMBOL'),
  'fx_unavailable',count(*) filter(where status='USD_SCALE_UNVERIFIED' and coalesce(fx->>'available','false')<>'true'),
  'paired_broker_net',0,'unpaired_closed_roots',count(*),'basis','HISTORICAL_ESTIMATE_COVERAGE_NOT_PAIRED_NET_BENCHMARK',
  'blockers',jsonb_build_array('Complete matched broker costs and statements','Prospective frozen model predictions','Held-out trade/quantity/account binding','Independent validation blocks'))
 from observed;
$quality$;
revoke all on function public.e8_accuracy_readiness() from public,anon,authenticated;
grant execute on function public.e8_accuracy_readiness() to service_role;
