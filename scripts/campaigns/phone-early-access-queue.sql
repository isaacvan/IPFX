-- Queue "Trade IPFX from your phone: want early access?" (template ipfx_phone_early_access).
-- Run ONLY after the owner approves the preview (docs/email-preview/phone-early-access-preview.html).
-- Audience: every account with a confirmed email that is not on the do-not-email list and has not been erased.
-- Each recipient gets their own early-access token; the old held "coming to your phone" emails are retired.
begin;

insert into public.mobile_early_access (user_id, campaign)
select u.id, 'phone-early-access-2026-11'
  from auth.users u
 where u.email is not null and u.deleted_at is null and u.email_confirmed_at is not null
   and u.email not like '%@deleted.invalid'
   and not exists (select 1 from public.email_suppressions s where s.email = lower(trim(u.email)))
on conflict (user_id) do nothing;

insert into public.email_events (user_id, template_key, to_email, subject, status, provider, payload)
select u.id, 'ipfx_phone_early_access', u.email, 'Trade IPFX from your phone: want early access?', 'queued', 'ses',
       jsonb_build_object('campaign', 'phone-early-access-2026-11', 'vars', jsonb_build_object(
         'early_access_url', 'https://ipfxcapital.com/trading.html?phone=1&ea=' || m.invite_token))
  from auth.users u join public.mobile_early_access m on m.user_id = u.id
 where u.email is not null and u.deleted_at is null and u.email_confirmed_at is not null
   and u.email not like '%@deleted.invalid'
   and m.claimed_at is null
   and not exists (select 1 from public.email_suppressions s where s.email = lower(trim(u.email)))
   and not exists (select 1 from public.email_events e where e.user_id = u.id and e.template_key = 'ipfx_phone_early_access');

update public.email_events
   set error_message = 'RETIRED 28 Nov: replaced by ipfx_phone_early_access (old rules in the body)'
 where template_key = 'ipfx_mobile_coming' and status = 'skipped' and error_message like 'HELD by owner%';

commit;

-- Taps so far:  select count(*) filter (where claimed_at is not null) tapped, count(*) invited
--               from public.mobile_early_access where campaign = 'phone-early-access-2026-11';
