-- Cost monitor (owner request 2026-10-05): compare real trading costs on the owner's E8 funded account with
-- the TradeLocker demo accounts that receive every trader's copies, and with IPFX's own price feed, so the
-- Brain can turn demo results into what they would really have been on E8.
--
-- Account roles in ladder_accounts:
--   ladder  - prop evaluation / funded accounts that receive A-book copies (as before)
--   shadow  - TradeLocker demo accounts that receive copies of every trader (about 200 traders each)
--   monitor - the E8 funded account: READ ONLY. The database refuses copying on it, and the monitor uses a
--             client with no order functions.

alter table public.ladder_accounts add column if not exists role text not null default 'ladder';
alter table public.ladder_accounts add column if not exists api_env text not null default 'demo';
alter table public.ladder_accounts drop constraint if exists ladder_accounts_role_check;
alter table public.ladder_accounts add constraint ladder_accounts_role_check check (role in ('ladder', 'shadow', 'monitor'));
alter table public.ladder_accounts drop constraint if exists ladder_accounts_api_env_check;
alter table public.ladder_accounts add constraint ladder_accounts_api_env_check check (api_env in ('demo', 'live'));
alter table public.ladder_accounts drop constraint if exists ladder_accounts_monitor_never_trades;
alter table public.ladder_accounts add constraint ladder_accounts_monitor_never_trades check (role <> 'monitor' or execution_enabled = false);

create table if not exists public.cost_samples (
  id bigint generated always as identity primary key,
  account_id bigint not null references public.ladder_accounts (id) on delete cascade,
  role text not null, symbol text not null,
  bid numeric not null, ask numeric not null, spread numeric not null,
  ipfx_bid numeric, ipfx_ask numeric, ipfx_spread numeric,
  sampled_at timestamptz not null default now()
);
create index if not exists cost_samples_symbol_time on public.cost_samples (symbol, sampled_at desc);
alter table public.cost_samples enable row level security;
revoke all on public.cost_samples from public, anon, authenticated;
grant select, insert, delete on public.cost_samples to service_role;

create table if not exists public.cost_fills (
  id bigint generated always as identity primary key,
  account_id bigint not null references public.ladder_accounts (id) on delete cascade,
  role text not null, ref text not null,
  symbol text, side text, qty numeric, price numeric, commission numeric, swap numeric,
  raw jsonb not null, filled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (account_id, ref)
);
alter table public.cost_fills enable row level security;
revoke all on public.cost_fills from public, anon, authenticated;
grant select, insert, update on public.cost_fills to service_role;

-- Per instrument: average spread on E8 (monitor), on the demo accounts (shadow) and on IPFX's feed at the same
-- moments, plus commission per lot by role, over the last p_days.
create or replace function public.cost_summary(p_days int default 7)
returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object(
    'spreads', coalesce((select jsonb_agg(x order by x->>'symbol') from (
      select jsonb_build_object('symbol', symbol,
        'e8', round(avg(spread) filter (where role = 'monitor'), 6),
        'demo', round(avg(spread) filter (where role = 'shadow'), 6),
        'ipfx', round(avg(ipfx_spread), 6),
        'e8_vs_demo', round(avg(spread) filter (where role = 'monitor') - avg(spread) filter (where role = 'shadow'), 6),
        'samples', count(*), 'last', max(sampled_at)) x
      from public.cost_samples where sampled_at > now() - make_interval(days => p_days)
      group by symbol) q), '[]'::jsonb),
    'commission', coalesce((select jsonb_agg(jsonb_build_object('role', role, 'fills', n, 'per_lot', per_lot)) from (
      select role, count(*) n, round(sum(abs(coalesce(commission, 0))) / nullif(sum(abs(qty)), 0), 4) per_lot
      from public.cost_fills where created_at > now() - make_interval(days => p_days) group by role) c), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'role', role, 'api_env', api_env,
        'last_sample', (select max(sampled_at) from public.cost_samples s where s.account_id = l.id)))
      from public.ladder_accounts l where role in ('monitor', 'shadow')), '[]'::jsonb)
  );
$$;
revoke all on function public.cost_summary(int) from public, anon, authenticated;
grant execute on function public.cost_summary(int) to service_role;

-- Every minute, via a dedicated secret (Vault: ipfx_cost_monitor_secret, set outside migrations).
create or replace function public.kick_cost_monitor() returns void language plpgsql security definer set search_path to '' as $$
declare secret text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'ipfx_cost_monitor_secret' limit 1;
  if secret is null then raise warning 'cost-monitor not scheduled: Vault secret missing'; return; end if;
  if not exists (select 1 from public.ladder_accounts where role in ('monitor', 'shadow') and access_token_ciphertext is not null) then return; end if;
  perform net.http_post(
    url := 'https://agulweemteoeagscmppy.supabase.co/functions/v1/cost-monitor',
    headers := jsonb_build_object('x-cost-secret', secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 30000);
end $$;
revoke all on function public.kick_cost_monitor() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('ipfx-cost-monitor', 'ipfx-cost-samples-purge');
  perform cron.schedule('ipfx-cost-monitor', '* * * * *', 'select public.kick_cost_monitor()');
  perform cron.schedule('ipfx-cost-samples-purge', '33 3 * * *', $c$delete from public.cost_samples where sampled_at < now() - interval '60 days'$c$);
end $$;
