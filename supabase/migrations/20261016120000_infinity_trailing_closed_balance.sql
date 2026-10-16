-- Infinity trailing drawdown follows the highest CLOSED balance (owner decision 2026-10-16, Terms 2.2).
-- Open profit no longer lifts the floor, so giving back an unrealised gain can never breach an account; a real loss
-- (equity, including open trades, falling the limit below the best closed balance) still breaches at once.
-- Applies to every Infinity stage and every current run (the change only ever helps the trader).
begin;
alter table public.trading_accounts drop constraint trading_accounts_drawdown_mode_check;
alter table public.trading_accounts add constraint trading_accounts_drawdown_mode_check
 check (drawdown_mode = any (array['static','trailing_intraday','trailing_eod','trailing_balance']));

do $guard$declare src text;
 a1 text:='coalesce(a.drawdown_mode,''static'') in(''static'',''trailing_intraday'',''trailing_eod'')';
 a2 text:='if a.drawdown_mode=''trailing_intraday'' then peak:=greatest(peak,eq); end if;';
begin
 src:=pg_get_functiondef('public.fn_enforce_infinity_from_quotes(uuid)'::regprocedure);
 if array_length(string_to_array(src,a1),1)<>2 or array_length(string_to_array(src,a2),1)<>2 then raise exception 'TRAILING_BALANCE_GUARD_SOURCE_DRIFT';end if;
 src:=replace(src,a1,'coalesce(a.drawdown_mode,''static'') in(''static'',''trailing_intraday'',''trailing_eod'',''trailing_balance'')');
 src:=replace(src,a2,a2||E'\n if a.drawdown_mode=''trailing_balance'' then peak:=greatest(peak,a.balance); end if;');
 execute src;
end $guard$;

update public.challenge_presets set drawdown_mode='trailing_balance' where challenge_type='infinity';

-- Current Infinity runs: switch mode and reset the peak to the best closed balance (never below the starting balance).
with closed as (
 select t.account_id, t.closed_at, sum(t.pnl) over (partition by t.account_id order by t.closed_at, t.id) cum
 from public.trades t join public.trading_accounts a on a.id=t.account_id
 where a.challenge_type='infinity' and a.status='active' and t.status='closed' and t.pnl is not null),
best as (select account_id, max(cum) best from closed group by 1)
update public.trading_accounts a set drawdown_mode='trailing_balance',
 trailing_peak=greatest(a.starting_balance, a.starting_balance+coalesce(b.best,0)),
 updated_at=clock_timestamp()
from (select id from public.trading_accounts where challenge_type='infinity' and status='active') x left join best b on b.account_id=x.id
where a.id=x.id;

insert into public.platform_legal_documents(version,kind,source_sha256,document_url)
 values('2026-10-16-2.2','terms','16c8067e08e430d7f60a8a96ef6773dbb4f870ab7449482fead78be466b56f37','/legal/2026-10-16-v2.2/terms.html');
update public.platform_legal_current set version='2026-10-16-2.2' where kind='terms';
commit;
