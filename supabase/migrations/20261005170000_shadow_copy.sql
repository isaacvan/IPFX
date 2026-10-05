-- Shadow copy (owner request 2026-10-05): every trader's trades are copied at the broker's MINIMUM size onto
-- TradeLocker demo accounts (role 'shadow', about 200 traders per account). The Brain then scales each result
-- to what it would have been on a funded account of the same relative size, with E8's measured extra costs.
-- Kept apart from book_orders so A-book / B-book analytics and risk reservations are untouched.

create table if not exists public.shadow_assignments (
  person_id uuid primary key,
  account_id bigint not null references public.ladder_accounts (id) on delete restrict,
  assigned_at timestamptz not null default now()
);
create index if not exists shadow_assignments_account on public.shadow_assignments (account_id);

create table if not exists public.shadow_orders (
  id bigint generated always as identity primary key,
  source_trade_id uuid not null references public.trades (id) on delete cascade,
  person_id uuid not null,
  account_id bigint not null references public.ladder_accounts (id) on delete restrict,
  event text not null check (event in ('open', 'close')),
  idempotency_key text not null unique,
  symbol text not null,
  side text not null check (side in ('buy', 'sell')),
  qty numeric not null check (qty > 0),
  status text not null check (status in ('sent', 'filled', 'closed', 'skipped', 'error', 'reconciliation_required')),
  broker_order_id text, broker_position_id text, fill_price numeric,
  price_scale_per_lot numeric,
  latency_ms int, error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists shadow_orders_trade on public.shadow_orders (source_trade_id, event);
create index if not exists shadow_orders_status on public.shadow_orders (status, created_at) where status in ('sent', 'reconciliation_required', 'filled');
alter table public.shadow_assignments enable row level security;
alter table public.shadow_orders enable row level security;
revoke all on public.shadow_assignments, public.shadow_orders from public, anon, authenticated;
grant select, insert, update, delete on public.shadow_assignments, public.shadow_orders to service_role;

-- Permanent assignment: a trader always lands on the same demo account (so one account's history is one
-- group of people). New traders go to the least-filled enabled shadow account that has room (200 each).
create or replace function public.fn_shadow_account(p_person uuid, p_cap int default 200)
returns bigint language plpgsql security definer set search_path to '' as $$
declare acct bigint;
begin
  select a.account_id into acct from public.shadow_assignments a
    join public.ladder_accounts l on l.id = a.account_id and l.role = 'shadow' and l.execution_enabled and l.access_token_ciphertext is not null
    where a.person_id = p_person;
  if acct is not null then return acct; end if;
  perform pg_advisory_xact_lock(hashtext('shadow_assign'));
  select l.id into acct from public.ladder_accounts l
    where l.role = 'shadow' and l.execution_enabled and l.access_token_ciphertext is not null
      and (select count(*) from public.shadow_assignments a where a.account_id = l.id) < p_cap
    order by (select count(*) from public.shadow_assignments a where a.account_id = l.id), l.id limit 1;
  if acct is null then return null; end if;
  insert into public.shadow_assignments (person_id, account_id) values (p_person, acct)
    on conflict (person_id) do update set account_id = excluded.account_id, assigned_at = now();
  return acct;
end $$;
revoke all on function public.fn_shadow_account(uuid, int) from public, anon, authenticated;
grant execute on function public.fn_shadow_account(uuid, int) to service_role;

-- Funded-size results. For each trade whose demo copy opened and closed:
--   copy_gross  = demo price move x demo lots x price scale          (what the demo account made)
--   factor      = funded lots / demo lots, funded lots = trader lots x funded size / trader's account size
--   extra cost  = (E8 spread - demo spread) x price scale x funded lots + (E8 - demo commission per lot) x funded lots
--   funded_net  = copy_gross x factor - extra cost                    (what E8 would really have paid out)
--   ipfx_scaled = the trader's own IPFX result scaled the same way; gap = ipfx_scaled - funded_net
create or replace function public.shadow_funded_summary(p_days int default 7, p_funded numeric default 50000)
returns jsonb language sql stable security definer set search_path to '' as $$
  with cs as (select public.cost_summary(p_days) j),
  sp as (select x->>'symbol' symbol, greatest(0, coalesce((x->>'e8')::numeric, 0) - coalesce((x->>'demo')::numeric, 0)) extra
         from cs, jsonb_array_elements(cs.j->'spreads') x),
  cm as (select coalesce(max((x->>'per_lot')::numeric) filter (where x->>'role' = 'monitor'), 0) e8,
                coalesce(max((x->>'per_lot')::numeric) filter (where x->>'role' = 'shadow'), 0) demo
         from cs, jsonb_array_elements(cs.j->'commission') x),
  pairs as (
    select o.person_id, o.symbol, t.volume, t.pnl ipfx_pnl, ta.starting_balance size_usd,
           o.qty, o.price_scale_per_lot scale,
           (c.fill_price - o.fill_price) * case when o.side = 'buy' then 1 else -1 end * o.qty * o.price_scale_per_lot copy_gross
    from public.shadow_orders o
    join public.shadow_orders c on c.source_trade_id = o.source_trade_id and c.event = 'close' and c.status = 'closed' and c.fill_price is not null
    join public.trades t on t.id = o.source_trade_id and t.status = 'closed'
    join public.trading_accounts ta on ta.id = t.account_id
    where o.event = 'open' and o.status in ('filled', 'closed') and o.fill_price is not null and o.price_scale_per_lot > 0
      and t.closed_at > now() - make_interval(days => p_days) and ta.starting_balance > 0
  ),
  net as (
    select p.person_id, p.symbol,
           p.copy_gross * ((p.volume * p_funded / p.size_usd) / p.qty) copy_scaled,
           p.copy_gross * ((p.volume * p_funded / p.size_usd) / p.qty)
             - (coalesce(sp.extra, 0) * p.scale * (p.volume * p_funded / p.size_usd)
                + greatest(0, cm.e8 - cm.demo) * (p.volume * p_funded / p.size_usd)) funded_net,
           coalesce(p.ipfx_pnl, 0) * p_funded / p.size_usd ipfx_scaled
    from pairs p left join sp on sp.symbol = p.symbol cross join cm
  )
  select jsonb_build_object(
    'funded_size', p_funded,
    'trades', (select count(*) from net),
    'ipfx_scaled', (select round(coalesce(sum(ipfx_scaled), 0), 2) from net),
    'copy_scaled', (select round(coalesce(sum(copy_scaled), 0), 2) from net),
    'extra_cost', (select round(coalesce(sum(copy_scaled - funded_net), 0), 2) from net),
    'funded_net', (select round(coalesce(sum(funded_net), 0), 2) from net),
    'gap', (select round(coalesce(sum(ipfx_scaled - funded_net), 0), 2) from net),
    'coverage', jsonb_build_object(
      'copied', (select count(*) from public.shadow_orders where event = 'open' and status in ('filled', 'closed') and created_at > now() - make_interval(days => p_days)),
      'failed', (select count(*) from public.shadow_orders where event = 'open' and status in ('error', 'reconciliation_required') and created_at > now() - make_interval(days => p_days)),
      'traders', (select count(*) from public.shadow_assignments),
      'accounts', (select count(*) from public.ladder_accounts where role = 'shadow' and execution_enabled)),
    'people', coalesce((select jsonb_agg(r order by (r->>'gap')::numeric desc) from (
        select jsonb_build_object('person_id', person_id, 'trades', count(*), 'ipfx_scaled', round(sum(ipfx_scaled), 2),
               'funded_net', round(sum(funded_net), 2), 'gap', round(sum(ipfx_scaled - funded_net), 2)) r
        from net group by person_id order by sum(ipfx_scaled - funded_net) desc limit 20) q), '[]'::jsonb)
  );
$$;
revoke all on function public.shadow_funded_summary(int, numeric) from public, anon, authenticated;
grant execute on function public.shadow_funded_summary(int, numeric) to service_role;
