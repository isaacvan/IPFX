-- A/B-book Day 4: treasury engine. Forecasts what IPFX will owe traders (payout liability) over the next
-- 7/30/60/90 days, compares it with cash that can actually pay it, and records a status the executor uses
-- to tilt risk toward the strongest traders WITHIN the hard caps when cash is tight (never raising a cap).

alter table public.ab_settings add column if not exists starting_reserve_usd numeric check (starting_reserve_usd is null or starting_reserve_usd >= 0);
alter table public.ab_settings add column if not exists payout_model text not null default 'cash_at_stage3'
  check (payout_model in ('cash_at_stage3', 'sponsored_account'));
alter table public.ab_settings add column if not exists sponsor_fee_usd numeric not null default 350 check (sponsor_fee_usd >= 0);

create table if not exists public.treasury_snapshots (
  id bigint generated always as identity primary key,
  as_of timestamptz not null default now(),
  payout_model text not null,
  open_accounts int not null,
  liab_7d numeric not null, liab_30d numeric not null, liab_60d numeric not null, liab_90d numeric not null,
  liab_30d_p90 numeric not null, liab_90d_p90 numeric not null,
  graduates_30d numeric not null, graduates_90d numeric not null,
  stage4_monthly numeric not null,
  reserve_usd numeric, ladder_cash_usd numeric not null default 0, live_book_pnl_30d numeric not null default 0,
  assets_usd numeric, coverage_90d numeric,
  status text not null check (status in ('unknown', 'healthy', 'tight', 'short')),
  notes jsonb not null default '{}'::jsonb
);
create index if not exists treasury_snapshots_time on public.treasury_snapshots (as_of desc);

create table if not exists public.treasury_account_forecasts (
  snapshot_id bigint not null references public.treasury_snapshots(id) on delete cascade,
  account_id uuid not null,
  person_id uuid not null,
  stage int not null,
  p_graduate numeric not null,
  expected_days numeric not null,
  payout_if_graduate numeric not null,
  expected_payout numeric not null,
  stage4_monthly numeric not null,
  mu_mean numeric not null,
  trades int not null,
  primary key (snapshot_id, account_id)
);

alter table public.treasury_snapshots enable row level security;
alter table public.treasury_account_forecasts enable row level security;
revoke all on public.treasury_snapshots, public.treasury_account_forecasts from public, anon, authenticated;
grant select, insert, delete on public.treasury_snapshots, public.treasury_account_forecasts to service_role;

-- Latest status for the executor's tilt.
create or replace function public.treasury_status()
returns text language sql stable security definer set search_path to '' as $$
  select coalesce((select status from public.treasury_snapshots order by as_of desc limit 1), 'unknown')
$$;
revoke all on function public.treasury_status() from public, anon, authenticated;
grant execute on function public.treasury_status() to service_role;

create or replace function public.kick_treasury() returns void language plpgsql security definer set search_path to '' as $$
declare secret text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'ipfx_treasury_secret' limit 1;
  if secret is null then raise warning 'treasury not scheduled: Vault secret missing'; return; end if;
  perform net.http_post(url := 'https://agulweemteoeagscmppy.supabase.co/functions/v1/treasury',
    headers := jsonb_build_object('x-treasury-secret', secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
end $$;
revoke all on function public.kick_treasury() from public, anon, authenticated;
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'ipfx-treasury';
  perform cron.schedule('ipfx-treasury', '7 * * * *', 'select public.kick_treasury()');
  perform cron.unschedule(jobid) from cron.job where jobname = 'ipfx-treasury-purge';
  perform cron.schedule('ipfx-treasury-purge', '23 4 * * *',
    $q$delete from public.treasury_snapshots where as_of < now() - interval '30 days'$q$);
end $$;

-- Open Infinity accounts with their person (one query for the treasury worker).
create or replace view public.treasury_open_accounts with (security_invoker = true) as
select a.id, public.ab_person_of(a.user_id) as person_id, a.stage, a.starting_balance, a.balance, a.trailing_peak,
       a.profit_target_pct, a.max_drawdown_pct, a.max_risk_per_trade_pct
from public.trading_accounts a
where a.challenge_type = 'infinity' and a.status = 'active' and a.access_revoked_at is null;
revoke all on public.treasury_open_accounts from public, anon, authenticated;
grant select on public.treasury_open_accounts to service_role;
