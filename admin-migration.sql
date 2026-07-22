-- ============================================================
-- IPFX Capital — Admin access
-- Only accounts listed here can use the admin console / approve
-- traders for live mirroring. Fail-closed: empty table = nobody
-- is admin (the console shows "not authorized").
-- ============================================================

create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;
drop policy if exists "admins read self" on public.admins;
create policy "admins read self" on public.admins
  for select using (user_id = auth.uid());
-- No client write policy: membership is granted only via SQL (below) or service role.

-- ------------------------------------------------------------
-- ACTIVATE: make yourself an admin. Replace the email with the
-- one you use to LOG IN to ipfxcapital.com, then run this line:
--
--   insert into public.admins(user_id)
--   select id from auth.users where email = 'YOUR_LOGIN_EMAIL'
--   on conflict do nothing;
-- ------------------------------------------------------------
