-- Account-specific instrument observations, not executed trades or historical contracts.
begin;
create table public.e8_instrument_evidence (
 id bigint generated always as identity primary key,
 account_id bigint not null references public.e8_monitor_profiles(account_id),
 symbol text not null, broker_symbol text not null, instrument_id text not null,
 lot_size numeric check(lot_size>0 and lot_size::text not in('NaN','Infinity','-Infinity')),
 quote_currency text check(quote_currency ~ '^[A-Z]{3}$'),
 details jsonb not null check(jsonb_typeof(details)='object'),
 observed_at timestamptz not null default clock_timestamp()
);
create index e8_instrument_latest on public.e8_instrument_evidence(account_id,symbol,observed_at desc);
alter table public.e8_instrument_evidence enable row level security;
revoke all on public.e8_instrument_evidence from public,anon,authenticated;
grant select,insert on public.e8_instrument_evidence to service_role;
grant usage,select on sequence public.e8_instrument_evidence_id_seq to service_role;
create trigger e8_instrument_frozen before update or delete on public.e8_instrument_evidence
 for each row execute function public.e8_sim_append_only();
do $patch$
declare definition text;anchor text:='p_route not in(''QUOTES'',''ORDERS_HISTORY'',''CONFIG'',''REFRESH'')';
begin
 definition:=pg_get_functiondef('public.e8_monitor_take(text,text,jsonb)'::regprocedure);
 if strpos(definition,anchor)=0 then raise exception 'E8_REQUEST_PACING_SOURCE_DRIFT';end if;
 execute replace(definition,anchor,'p_route not in(''QUOTES'',''ORDERS_HISTORY'',''CONFIG'',''REFRESH'',''INSTRUMENT_DETAILS'')');
end;$patch$;
commit;
