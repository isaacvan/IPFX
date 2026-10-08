-- Hedge-ring detector (owner red-team review 2026-10-08).
-- The attack: two accounts take OPPOSITE sides of the same trade at the same moment, so one of them passes a
-- stage while the other breaches. Stage 1 is free and its target (4%) is smaller than its drawdown (5%), so
-- one of a pair almost always passes. The herd detector only catches traders who make the SAME trades; this
-- catches opposite ones, including two accounts owned by the same person.
--
-- A pair is flagged when, over the last 30 days, at least 4 trades on one account have an opposite trade on
-- the other, same symbol, opened within 60 seconds, volumes within 30%, that make up at least 30% of the
-- smaller account's trades, and the combined result of the closed pairs is close to zero (a real hedge nets
-- out, two unrelated traders do not). Demo practice accounts are ignored.
--   review = alert only.   block = clear-cut (8+ pairs, 50%+ of trades, net under 20%): the alert says payouts
--   should wait for a human look. Payout requests already need manual approval, so nothing is auto-frozen.

create table if not exists public.ab_hedge_flags (
  id bigint generated always as identity primary key,
  account_a uuid not null, account_b uuid not null,
  person_a uuid, person_b uuid,
  shared int not null, share numeric not null, net_ratio numeric,
  level text not null check (level in ('review', 'block')),
  status text not null default 'open' check (status in ('open', 'cleared')),
  first_seen timestamptz not null default now(), last_seen timestamptz not null default now(),
  cleared_at timestamptz, cleared_note text,
  unique (account_a, account_b)
);
alter table public.ab_hedge_flags enable row level security;
revoke all on public.ab_hedge_flags from public, anon, authenticated;
grant select, insert, update on public.ab_hedge_flags to service_role;

create or replace function public.ab_hedge_pairs(p_days int default 30, p_window_s int default 60, p_min_shared int default 4)
returns table (account_a uuid, account_b uuid, person_a uuid, person_b uuid, shared bigint, share numeric, net_ratio numeric)
language sql stable security definer set search_path to '' as $$
  with t as (
    select tr.id, tr.account_id, tr.symbol, tr.side, tr.opened_at, tr.volume, tr.pnl, tr.status
    from public.trades tr join public.trading_accounts ta on ta.id = tr.account_id
    where tr.opened_at > now() - make_interval(days => p_days) and ta.status <> 'demo' and coalesce(ta.phase, '') <> 'demo'
  ), n as (select account_id, count(*) as n from t group by account_id),
  m as (
    select a.account_id as aa, b.account_id as ab, a.id as ida, a.pnl as pa, b.pnl as pb, a.status as sa, b.status as sb
    from t a join t b
      on b.symbol = a.symbol and b.side <> a.side and a.account_id < b.account_id
     and b.opened_at between a.opened_at - make_interval(secs => p_window_s) and a.opened_at + make_interval(secs => p_window_s)
     and least(a.volume, b.volume) >= 0.7 * greatest(a.volume, b.volume)
  ), agg as (
    select aa, ab, count(distinct ida) as shared,
           sum(abs(coalesce(pa, 0)) + abs(coalesce(pb, 0))) filter (where sa = 'closed' and sb = 'closed') as gross,
           sum(coalesce(pa, 0) + coalesce(pb, 0)) filter (where sa = 'closed' and sb = 'closed') as net
    from m group by aa, ab
  )
  select g.aa, g.ab, public.ab_person_of(xa.user_id), public.ab_person_of(xb.user_id), g.shared,
         round(g.shared::numeric / least(na.n, nb.n), 3),
         case when g.gross > 0 then round(abs(g.net) / g.gross, 3) end
  from agg g
  join n na on na.account_id = g.aa join n nb on nb.account_id = g.ab
  join public.trading_accounts xa on xa.id = g.aa join public.trading_accounts xb on xb.id = g.ab
  where g.shared >= p_min_shared and g.shared >= 0.3 * least(na.n, nb.n)
    and (g.gross is null or g.gross = 0 or abs(g.net) / g.gross <= 0.35);
$$;
revoke all on function public.ab_hedge_pairs(int, int, int) from public, anon, authenticated;
grant execute on function public.ab_hedge_pairs(int, int, int) to service_role;

create or replace function public.ab_hedge_scan()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare n_seen int; n_open int;
begin
  perform set_config('statement_timeout', '25000', true);
  with up as (
    insert into public.ab_hedge_flags as f (account_a, account_b, person_a, person_b, shared, share, net_ratio, level)
    select p.account_a, p.account_b, p.person_a, p.person_b, p.shared, p.share, p.net_ratio,
           case when p.shared >= 8 and p.share >= 0.5 and coalesce(p.net_ratio, 0) <= 0.2 then 'block' else 'review' end
    from public.ab_hedge_pairs() p
    on conflict (account_a, account_b) do update set
      person_a = excluded.person_a, person_b = excluded.person_b, shared = excluded.shared, share = excluded.share,
      net_ratio = excluded.net_ratio, last_seen = now(),
      level = case when f.level = 'block' or excluded.level = 'block' then 'block' else 'review' end
    returning 1)
  select count(*) into n_seen from up;
  select count(*) into n_open from public.ab_hedge_flags where status = 'open';
  insert into public.ab_heartbeats (worker, ok, at, detail)
  values ('hedge-scan', true, now(), jsonb_build_object('open', n_open, 'seen', n_seen))
  on conflict (worker) do update set ok = true, at = now(), detail = excluded.detail;
  return jsonb_build_object('open', n_open, 'seen', n_seen);
end $$;
revoke all on function public.ab_hedge_scan() from public, anon, authenticated;
grant execute on function public.ab_hedge_scan() to service_role;

-- Owner decision on a flagged pair: clear it (a note is required) so it stops alerting.
create or replace function public.ab_hedge_clear(p_id bigint, p_note text)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if p_note is null or length(trim(p_note)) < 5 then raise exception 'A note explaining why this pair is fine is required'; end if;
  update public.ab_hedge_flags set status = 'cleared', cleared_at = now(), cleared_note = left(trim(p_note), 500) where id = p_id and status = 'open';
end $$;
revoke all on function public.ab_hedge_clear(bigint, text) from public, anon, authenticated;
grant execute on function public.ab_hedge_clear(bigint, text) to service_role;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'ipfx-hedge-scan';
  perform cron.schedule('ipfx-hedge-scan', '*/5 * * * *', 'select public.ab_hedge_scan()');
end $$;


-- Duplicate identity details (owner red-team review 2026-10-08). Terms 3.4 allows one account per person, but
-- nothing compared identity details across accounts. Reported for human review only (families share phones and
-- addresses), shown in the Brain next to the application / payout you are about to approve.
create or replace function public.ab_identity_dupes()
returns table (kind text, k text, n bigint, sample_user uuid)
language sql stable security definer set search_path to '' as $$
  select 'phone number'::text, md5(x.phone_e164), x.n, x.u from (
    select phone_e164, count(*) as n, (min(user_id::text))::uuid as u from public.trader_identity_private group by phone_e164 having count(*) > 1) x
  union all
  select 'name and date of birth', md5(x.f || '|' || x.l || '|' || x.d::text), x.n, x.u from (
    select lower(legal_first_name) as f, lower(legal_last_name) as l, date_of_birth as d, count(*) as n, (min(user_id::text))::uuid as u
    from public.trader_identity_private group by 1, 2, 3 having count(*) > 1) x
  union all
  select 'home address', md5(x.a || '|' || x.p || '|' || x.c), x.n, x.u from (
    select lower(address_line_1) as a, lower(postal_code) as p, country_code as c, count(*) as n, (min(user_id::text))::uuid as u
    from public.trader_identity_private group by 1, 2, 3 having count(*) > 1) x;
$$;
revoke all on function public.ab_identity_dupes() from public, anon, authenticated;
grant execute on function public.ab_identity_dupes() to service_role;

-- Brain: alert for every open flag (redefines ab_alerts_scan from 20261005160000 plus one block).
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

  -- Spread parity (owner policy 2026-10-05): IPFX should cost traders about what the E8 funded account does.
  -- Last hour, same moments, at least 10 samples each. Wider means traders pay more than on E8; tighter means
  -- IPFX results are easier than the real funded account (both mislead).
  insert into _alert_now
  select 'cost:spread:' || s.symbol, 'warning', 'system',
         'IPFX spread on ' || s.symbol || ' is ' || case when s.ipfx > s.e8 then 'wider' else 'tighter' end || ' than the E8 funded account',
         'Last hour average: IPFX ' || round(s.ipfx::numeric, 5) || ' vs E8 ' || round(s.e8::numeric, 5) || ' (' || round(100 * s.ipfx / s.e8) || '% of E8). Aim for 80% to 125%.', null, round(100 * s.ipfx / s.e8)
  from (select symbol, avg(spread) filter (where role = 'monitor') e8, avg(ipfx_spread) filter (where role = 'monitor') ipfx,
               count(*) filter (where role = 'monitor' and ipfx_spread is not null) n
        from public.cost_samples where sampled_at > now() - interval '1 hour' group by symbol) s
  where s.n >= 10 and s.e8 > 0 and s.ipfx is not null and (s.ipfx / s.e8 > 1.25 or s.ipfx / s.e8 < 0.8)
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
end $$;
revoke all on function public.ab_alerts_scan() from public, anon, authenticated;
grant execute on function public.ab_alerts_scan() to service_role;
