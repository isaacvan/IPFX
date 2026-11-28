-- 28 Nov 2026: phone early access from an email button.
-- Each invited trader gets a private link (trading.html?phone=1&ea=<token>). Tapping it claims early access for their
-- account, so the phone version of IPFX Markets switches on for them on any phone they sign in on, not only the one
-- that opened the email. The claimed rows are also how we count taps on the email.
begin;

create table if not exists public.mobile_early_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  invite_token text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  campaign text not null default 'phone-early-access-2026-11',
  invited_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_claimed_at timestamptz,
  claim_count integer not null default 0
);
alter table public.mobile_early_access enable row level security;
revoke all on public.mobile_early_access from anon, authenticated;
grant select (user_id, claimed_at) on public.mobile_early_access to authenticated;
drop policy if exists mobile_early_access_own on public.mobile_early_access;
create policy mobile_early_access_own on public.mobile_early_access for select to authenticated using (user_id = auth.uid());

-- Public: the token itself is the credential (64 random hex characters, one per trader).
create or replace function public.fn_claim_mobile_early_access(p_token text)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return false; end if;
  update public.mobile_early_access
     set claimed_at = coalesce(claimed_at, now()), last_claimed_at = now(), claim_count = claim_count + 1
   where invite_token = p_token;
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public.fn_claim_mobile_early_access(text) from public;
grant execute on function public.fn_claim_mobile_early_access(text) to anon, authenticated;

-- The owner's account (already on the hard-coded list in markets-phone.js) counts as claimed.
insert into public.mobile_early_access (user_id, campaign, claimed_at, last_claimed_at, claim_count)
select id, 'owner', now(), now(), 1 from auth.users where id = 'f77286ef-8b51-47f3-b6b7-a62f541a4239'
on conflict (user_id) do nothing;

commit;
