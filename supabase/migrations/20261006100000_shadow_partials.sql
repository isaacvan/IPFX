-- Shadow copy: partial closes (owner request 2026-10-06).
-- The demo copy is the broker's minimum lot, which cannot be split. When a trader closes part of a position the
-- demo account's own bid/ask is read at that moment (the side a close would use: bid for a long, ask for a short)
-- and stored against that slice. No extra order is sent. The funded-size result then weights every exit (each
-- slice and the final close) by its share of the original position.

create table if not exists public.shadow_slices (
  id bigint generated always as identity primary key,
  source_trade_id uuid not null references public.trades (id) on delete cascade,
  slice_trade_id uuid not null unique references public.trades (id) on delete cascade,
  account_id bigint not null references public.ladder_accounts (id) on delete restrict,
  exit_price numeric, bid numeric, ask numeric, priced_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists shadow_slices_trade on public.shadow_slices (source_trade_id);
create index if not exists shadow_slices_unpriced on public.shadow_slices (created_at) where exit_price is null;
alter table public.shadow_slices enable row level security;
revoke all on public.shadow_slices from public, anon, authenticated;
grant select, insert, update, delete on public.shadow_slices to service_role;

-- Same maths as 20261005170000, now with partial exits:
--   total volume   = remaining volume of the original trade + every closed slice
--   copy_scaled    = direction x price scale x (sum over exits of exit volume x (exit price - entry)) x funded size / trader's account size
--   extra E8 cost  = ((E8 spread - demo spread) x price scale + commission difference per lot) x funded lots
--   A trade with any slice still unpriced is left out (counted in 'incomplete') rather than guessed.
create or replace function public.shadow_funded_summary(p_days int default 7, p_funded numeric default 50000)
returns jsonb language sql stable security definer set search_path to '' as $$
  with cs as (select public.cost_summary(p_days) j),
  sp as (select x->>'symbol' symbol, greatest(0, coalesce((x->>'e8')::numeric, 0) - coalesce((x->>'demo')::numeric, 0)) extra
         from cs, jsonb_array_elements(cs.j->'spreads') x),
  cm as (select coalesce(max((x->>'per_lot')::numeric) filter (where x->>'role' = 'monitor'), 0) e8,
                coalesce(max((x->>'per_lot')::numeric) filter (where x->>'role' = 'shadow'), 0) demo
         from cs, jsonb_array_elements(cs.j->'commission') x),
  raw as (
    select o.source_trade_id, o.person_id, o.symbol, ta.starting_balance size_usd, o.price_scale_per_lot scale,
           case when o.side = 'buy' then 1 else -1 end dir, o.fill_price entry, c.fill_price final_exit,
           t.volume final_vol, coalesce(t.pnl, 0) final_pnl,
           coalesce(sl.vol, 0) slice_vol, coalesce(sl.vol_move, 0) slice_vol_move, coalesce(sl.pnl, 0) slice_pnl,
           coalesce(sl.all_priced, true) all_priced
    from public.shadow_orders o
    join public.shadow_orders c on c.source_trade_id = o.source_trade_id and c.event = 'close' and c.status = 'closed' and c.fill_price is not null
    join public.trades t on t.id = o.source_trade_id and t.status = 'closed'
    join public.trading_accounts ta on ta.id = t.account_id
    left join lateral (
      select sum(tr.volume) vol, sum(tr.volume * (s.exit_price - o.fill_price)) vol_move, sum(coalesce(tr.pnl, 0)) pnl,
             bool_and(s.exit_price is not null) all_priced
      from public.shadow_slices s join public.trades tr on tr.id = s.slice_trade_id
      where s.source_trade_id = o.source_trade_id) sl on true
    where o.event = 'open' and o.status in ('filled', 'closed') and o.fill_price is not null and o.price_scale_per_lot > 0
      and t.closed_at > now() - make_interval(days => p_days) and ta.starting_balance > 0
  ),
  net as (
    select r.person_id, r.symbol,
           r.dir * r.scale * (r.final_vol * (r.final_exit - r.entry) + r.slice_vol_move) * p_funded / r.size_usd copy_scaled,
           r.dir * r.scale * (r.final_vol * (r.final_exit - r.entry) + r.slice_vol_move) * p_funded / r.size_usd
             - (coalesce(sp.extra, 0) * r.scale + greatest(0, cm.e8 - cm.demo)) * (r.final_vol + r.slice_vol) * p_funded / r.size_usd funded_net,
           (r.final_pnl + r.slice_pnl) * p_funded / r.size_usd ipfx_scaled
    from raw r left join sp on sp.symbol = r.symbol cross join cm
    where r.all_priced
  )
  select jsonb_build_object(
    'funded_size', p_funded,
    'trades', (select count(*) from net),
    'incomplete', (select count(*) from raw where not all_priced),
    'ipfx_scaled', (select round(coalesce(sum(ipfx_scaled), 0), 2) from net),
    'copy_scaled', (select round(coalesce(sum(copy_scaled), 0), 2) from net),
    'extra_cost', (select round(coalesce(sum(copy_scaled - funded_net), 0), 2) from net),
    'funded_net', (select round(coalesce(sum(funded_net), 0), 2) from net),
    'gap', (select round(coalesce(sum(ipfx_scaled - funded_net), 0), 2) from net),
    'coverage', jsonb_build_object(
      'copied', (select count(*) from public.shadow_orders where event = 'open' and status in ('filled', 'closed') and created_at > now() - make_interval(days => p_days)),
      'failed', (select count(*) from public.shadow_orders where event = 'open' and status in ('error', 'reconciliation_required') and created_at > now() - make_interval(days => p_days)),
      'partials', (select count(*) from public.shadow_slices where created_at > now() - make_interval(days => p_days)),
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
