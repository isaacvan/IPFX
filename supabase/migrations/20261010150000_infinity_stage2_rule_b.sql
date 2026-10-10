-- Infinity Stage 2 "rule set B" (owner decision 2026-10-10), from the Stage 2/3 rule grid search:
--   * profitable day: net closed profit above 0.05% of starting balance ($2.50) instead of 0.25% ($12.50)
--   * best-day share: 35% instead of 25%   (new published qualification version infinity-v5-s2)
--   * profit target: 7% ($350) instead of 6% for runs whose Stage 1 account opens on or after 2026-10-11 00:00 UTC.
--     Earlier runs keep 6% (Terms: an active run's targets are never worsened). The bar and best-day changes are
--     more lenient, so they apply to every Stage 2 account.
-- No Stage 2 or Stage 3 Infinity account exists when this is applied. Terms 1.9 publishes the change.
begin;

-- 1. Preset: new Stage 2 accounts are provisioned at 7%.
update public.challenge_presets set profit_target_pct = 7 where id = 'infinity_s2' and profit_target_pct = 6;

-- 2. Qualification contract: 35% best-day share. accept_qualification_v2 picks the newest published version.
insert into public.challenge_qualification_versions
  (id, challenge_type, stage, status, min_elapsed_days, min_trading_days, min_sessions, max_best_day_share, min_daily_net_fraction, session_flat_gap_minutes)
select 'infinity-v5-s2', challenge_type, stage, 'published', min_elapsed_days, min_trading_days, min_sessions, 0.35, min_daily_net_fraction, session_flat_gap_minutes
from public.challenge_qualification_versions where id = 'infinity-v4-s2'
on conflict (id) do nothing;
update public.challenge_qualification_versions set status = 'retired' where id = 'infinity-v4-s2' and status = 'published';

-- 3. Profitable-day bar: 0.05% for Infinity Stage 2, unchanged (0.25% since 1 Oct, else 0) for everything else.
create or replace view public.account_progress as
 WITH closed AS (
         SELECT t.account_id,
            (t.closed_at AT TIME ZONE 'UTC'::text)::date AS day,
            t.pnl,
                CASE
                    WHEN a_1.created_at >= '2026-10-01 00:00:00+00'::timestamp with time zone THEN t.close_reason IS DISTINCT FROM 'partial'::text AND (t.closed_at - t.opened_at) >= '00:01:00'::interval AND t.close_reason IS DISTINCT FROM 'no_stop_loss'::text
                    ELSE t.close_reason IS DISTINCT FROM 'no_stop_loss'::text
                END AS counts,
                CASE
                    WHEN a_1.challenge_type = 'infinity'::text AND a_1.stage = 2 AND a_1.created_at >= '2026-10-01 00:00:00+00'::timestamp with time zone THEN a_1.starting_balance * 0.0005
                    WHEN a_1.created_at >= '2026-10-01 00:00:00+00'::timestamp with time zone THEN a_1.starting_balance * 0.0025
                    ELSE 0::numeric
                END AS min_day_profit
           FROM trades t
             JOIN trading_accounts a_1 ON a_1.id = t.account_id
          WHERE t.status = 'closed'::text AND t.closed_at IS NOT NULL
        ), days AS (
         SELECT closed.account_id,
            closed.day,
            sum(closed.pnl) AS day_pnl,
            count(*) FILTER (WHERE closed.counts) AS day_trades,
            max(closed.min_day_profit) AS min_day_profit
           FROM closed
          GROUP BY closed.account_id, closed.day
        )
 SELECT a.id AS account_id,
    a.user_id,
    COALESCE(count(d.day) FILTER (WHERE d.day_trades > 0), 0::bigint)::integer AS trading_days,
    COALESCE(sum(d.day_trades), 0::numeric)::integer AS trades_closed,
    COALESCE(count(d.day) FILTER (WHERE d.day_trades > 0 AND d.day_pnl > d.min_day_profit), 0::bigint)::integer AS profitable_days,
        CASE
            WHEN count(d.day) FILTER (WHERE d.day_trades > 0) > 0 THEN round(100.0 * count(d.day) FILTER (WHERE d.day_trades > 0 AND d.day_pnl > d.min_day_profit)::numeric / count(d.day) FILTER (WHERE d.day_trades > 0)::numeric, 2)
            ELSE NULL::numeric
        END AS profitable_days_pct
   FROM trading_accounts a
     LEFT JOIN days d ON d.account_id = a.id
  GROUP BY a.id, a.user_id;

-- 4. Runs whose Stage 1 opened before 2026-10-11 keep the 6% Stage 2 target they agreed to.
--    Surgical edit of the deployed definition so concurrent changes to the function are preserved.
do $patch$
declare d text; anchor text;
begin
  d := pg_get_functiondef('public.fn_advance_infinity_stage(uuid,uuid)'::regprocedure);
  if strpos(d, 'INFINITY_S2_LEGACY_TARGET') > 0 then return; end if;
  anchor := 'if not found or n.challenge_type<>''infinity''or n.stage<>a.stage+1 then raise exception ''NEXT_PRESET_UNAVAILABLE'';end if;';
  if strpos(d, anchor) = 0 then raise exception 'ADVANCE_STAGE_SOURCE_DRIFT_REVIEW_REQUIRED'; end if;
  execute replace(d, anchor, anchor || E'\n -- INFINITY_S2_LEGACY_TARGET: runs started before Terms 1.9 keep the 6% Stage 2 target.\n'
    || ' if n.id=''infinity_s2'' and a.stage=1 and a.created_at<timestamptz ''2026-10-11 00:00:00+00'' then n.profit_target_pct:=6; end if;');
end $patch$;

-- 5. Support bot answers (the seed file is updated to match).
update public.support_kb set answer = replace(replace(answer,
    'for new accounts a day needs more than 0.25% of starting balance in net closed profit',
    'a day needs more than 0.05% of starting balance ($2.50) in net closed profit'),
    '- Best day no more than 25% of positive profit', '- Best day no more than 35% of positive profit'),
  updated_at = now()
where id = 'infinity-stage2' and edited_by_owner is not true;

-- 6. Terms 1.9 (earlier versions stay immutable).
insert into public.platform_legal_documents(version,kind,source_sha256,document_url)
 values('2026-10-10-1.9','terms','7f59be2e822bc42d1f2d1144b8bdd67feab98fd7c41913223edc308f2559bb0d','/legal/2026-10-10-v1.9/terms.html');
update public.platform_legal_current set version='2026-10-10-1.9' where kind='terms';

commit;
