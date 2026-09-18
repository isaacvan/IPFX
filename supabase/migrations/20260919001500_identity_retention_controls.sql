-- Retention-review metadata for private challenge applications and KYC files.
-- This deliberately schedules review rather than automatic deletion: a legal
-- hold, dispute or investigation must be checked before storage objects go.
begin;

alter table public.kyc_submissions
  add column if not exists retention_review_at timestamptz not null
    default (now() + interval '12 months'),
  add column if not exists legal_hold boolean not null default false;

alter table public.challenge_enrolment_requests
  add column if not exists retention_review_at timestamptz not null
    default (now() + interval '12 months'),
  add column if not exists legal_hold boolean not null default false;

create index if not exists kyc_submissions_retention_review_idx
  on public.kyc_submissions(retention_review_at)
  where legal_hold is false;

create index if not exists challenge_enrolment_retention_review_idx
  on public.challenge_enrolment_requests(retention_review_at)
  where legal_hold is false;

revoke update(retention_review_at,legal_hold)
  on public.kyc_submissions from anon,authenticated;
revoke update(retention_review_at,legal_hold)
  on public.challenge_enrolment_requests from anon,authenticated;

commit;
