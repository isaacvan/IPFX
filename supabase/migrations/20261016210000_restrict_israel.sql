-- Owner decision 2026-10-16: add Israel to the signup geo-restriction list, alongside the existing OFAC-sanctioned
-- countries (Cuba, Iran, North Korea, Syria). New signups with country_code='IL' are flagged restricted_jurisdiction
-- by the existing guard_user_profile_fields() trigger and blocked from starting a challenge by the existing checks
-- in trading-engine and the challenge-application gates — no code change needed there, just this row.
-- Checked before applying: zero existing user_profiles rows have country_code='IL', so no active account is affected.
insert into public.restricted_countries (country_code, country_name, reason)
values ('IL', 'Israel', 'Owner decision 2026-10-16')
on conflict (country_code) do nothing;
