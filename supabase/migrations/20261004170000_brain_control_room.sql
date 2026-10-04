-- Brain control room (owner monitoring). Read-only for traders and books: nothing here places, sizes or
-- routes a trade. Three pieces:
--   * ab_trader_metrics  - one row per person, written by the classifier worker every 5 minutes
--                          (performance, evidence, tags such as STAR / RINSE / BREACHED).
--   * ab_copy_skips      - every copy or reverse that did NOT happen, with the reason (written by book-executor).
--   * ab_alerts          - what needs the owner's attention, kept up to date by ab_alerts_scan() every 5 minutes.
--                          An alert stays open while its condition holds and resolves itself when it stops.

create table if not exists public.ab_trader_metrics (
  person_id uuid primary key,
  as_of timestamptz not null default now(),
  trades int not null default 0, days int not null default 0, wins int not null default 0,
  win_rate numeric, pnl_usd numeric, avg_r numeric, sd_r numeric, profit_factor numeric, max_dd_r numeric, worst_r numeric,
  best_share numeric, no_sl_share numeric, under_60s_share numeric, median_hold_s numeric,
  trades_30d int not null default 0, pnl_30d numeric, last_trade_at timestamptz,
  replayed int not null default 0, copy_r numeric, reverse_r numeric, proof_copy numeric, proof_reverse numeric,
  day_lb_copy numeric, day_lb_reverse numeric, ewma_copy numeric, ewma_reverse numeric, copy_gap numeric,
  herd boolean not null default false, expected_payout numeric, p_graduate numeric, breaches_7d int not null default 0,
  curve jsonb not null default '[]'::jsonb, tags text[] not null default '{}'
);
alter table public.ab_trader_metrics enable row level security;
revoke all on public.ab_trader_metrics from public, anon, authenticated;
grant select, insert, update, delete on public.ab_trader_metrics to service_role;

create table if not exists public.ab_copy_skips (
  id bigint generated always as identity primary key,
  book text not null, source_trade_id uuid, person_id uuid, reason text not null,
  created_at timestamptz not null default now()
);
create index if not exists ab_copy_skips_created on public.ab_copy_skips (created_at desc);
alter table public.ab_copy_skips enable row level security;
revoke all on public.ab_copy_skips from public, anon, authenticated;
grant select, insert on public.ab_copy_skips to service_role;

create table if not exists public.ab_heartbeats (
  worker text primary key, ok boolean not null, at timestamptz not null default now(), detail jsonb
);
alter table public.ab_heartbeats enable row level security;
revoke all on public.ab_heartbeats from public, anon, authenticated;
grant select, insert, update on public.ab_heartbeats to service_role;

create table if not exists public.ab_alerts (
  id bigint generated always as identity primary key,
  key text not null unique,
  severity text not null check (severity in ('critical', 'warning', 'good', 'info')),
  category text not null check (category in ('system', 'book', 'money', 'trader', 'rules', 'move')),
  title text not null, detail text, person_id uuid, value numeric,
  first_seen timestamptz not null default now(), last_seen timestamptz not null default now(),
  resolved_at timestamptz, acknowledged_at timestamptz, acknowledged_by uuid
);
create index if not exists ab_alerts_open on public.ab_alerts (severity, last_seen desc) where resolved_at is null;
create index if not exists ab_alerts_recent on public.ab_alerts (last_seen desc);
alter table public.ab_alerts enable row level security;
revoke all on public.ab_alerts from public, anon, authenticated;
grant select, insert, update, delete on public.ab_alerts to service_role;

-- Rule breaches per person in the last 7 days (any of their accounts), for the BREACHED tag.
create or replace view public.ab_person_breaches_7d with (security_invoker = true) as
select public.ab_person_of(a.user_id) as person_id, count(*)::int as breaches,
       string_agg(distinct coalesce(a.breach_reason, 'rule'), ', ') as reasons
from public.trading_accounts a
where a.breached_at > now() - interval '7 days'
group by 1;
revoke all on public.ab_person_breaches_7d from public, anon, authenticated;
grant select on public.ab_person_breaches_7d to service_role;

-- Spot FX week in New York time: Sunday 17:00 to Friday 17:00.
create or replace function public.ab_fx_market_open(p_at timestamptz default now())
returns boolean language sql stable set search_path to '' as $$
  select case extract(isodow from (p_at at time zone 'America/New_York'))::int
    when 6 then false
    when 7 then (p_at at time zone 'America/New_York')::time >= time '17:00'
    when 5 then (p_at at time zone 'America/New_York')::time < time '17:00'
    else true end;
$$;

-- What the books would have made, from the two-way replay, using each trader's box at the time of the trade.
-- A = copies of A-book (demo + live) traders; B = reverses of B-book live traders. In R (risk units).
create or replace function public.ab_paper_book_daily(p_days int default 90)
returns table (day date, book text, trades bigint, r_sum numeric, usd_sum numeric)
language sql stable security definer set search_path to '' as $$
  with l as (
    select l.*, coalesce((select e.to_state from public.ab_lifecycle_events e
                           where e.person_id = l.person_id and e.created_at <= l.opened_at
                           order by e.created_at desc limit 1), 'BB_DEMO') as state_then
    from public.ab_trade_ledger l
    where l.closed_at > now() - make_interval(days => p_days) and l.replay_basis = 'REPLAY_QUOTES'
  )
  select (closed_at at time zone 'utc')::date, 'a', count(*), sum(same_r), sum(same_usd)
    from l where state_then in ('AB_DEMO', 'AB_LIVE') and same_r is not null group by 1
  union all
  select (closed_at at time zone 'utc')::date, 'b', count(*), sum(reverse_r), sum(reverse_usd)
    from l where state_then = 'BB_LIVE' and reverse_r is not null group by 1
  order by 1, 2;
$$;
revoke all on function public.ab_paper_book_daily(int) from public, anon, authenticated;
grant execute on function public.ab_paper_book_daily(int) to service_role;

-- Last run of a pg_cron job: (seconds since the last success, status of the latest run).
create or replace function public.ab_cron_health(p_job text)
returns table (age_s numeric, last_status text)
language sql stable security definer set search_path to '' as $$
  with j as (select jobid from cron.job where jobname = p_job),
  r as (select d.status, d.start_time from cron.job_run_details d where d.jobid = (select jobid from j)
        order by d.runid desc limit 20)
  select extract(epoch from now() - (select max(start_time) from r where status = 'succeeded')),
         (select status from r order by start_time desc limit 1);
$$;
revoke all on function public.ab_cron_health(text) from public, anon, authenticated;
grant execute on function public.ab_cron_health(text) to service_role;

-- Plain name for a book or prop account: 'a' -> A-book, 'l12' -> Prop account #12.
create or replace function public.ab_book_label(p_book text)
returns text language sql immutable set search_path to '' as $$
  select case when p_book like 'l%' then 'Prop account #' || substr(p_book, 2) else upper(p_book) || '-book' end;
$$;

create or replace function public.ab_alerts_scan()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare started timestamptz := clock_timestamp(); n_open int; n_new int;
begin
  create temp table if not exists _alert_now (key text primary key, severity text, category text, title text, detail text, person_id uuid, value numeric) on commit drop;
  truncate _alert_now;

  -- System: the brain's own moving parts.
  insert into _alert_now
  select 'system:' || j.name, 'critical', 'system', j.title,
         case when h.age_s is null then 'No successful run found.' else 'Last successful run ' || round(h.age_s / 60) || ' minutes ago (latest: ' || coalesce(h.last_status, '?') || ').' end,
         null, h.age_s
  from (values ('ipfx-ab-ledger', 'Trade ledger has stopped updating', 900),
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
  where hb.worker is null or not hb.ok or hb.at < now() - interval '15 minutes'
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

  -- Books: daily stop, profit cap, halt, broken or unconfirmed orders, skipped copies.
  insert into _alert_now
  select 'book:loss:' || l.book || ':' || current_date,
         case when coalesce(p.pnl_usd, 0) <= -l.daily_loss_stop_usd then 'critical' else 'warning' end, 'book',
         upper(l.book) || '-book ' || case when coalesce(p.pnl_usd, 0) <= -l.daily_loss_stop_usd then 'hit its daily loss stop' else 'is past half of its daily loss stop' end,
         'Today: −$' || abs(round(p.pnl_usd)) || ' against a $' || round(l.daily_loss_stop_usd) || ' stop. New risk stops automatically at the stop.', null, p.pnl_usd
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
           replace(replace(replace(replace(replace(e.from_state || ' → ' || e.to_state, 'AB_LIVE', 'A-book live'), 'AB_DEMO', 'A-book demo'), 'BB_LIVE', 'B-book live'), 'BB_DEMO', 'B-book demo'), 'SUSPENDED', 'Suspended'),
         e.reason, e.person_id, null
  from public.ab_lifecycle_events e left join public.user_profiles up on up.user_id = e.person_id
  where e.created_at > now() - interval '24 hours'
  on conflict (key) do nothing;

  -- Upsert: an alert that comes back after resolving opens fresh (new first_seen, acknowledgement cleared).
  insert into public.ab_alerts as a (key, severity, category, title, detail, person_id, value)
  select key, severity, category, title, detail, person_id, value from _alert_now
  on conflict (key) do update set
    severity = excluded.severity, category = excluded.category, title = excluded.title, detail = excluded.detail,
    person_id = excluded.person_id, value = excluded.value, last_seen = now(),
    first_seen = case when a.resolved_at is not null then now() else a.first_seen end,
    acknowledged_at = case when a.resolved_at is not null or a.severity is distinct from excluded.severity then null else a.acknowledged_at end,
    resolved_at = null;
  get diagnostics n_new = row_count;

  update public.ab_alerts set resolved_at = now() where resolved_at is null and key not in (select key from _alert_now);
  delete from public.ab_alerts where resolved_at < now() - interval '30 days';
  delete from public.ab_copy_skips where created_at < now() - interval '90 days';
  select count(*) into n_open from public.ab_alerts where resolved_at is null;
  insert into public.ab_heartbeats (worker, ok, at, detail) values ('brain-scan', true, now(), jsonb_build_object('open', n_open, 'ms', round(extract(epoch from clock_timestamp() - started) * 1000)))
  on conflict (worker) do update set ok = true, at = now(), detail = excluded.detail;
  return jsonb_build_object('open', n_open, 'upserted', n_new, 'ms', round(extract(epoch from clock_timestamp() - started) * 1000));
end $$;
revoke all on function public.ab_alerts_scan() from public, anon, authenticated;
grant execute on function public.ab_alerts_scan() to service_role;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'ipfx-brain-scan';
  perform cron.schedule('ipfx-brain-scan', '4-59/5 * * * *', 'select public.ab_alerts_scan()');
end $$;
