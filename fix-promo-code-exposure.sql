-- ============================================================
-- FIX: promo_codes fully readable by anonymous visitors (2026-09-08)
--
-- FOUND: `select * from promo_codes` with the public anon key (which is
-- embedded in the page source of every page) returned all 6 active promo
-- codes. Three of them had max_uses = NULL, i.e. unlimited free 100K
-- Challenges. Anyone who opened devtools, or simply curled the REST API
-- with the public key, could enumerate every code and redeem them.
-- Writes were already correctly blocked by RLS; this was read exposure.
--
-- SECOND ISSUE: the client validated a code with
--   .select(...).eq('code', code).eq('is_active', true)
-- which never compared use_count against max_uses. Exhaustion depended
-- entirely on the trg_promo_use_count trigger flipping is_active to
-- false. That is a single point of failure for a revenue control.
--
-- FIX: promo codes are no longer selectable from the client at all.
-- Validation goes through a SECURITY DEFINER function that takes one
-- code and returns only that code's display fields — never the list.
-- The function re-checks exhaustion itself rather than trusting
-- is_active alone, so the cap holds even if the trigger is missing.
--
-- Note `SET search_path = public` — omitting it on a SECURITY DEFINER
-- function is what broke signup earlier today (see
-- fix-signup-search-path.sql).
-- ============================================================

-- 1. Validation RPC: one code in, that code's details out (or nothing).
create or replace function public.validate_promo_code(p_code text)
returns table (code text, challenge_name text, challenge_type text)
language sql
stable
security definer
set search_path = public
as $$
  select pc.code, pc.challenge_name, pc.challenge_type
  from public.promo_codes pc
  where upper(pc.code) = upper(trim(p_code))
    and pc.is_active = true
    and (pc.max_uses is null or pc.use_count < pc.max_uses)
  limit 1;
$$;

revoke all on function public.validate_promo_code(text) from public;
grant execute on function public.validate_promo_code(text) to anon, authenticated;

-- 2. Remove the blanket read exposure. Drop every existing SELECT policy
--    on promo_codes, then deliberately add none back: the table is now
--    reachable only through validate_promo_code() (security definer) and
--    by service_role, which bypasses RLS.
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='promo_codes'
  loop
    execute format('drop policy if exists %I on public.promo_codes;', p.policyname);
  end loop;
end $$;

alter table public.promo_codes enable row level security;

-- 2b. Harden the redemption counter. increment_promo_use_count() is the
--     function that makes the max_uses cap actually bite, and it is
--     SECURITY DEFINER (so it keeps working once RLS locks the table).
--     But it was missing `SET search_path` and referenced `promo_codes`
--     unqualified -- the exact defect that broke signup earlier today.
--     A SECURITY DEFINER function inherits the CALLER's search_path, so
--     any caller whose search_path omits public would silently fail to
--     increment the counter, and single-use codes would stay redeemable.
--     Recreated here identically except for the qualification and the
--     search_path pin. The trigger itself is unchanged and does not need
--     to be redefined.
create or replace function public.increment_promo_use_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.promo_code is not null then
    update public.promo_codes
    set
      use_count = use_count + 1,
      is_active = case
        when max_uses is not null and (use_count + 1) >= max_uses then false
        else is_active
      end
    where code = NEW.promo_code;
  end if;
  return NEW;
end;
$$;

-- 3. Verify: this should return zero policies, and the RPC should still
--    resolve a known-good code.
select
  (select count(*) from pg_policies where schemaname='public' and tablename='promo_codes') as remaining_policies,
  (select count(*) from public.validate_promo_code('ADENIJI100K')) as rpc_resolves_known_code,
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('validate_promo_code','increment_promo_use_count')
      and p.proconfig::text like '%search_path=public%') as functions_with_search_path_pinned;
