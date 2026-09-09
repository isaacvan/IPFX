-- ============================================================
-- Run this AFTER pasting the 4 files in docs/DEPLOYMENT-RUNBOOK-2026-09-09.md
-- §7, in order. Each block is read-only and safe to run any time.
-- ============================================================

-- 1. promo_codes lockdown (§0) — should return ZERO rows (RLS blocks
--    anon reads entirely now) or, if you're running this as postgres/
--    service role, should show zero policies remaining.
select count(*) as remaining_policies
from pg_policies where schemaname='public' and tablename='promo_codes';
select count(*) as functions_with_search_path_pinned
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('validate_promo_code','increment_promo_use_count')
  and p.proconfig::text like '%search_path%';

-- 2. commerce provisioning (§3) — both functions should exist and be
--    service_role-only.
select routine_name, security_type
from information_schema.routines
where routine_schema='public' and routine_name in ('commerce_claim_provision','commerce_provision_account');

select grantee, privilege_type
from information_schema.routine_privileges
where routine_schema='public' and routine_name='commerce_provision_account';
-- expect: exactly one row, grantee = service_role, privilege_type = EXECUTE

-- 3. trade_safety_flags_v2 (§5) — the new reason values should be
--    reachable (this just confirms the function compiled; it will
--    show 0 rows until real trades trigger it).
select proname, prosrc ~ 'CAP_HUGGING' as has_cap_hugging,
       prosrc ~ 'REVENGE_SIZING' as has_revenge_sizing,
       prosrc ~ 'DRAWDOWN_SWING' as has_drawdown_swing
from pg_proc where proname='capture_trade_safety_flags';
-- expect: one row, all three columns true

select reason, status, count(*) from public.trade_safety_flags group by 1,2 order by 1,2;

-- 4. qualification-v2 activation (§4) — versions should be published.
select id, status, min_elapsed_days, min_trading_days, min_sessions, max_best_day_share
from public.challenge_qualification_versions order by id;
-- expect: infinity-v2-s1/s2/s3, all status='published'

select routine_name from information_schema.routines
where routine_schema='public' and routine_name='accept_qualification_v2';
-- expect: one row

-- 5. End-to-end dry run on a REAL account id (replace the uuid below
--    with an actual trading_accounts.id before running — this one
--    line is the only one that WRITES anything, and it's harmless:
--    accept_qualification_v2 no-ops if already accepted, and no-ops
--    entirely for non-Infinity accounts).
-- select public.accept_qualification_v2('00000000-0000-0000-0000-000000000000');
-- select public.qualification_progress_v2('00000000-0000-0000-0000-000000000000');

-- 6. Overall sanity: nothing above should have touched trades, balances,
--    or payouts. Confirm no accidental writes happened to core tables
--    by checking their most recent updated_at/created_at is still from
--    real trading activity, not from this script.
select max(created_at) as most_recent_trade from public.trades;
select max(created_at) as most_recent_order from public.commerce_orders;
