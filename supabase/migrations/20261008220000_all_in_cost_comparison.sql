-- All-in cost comparison, E8 vs IPFX (owner request 2026-10-08).
-- The Brain compared SPREADS only. E8's raw-spread account has a tiny spread plus a commission, and IPFX charges its own
-- commission per lot (symbol_specs, default $6 on forex and gold), so spread alone made IPFX look worse than it is on
-- some instruments and hid the commission on others. This compares ALL-IN cost per standard lot = spread x contract size
-- (in USD) + commission, using the MEDIAN of same-moment samples so a rollover spike cannot skew it.
--
-- The E8 commission is an ESTIMATE: E8's own order history has no commission field, and public sources say about $5 to $5.50
-- per lot round turn on raw-spread forex. Nothing is known for metals, indices or crypto, so those are 0. Edit
-- public.cost_symbol_model.e8_commission_per_lot when the real figure is known; every number follows.
create table if not exists public.cost_symbol_model (
  symbol text primary key,
  contract numeric not null check (contract > 0),
  quote_ccy text not null check (quote_ccy in ('USD', 'JPY', 'CAD', 'CHF', 'GBP', 'EUR')),
  e8_commission_per_lot numeric not null default 0 check (e8_commission_per_lot >= 0),
  ipfx_commission_per_lot numeric not null default 0 check (ipfx_commission_per_lot >= 0),
  note text
);
alter table public.cost_symbol_model enable row level security;
revoke all on public.cost_symbol_model from public, anon, authenticated;
grant select, insert, update on public.cost_symbol_model to service_role;
insert into public.cost_symbol_model (symbol, contract, quote_ccy, e8_commission_per_lot, ipfx_commission_per_lot, note) values
  ('EURUSD', 100000, 'USD', 5.5, 6, 'forex'), ('GBPUSD', 100000, 'USD', 5.5, 6, 'forex'), ('USDJPY', 100000, 'JPY', 5.5, 6, 'forex'),
  ('AUDUSD', 100000, 'USD', 5.5, 6, 'forex'), ('USDCAD', 100000, 'CAD', 5.5, 6, 'forex'), ('USDCHF', 100000, 'CHF', 5.5, 6, 'forex'),
  ('NZDUSD', 100000, 'USD', 5.5, 6, 'forex'), ('GBPJPY', 100000, 'JPY', 5.5, 6, 'forex'), ('EURJPY', 100000, 'JPY', 5.5, 6, 'forex'),
  ('EURGBP', 100000, 'GBP', 5.5, 6, 'forex'), ('EURCAD', 100000, 'CAD', 5.5, 6, 'forex'), ('AUDCAD', 100000, 'CAD', 5.5, 6, 'forex'),
  ('XAUUSD', 100, 'USD', 0, 6, 'gold: E8 commission unknown'), ('XAGUSD', 5000, 'USD', 0, 6, 'silver: E8 commission unknown'),
  ('SPXUSD', 10, 'USD', 0, 0, 'index: E8 commission unknown'), ('NSXUSD', 10, 'USD', 0, 0, 'index: E8 commission unknown'),
  ('DJI', 10, 'USD', 0, 0, 'index: E8 commission unknown'), ('GER40', 10, 'EUR', 0, 0, 'index: E8 commission unknown'),
  ('JPN225', 10, 'JPY', 0, 0, 'index: E8 commission unknown'),
  ('BTCUSD', 1, 'USD', 0, 0, 'crypto: E8 commission unknown'), ('ETHUSD', 1, 'USD', 0, 0, 'crypto: E8 commission unknown'),
  ('LTCUSD', 1, 'USD', 0, 0, 'crypto: E8 commission unknown'), ('ADAUSD', 1, 'USD', 0, 0, 'crypto: E8 commission unknown'),
  ('SOLUSD', 1, 'USD', 0, 0, 'crypto: E8 commission unknown')
on conflict (symbol) do nothing;

create or replace function public.cost_allin(p_hours int default 24)
returns table (symbol text, e8_spread numeric, ipfx_spread numeric, e8_usd numeric, ipfx_usd numeric,
               e8_commission numeric, ipfx_commission numeric, ratio numeric, samples bigint)
language sql stable security definer set search_path to '' as $$
  with s as (
    select c.symbol,
           (percentile_cont(0.5) within group (order by c.spread))::numeric as e8,
           (percentile_cont(0.5) within group (order by c.ipfx_spread))::numeric as ip,
           count(*) as n
    from public.cost_samples c
    where c.role = 'monitor' and c.ipfx_spread is not null and c.spread > 0
      and c.sampled_at > now() - make_interval(hours => p_hours)
    group by c.symbol
  ), px as (select q.symbol, (q.bid + q.ask) / 2 as mid from public.live_quotes q),
  base as (
    select s.symbol, s.e8, s.ip, s.n, m.e8_commission_per_lot as e8c,
           coalesce(sp.commission_per_lot_usd, m.ipfx_commission_per_lot) as ipc,
           s.e8 * m.contract * (case m.quote_ccy
              when 'USD' then 1::numeric
              when 'JPY' then 1 / nullif((select mid from px where px.symbol = 'USDJPY'), 0)
              when 'CAD' then 1 / nullif((select mid from px where px.symbol = 'USDCAD'), 0)
              when 'CHF' then 1 / nullif((select mid from px where px.symbol = 'USDCHF'), 0)
              when 'GBP' then (select mid from px where px.symbol = 'GBPUSD')
              when 'EUR' then (select mid from px where px.symbol = 'EURUSD') end) as e8_spread_usd,
           s.ip * m.contract * (case m.quote_ccy
              when 'USD' then 1::numeric
              when 'JPY' then 1 / nullif((select mid from px where px.symbol = 'USDJPY'), 0)
              when 'CAD' then 1 / nullif((select mid from px where px.symbol = 'USDCAD'), 0)
              when 'CHF' then 1 / nullif((select mid from px where px.symbol = 'USDCHF'), 0)
              when 'GBP' then (select mid from px where px.symbol = 'GBPUSD')
              when 'EUR' then (select mid from px where px.symbol = 'EURUSD') end) as ip_spread_usd
    from s join public.cost_symbol_model m on m.symbol = s.symbol
    left join public.symbol_specs sp on sp.symbol = s.symbol
  )
  select b.symbol, round(b.e8, 8), round(b.ip, 8),
         round(b.e8_spread_usd + b.e8c, 2), round(b.ip_spread_usd + b.ipc, 2), b.e8c, b.ipc,
         round((b.ip_spread_usd + b.ipc) / nullif(b.e8_spread_usd + b.e8c, 0), 3), b.n
  from base b where b.e8_spread_usd is not null and b.ip_spread_usd is not null;
$$;
revoke all on function public.cost_allin(int) from public, anon, authenticated;
grant execute on function public.cost_allin(int) to service_role;

-- cost_summary: unchanged except for the new 'allin' array (7-day medians).
CREATE OR REPLACE FUNCTION public.cost_summary(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'allin', coalesce((select jsonb_agg(to_jsonb(a) order by a.symbol) from public.cost_allin(p_days * 24) a), '[]'::jsonb),
    'spreads', coalesce((select jsonb_agg(x order by x->>'symbol') from (
      select jsonb_build_object('symbol', symbol,
        'e8', round(avg(spread) filter (where role = 'monitor'), 6),
        'demo', round(avg(spread) filter (where role = 'shadow'), 6),
        'ipfx', round(avg(ipfx_spread), 6),
        'e8_vs_demo', round(avg(spread) filter (where role = 'monitor') - avg(spread) filter (where role = 'shadow'), 6),
        'ipfx_vs_e8', round(avg(ipfx_spread) filter (where role = 'monitor') / nullif(avg(spread) filter (where role = 'monitor'), 0), 3),
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
$function$;

-- Brain scan: one summary cost-parity alert instead of one per instrument (redefined from the live function).
CREATE OR REPLACE FUNCTION public.ab_alerts_scan()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare started timestamptz := clock_timestamp(); n_open int; n_new int;
begin
  create temp table if not exists _alert_now (key text primary key, severity text, category text, title text, detail text, person_id uuid, value numeric) on commit drop;
  truncate _alert_now;

  -- System: the brain's own moving parts.
  insert into _alert_now
  select 'system:' || j.name, 'critical', 'system', j.title,
         case when h.age_s is null then 'No successful run found.' else 'Last successful run ' || round(h.age_s / 60) || ' minutes ago (latest: ' || coalesce(h.last_status, '?') || ').' end,
         null, h.age_s
  from (values ('ipfx-ab-ledger', 'Trade ledger has stopped updating', 300),
               ('ipfx-drawdown-sweep', 'Account rule checks (drawdown sweep) have stopped', 120),
               ('ipfx-book-reconcile', 'Copy-order reconciler has stopped', 300)) as j(name, title, max_age)
  cross join lateral public.ab_cron_health(j.name) h
  where h.age_s is null or h.age_s > j.max_age
  on conflict (key) do nothing;

  insert into _alert_now
  select 'system:classifier', 'critical', 'system', 'The classifier (box mover) is not running cleanly',
         case when hb.worker is null then 'No heartbeat yet.' when not hb.ok then 'Last run failed: ' || coalesce(hb.detail->>'error', 'unknown error') || '.'
              else 'Last run ' || round(extract(epoch from now() - hb.at) / 60) || ' minutes ago.' end, null, null
  from (select 1) x left join public.ab_heartbeats hb on hb.worker = 'ab-classifier'
  where hb.worker is null or not hb.ok or hb.at < now() - interval '5 minutes'
  on conflict (key) do nothing;

  -- The IPFX hub (free server: live prices + tick-by-tick position watcher). Only once it has reported at least
  -- once. A quiet feed only counts while the FX market is open (no prices change at the weekend).
  insert into _alert_now
  select 'system:hub', 'critical', 'system', 'The IPFX hub (live prices + position watcher) is not running cleanly',
         case when hb.at < now() - interval '2 minutes' then 'No report for ' || round(extract(epoch from now() - hb.at) / 60) || ' minutes. Trading pages have fallen back to Supabase prices and checks.'
              else 'Last report unhealthy (' || coalesce(hb.detail->>'ingestAgeMs', '?') || ' ms since the last price). Pages fall back automatically.' end, null, null
  from public.ab_heartbeats hb
  where hb.worker = 'hub' and (hb.at < now() - interval '2 minutes' or (not hb.ok and public.ab_fx_market_open()))
  on conflict (key) do nothing;

  insert into _alert_now
  select 'system:treasury', 'warning', 'system', 'Payout forecast is out of date',
         'Last forecast ' || coalesce(round(extract(epoch from now() - max(as_of)) / 3600, 1)::text, 'never') || ' hours ago (it runs hourly).', null, null
  from public.treasury_snapshots having max(as_of) is null or max(as_of) < now() - interval '3 hours'
  on conflict (key) do nothing;

  insert into _alert_now
  select 'system:prices', 'critical', 'system', 'Live prices have stopped while the market is open',
         'Newest price is ' || coalesce(round(extract(epoch from now() - max(received_at)))::text, '?') || ' seconds old.', null, null
  from public.live_quotes
  having public.ab_fx_market_open() and (max(received_at) is null or max(received_at) < now() - interval '2 minutes')
  on conflict (key) do nothing;

  -- Cost parity (owner policy 2026-10-05, made all-in 2026-10-08): IPFX should cost traders about what the E8 funded account
  -- does. All-in = spread + commission for a standard lot (cost_allin), median of the last hour, at least 10 samples taken at
  -- the same moments. One summary alert instead of one per instrument. The E8 commission is an estimate (cost_symbol_model).
  insert into _alert_now
  select 'cost:parity', 'warning', 'system',
         'IPFX costs differ from the E8 funded account on ' || (x.dearer + x.cheaper) || ' of ' || x.total || ' instruments',
         x.dearer || ' dearer and ' || x.cheaper || ' cheaper than E8 (aim for 80% to 125% of E8, all-in per lot). Furthest apart: ' || x.worst || '. The E8 commission is an estimate.',
         null, x.dearer + x.cheaper
  from (select count(*) filter (where ratio > 1.25) as dearer, count(*) filter (where ratio < 0.8) as cheaper, count(*) as total,
               (select string_agg(w.symbol || ' ' || round(100 * w.ratio) || '%', ', ' order by abs(ln(w.ratio)) desc)
                from (select symbol, ratio from public.cost_allin(1) where samples >= 10 and ratio > 0 and (ratio > 1.25 or ratio < 0.8)
                      order by abs(ln(ratio)) desc limit 5) w) as worst
        from public.cost_allin(1) where samples >= 10 and ratio > 0) x
  where x.dearer + x.cheaper > 0
  on conflict (key) do nothing;

  -- Identity documents: each opened document is one audit row (admin-console kyc_document_view, limited to 40 an
  -- hour). A normal review day opens a handful, so a burst can mean a stolen session.
  insert into _alert_now
  select 'security:kyc_views', case when v.n >= 35 then 'critical' else 'warning' end, 'rules',
         'Unusually many identity documents were opened in the last hour',
         v.n || ' documents opened in the last hour (the limit is 40 an hour). If this was not you, sign out everywhere, change your password and reset the authenticator.',
         null, v.n
  from (select count(*) as n from public.admin_audit_log where action = 'kyc_document_view' and created_at > now() - interval '1 hour') v
  where v.n >= 20
  on conflict (key) do nothing;

  -- Hedge rings: two accounts taking opposite sides of the same trades (see ab_hedge_scan). Open flags only.
  insert into _alert_now
  select 'ring:' || f.id, case when f.level = 'block' then 'critical' else 'warning' end, 'rules',
         coalesce(upa.full_name, 'A trader') || ' and ' || coalesce(upb.full_name, 'another trader') || ' trade opposite sides of the same positions (possible hedge ring)',
         f.shared || ' near-simultaneous opposite trades, ' || round(100 * f.share) || '% of the smaller account''s trades, combined result about '
           || coalesce(round(100 * f.net_ratio)::text || '% of gross', 'not yet known') || '.'
           || case when f.level = 'block' then ' Hold both traders'' payouts until you have reviewed this.' else ' Review before approving payouts.' end,
         f.person_a, f.shared
  from public.ab_hedge_flags f
  left join public.user_profiles upa on upa.user_id = f.person_a
  left join public.user_profiles upb on upb.user_id = f.person_b
  where f.status = 'open'
  on conflict (key) do nothing;

  -- Several accounts sharing a phone number, name and date of birth, or home address.
  insert into _alert_now
  select 'ident:' || d.kind || ':' || d.k, case when d.kind = 'home address' then 'info' else 'warning' end, 'rules',
         d.n || ' accounts share the same ' || d.kind,
         'Check these are different people before approving applications or payouts (one account per person, Terms 3.4). Families can share a phone or address.',
         d.sample_user, d.n
  from public.ab_identity_dupes() d
  on conflict (key) do nothing;

  -- Books: daily stop, profit cap, halt, broken or unconfirmed orders, skipped copies.
  insert into _alert_now
  select 'book:loss:' || l.book || ':' || current_date,
         case when coalesce(p.pnl_usd, 0) <= -l.daily_loss_stop_usd then 'critical' else 'warning' end, 'book',
         upper(l.book) || '-book ' || case when coalesce(p.pnl_usd, 0) <= -l.daily_loss_stop_usd then 'hit its daily loss stop' else 'is past half of its daily loss stop' end,
         'Today: âˆ’$' || abs(round(p.pnl_usd)) || ' against a $' || round(l.daily_loss_stop_usd) || ' stop. New risk stops automatically at the stop.', null, p.pnl_usd
  from public.ab_risk_limits l join public.book_daily_pnl p on p.book = l.book and p.day = (now() at time zone 'utc')::date
  where p.pnl_usd <= -0.5 * l.daily_loss_stop_usd
  on conflict (key) do nothing;

  insert into _alert_now
  select 'book:cap:' || l.book || ':' || current_date, 'good', 'book', upper(l.book) || '-book reached its daily profit cap',
         'Today: +$' || round(p.pnl_usd) || '. No new risk until tomorrow, so the profit is kept.', null, p.pnl_usd
  from public.ab_risk_limits l join public.book_daily_pnl p on p.book = l.book and p.day = (now() at time zone 'utc')::date
  where l.daily_profit_cap_usd is not null and p.pnl_usd >= l.daily_profit_cap_usd
  on conflict (key) do nothing;

  insert into _alert_now
  select 'book:halt', 'warning', 'book', 'All new book risk is halted', 'Switched on from the Treasury page. Existing trades still close normally.', null, null
  from public.ab_settings where book_halt
  on conflict (key) do nothing;

  insert into _alert_now
  select 'book:order:' || o.id, 'critical', 'book',
         case when o.status = 'sent' then 'A copy order was not confirmed by the broker' else 'A copy order needs checking' end,
         public.ab_book_label(o.book) || ': ' || o.event || ' ' || o.symbol || ' ' || o.side || ' ' || o.qty || ' lots: ' || coalesce(o.error, o.status) || '.', o.person_id, null
  from public.book_orders o
  where o.created_at > now() - interval '2 days'
    and (o.status in ('error', 'reconciliation_required') or (o.status = 'sent' and o.created_at < now() - interval '5 minutes'))
  on conflict (key) do nothing;

  insert into _alert_now
  select 'book:skips:' || s.book || ':' || md5(s.reason), 'warning', 'book', s.n || ' copies skipped in the last hour (' || public.ab_book_label(s.book) || ')',
         'Reason: ' || replace(s.reason, 'risk: ', '') || '.', null, s.n
  from (select book, reason, count(*) n from public.ab_copy_skips where created_at > now() - interval '1 hour' group by 1, 2) s
  where s.n >= 5
  on conflict (key) do nothing;

  -- Money: payout cover and graduates waiting.
  insert into _alert_now
  select 'money:treasury', case t.status when 'short' then 'critical' when 'tight' then 'warning' else 'info' end, 'money',
         case t.status when 'short' then 'Not enough cash to cover expected payouts (B-book paused)'
                       when 'tight' then 'Payout cover is tight' else 'Enter your starting cash reserve' end,
         'Bad-case payouts over 90 days: $' || coalesce(round(t.liab_90d_p90)::text, '?') || '; cash counted: $' || coalesce(round(t.assets_usd)::text, '?') || '.', null, t.assets_usd
  from (select * from public.treasury_snapshots order by as_of desc limit 1) t
  where t.status in ('short', 'tight', 'unknown')
  on conflict (key) do nothing;

  insert into _alert_now
  select 'money:sponsor:' || g.id, 'warning', 'money', coalesce(up.full_name, 'A trader') || ' graduated and is waiting for a funded account',
         'Waiting since ' || to_char(g.created_at, 'DD Mon') || '. Buy it in their name, then mark it bought on the Treasury page.', g.user_id, null
  from public.graduate_sponsorships g left join public.user_profiles up on up.user_id = g.user_id
  where g.status = 'pending'
  on conflict (key) do nothing;

  insert into _alert_now
  select 'money:payout:' || p.id, 'good', 'money', 'Prop-firm payout received: $' || round(p.amount_usd),
         coalesce(p.note, 'Recorded on the Treasury page.'), null, p.amount_usd
  from public.ladder_payouts p where p.received_at > now() - interval '7 days'
  on conflict (key) do nothing;

  -- Traders: from the tags the classifier worker computes (one source of truth: _shared/brain.ts).
  insert into _alert_now
  select 'trader:' || t.tag || ':' || m.person_id,
         case when t.tag in ('SUSPENDED', 'HOLD', 'FLAG') then 'critical'
              when t.tag in ('STAR', 'EARNER') then 'good' else 'warning' end,
         case when t.tag in ('BREACHED', 'FLAG', 'HOLD', 'SUSPENDED', 'FAST', 'NO_SL', 'BIG_LOSS', 'SPEED', 'HERD') then 'rules' else 'trader' end,
         coalesce(up.full_name, 'Trader ' || left(m.person_id::text, 6)) || ' ' || case t.tag
           when 'SUSPENDED' then 'is suspended'
           when 'HOLD' then 'is under investigation'
           when 'FLAG' then 'has an open trade-safety flag'
           when 'BREACHED' then 'broke an account rule this week'
           when 'BIG_LOSS' then 'took an oversized loss (3R or more)'
           when 'NO_SL' then 'trades mostly without a stop loss'
           when 'FAST' then 'holds most trades under a minute'
           when 'SPEED' then 'wins on IPFX but their copies would not (price-delay pattern)'
           when 'HERD' then 'trades in a herd (same trades as 2+ others)'
           when 'RINSE' then 'could cost you about $' || round(coalesce(m.expected_payout, 0)) || ' and is not being copied'
           when 'FADING' then 'is getting worse while being copied'
           when 'TURNING' then 'is turning profitable while IPFX bets against them'
           when 'STAR' then 'has proven copyable skill'
           when 'EARNER' then 'is a proven B-book earner'
           else lower(t.tag) end,
         case t.tag
           when 'RINSE' then 'Chance of reaching a payout ' || round(100 * coalesce(m.p_graduate, 0)) || '%. Copying them on A-book would turn this cost into income.'
           when 'FADING' then 'Recent copy results average ' || round(coalesce(m.ewma_copy, 0), 2) || 'R per trade. Copies are already being cut in size.'
           when 'TURNING' then 'Recent reverse results average ' || round(coalesce(m.ewma_reverse, 0), 2) || 'R per trade.'
           when 'STAR' then 'Copy edge ' || round(coalesce(m.copy_r, 0), 2) || 'R per trade over ' || m.replayed || ' trades; proof ' || round(least(coalesce(m.proof_copy, 0), 999), 1) || ' (10 = proven).'
           when 'EARNER' then 'Reverse edge ' || round(coalesce(m.reverse_r, 0), 2) || 'R per trade over ' || m.replayed || ' trades.'
           when 'BREACHED' then m.breaches_7d || ' account breach(es) in the last 7 days.'
           when 'NO_SL' then round(100 * coalesce(m.no_sl_share, 0)) || '% of their trades had no stop loss. They cannot be copied.'
           when 'FAST' then round(100 * coalesce(m.under_60s_share, 0)) || '% of trades held under 60 seconds. Never promoted.'
           when 'SPEED' then 'Their IPFX result beats the copy by ' || round(coalesce(m.copy_gap, 0), 2) || 'R per trade. Never promoted.'
           when 'BIG_LOSS' then 'Worst trade ' || round(coalesce(m.worst_r, 0), 1) || 'R.'
           when 'HERD' then 'Herd members do not get the 2.75% shortcut; at most 5 same-direction copies per 15 minutes.'
           else null end,
         m.person_id,
         case t.tag when 'RINSE' then m.expected_payout when 'STAR' then m.copy_r when 'EARNER' then m.reverse_r else null end
  from public.ab_trader_metrics m
  cross join lateral unnest(m.tags) as t(tag)
  left join public.user_profiles up on up.user_id = m.person_id
  where t.tag not in ('NEW')
  on conflict (key) do nothing;

  -- Moves between boxes in the last 24 hours.
  insert into _alert_now
  select 'move:' || e.id,
         case when e.to_state = 'AB_LIVE' then 'good' when e.from_state = 'AB_LIVE' then 'warning' when e.to_state = 'SUSPENDED' then 'critical' else 'info' end,
         'move', coalesce(up.full_name, 'Trader ' || left(e.person_id::text, 6)) || ': ' ||
           replace(replace(replace(replace(replace(e.from_state || ' â†’ ' || e.to_state, 'AB_LIVE', 'A-book live'), 'AB_DEMO', 'A-book demo'), 'BB_LIVE', 'B-book live'), 'BB_DEMO', 'B-book demo'), 'SUSPENDED', 'Suspended'),
         e.reason, e.person_id, null
  from public.ab_lifecycle_events e left join public.user_profiles up on up.user_id = e.person_id
  where e.created_at > now() - interval '24 hours'
  on conflict (key) do nothing;

  -- Upsert: an alert that comes back after resolving opens fresh (new first_seen, acknowledgement cleared).
  
 insert into _alert_now
 select 'system:trade-similarity','critical','system','Matching-trade checks are not updating',
  'The last successful matching-trade scan is missing or over five minutes old. Checks are scheduled every minute; review the worker before relying on matching-trade coverage.',null,null
 where not exists(select 1 from public.ab_heartbeats where worker='trade-similarity' and ok and at>now()-interval '5 minutes') on conflict(key)do nothing;
 insert into _alert_now
 select 'rules:similarity:'||r.id::text,'warning','rules','Repeated matching trades need review',
  r.matches||' matched opens and exits across '||r.matched_days||' days; '||round(r.share*100)||'% of the smaller trade stream. Open both traders and review the evidence; this is not proof of cheating.',r.person_a,r.matches
 from public.trade_similarity_reviews r where r.latest_match>now()-interval '7 days'
  and (r.reviewed_through is null or r.latest_match>r.reviewed_through) on conflict(key) do nothing;
 insert into _alert_now
 select 'rules:team-pause:'||p.person_id::text,'warning','rules','Trader new entries are paused',p.reason,p.person_id,null
 from public.trader_entry_pauses p where p.active on conflict(key) do nothing;
 
insert into public.ab_alerts as a (key, severity, category, title, detail, person_id, value)
  select key, severity, category, title, detail, person_id, value from _alert_now
  on conflict (key) do update set
    severity = excluded.severity, category = excluded.category, title = excluded.title, detail = excluded.detail,
    person_id = excluded.person_id, value = excluded.value, last_seen = now(),
    first_seen = case when a.resolved_at is not null then now() else a.first_seen end,
    acknowledged_at = case when a.resolved_at is not null or a.severity is distinct from excluded.severity then null else a.acknowledged_at end,
    resolved_at = null
  -- Every 10 seconds most alerts are unchanged: only write when something changed (last_seen at most once a minute).
  where a.resolved_at is not null or a.severity is distinct from excluded.severity or a.title is distinct from excluded.title
     or a.detail is distinct from excluded.detail or a.value is distinct from excluded.value or a.last_seen < now() - interval '1 minute';
  get diagnostics n_new = row_count;

  update public.ab_alerts set resolved_at = now() where resolved_at is null and key not in (select key from _alert_now);
  if extract(minute from now()) = 41 and extract(second from now()) < 10 then
    delete from public.ab_alerts where resolved_at < now() - interval '30 days';
    delete from public.ab_copy_skips where created_at < now() - interval '90 days';
  end if;
  select count(*) into n_open from public.ab_alerts where resolved_at is null;
  insert into public.ab_heartbeats (worker, ok, at, detail) values ('brain-scan', true, now(), jsonb_build_object('open', n_open, 'ms', round(extract(epoch from clock_timestamp() - started) * 1000)))
  on conflict (worker) do update set ok = true, at = now(), detail = excluded.detail;
  return jsonb_build_object('open', n_open, 'upserted', n_new, 'ms', round(extract(epoch from clock_timestamp() - started) * 1000));
end $function$;
