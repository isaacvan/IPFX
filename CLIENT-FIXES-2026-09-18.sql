-- ============================================================
-- IPFX Capital — client journey fixes (2026-09-18). Safe to run again.
--
--  A. Self-serve identity verification (KYC): a private storage bucket
--     where each trader can upload only into their own folder, a
--     submissions table, and submit_kyc() which checks the files really
--     exist and moves the trader to "pending" for owner review.
--  B. Lifecycle email templates that were missing (breach, stage passed,
--     funded, KYC decisions). Sent by the engine and admin console.
--  C. Traders can no longer read the owner's internal investigation note.
-- ============================================================

begin;

-- ---- A. KYC ----
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kyc-documents', 'kyc-documents', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "kyc own upload" on storage.objects;
create policy "kyc own upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'kyc-documents' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "kyc own read" on storage.objects;
create policy "kyc own read" on storage.objects for select to authenticated
  using (bucket_id = 'kyc-documents' and (storage.foldername(name))[1] = auth.uid()::text);

create table if not exists public.kyc_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  doc_type text not null check (doc_type in ('id_front','id_back','proof_of_address','selfie')),
  storage_path text not null,
  created_at timestamptz not null default now()
);
create index if not exists kyc_submissions_user_idx on public.kyc_submissions (user_id, created_at desc);
alter table public.kyc_submissions enable row level security;
drop policy if exists "own kyc submissions read" on public.kyc_submissions;
create policy "own kyc submissions read" on public.kyc_submissions for select to authenticated
  using (user_id = auth.uid());
revoke insert, update, delete on public.kyc_submissions from anon, authenticated;

create or replace function public.submit_kyc(p_documents jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  d jsonb;
  v_types text[] := '{}';
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode = '28000'; end if;
  select status into v_status from public.trader_kyc where user_id = v_uid;
  if v_status = 'verified' then return 'verified'; end if;
  if jsonb_typeof(p_documents) is distinct from 'array'
     or jsonb_array_length(p_documents) = 0 or jsonb_array_length(p_documents) > 6 then
    raise exception 'KYC_DOCUMENTS_REQUIRED' using errcode = '22023';
  end if;
  for d in select * from jsonb_array_elements(p_documents) loop
    if (d->>'doc_type') not in ('id_front','id_back','proof_of_address','selfie') then
      raise exception 'KYC_BAD_TYPE' using errcode = '22023';
    end if;
    if split_part(coalesce(d->>'path',''), '/', 1) <> v_uid::text then
      raise exception 'KYC_BAD_PATH' using errcode = '42501';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'kyc-documents' and o.name = d->>'path') then
      raise exception 'KYC_FILE_MISSING' using errcode = '22023';
    end if;
    v_types := v_types || (d->>'doc_type');
  end loop;
  if not ('id_front' = any(v_types) and 'proof_of_address' = any(v_types)) then
    raise exception 'KYC_ID_AND_ADDRESS_REQUIRED' using errcode = '22023';
  end if;

  insert into public.kyc_submissions (user_id, doc_type, storage_path)
  select v_uid, e->>'doc_type', e->>'path' from jsonb_array_elements(p_documents) e;

  insert into public.trader_kyc (user_id, status, note, updated_at)
  values (v_uid, 'pending', null, now())
  on conflict (user_id) do update set status = 'pending', note = null, updated_at = now();
  return 'pending';
end $$;
revoke all on function public.submit_kyc(jsonb) from public, anon;
grant execute on function public.submit_kyc(jsonb) to authenticated;

-- ---- B. Email templates ----
insert into public.email_templates (key, category, subject, preheader, body_html, body_text, is_active) values
('account_breached', 'account', 'Your {{challenge_name}} has ended',
 'A trading rule was breached on your account.',
 '<p>Hello {{customer_name}},</p><p>Your <strong>{{challenge_name}}</strong> has ended because a trading rule was breached: <strong>{{breach_reason}}</strong>.</p><p>{{next_step}}</p><p>You can review every trade in your dashboard.</p>',
 'Hello {{customer_name}},\n\nYour {{challenge_name}} has ended because a trading rule was breached: {{breach_reason}}.\n\n{{next_step}}\n\nYou can review every trade in your dashboard.\n\nIPFX Capital', true),
('stage_passed', 'account', 'You passed {{challenge_name}}',
 'Your next stage is ready.',
 '<p>Hello {{customer_name}},</p><p>Congratulations — you passed <strong>{{challenge_name}}</strong>.</p><p>Your next stage, <strong>{{next_name}}</strong>, is ready in IPFX Markets. Review its rules in your dashboard before your first trade.</p>',
 'Hello {{customer_name}},\n\nCongratulations — you passed {{challenge_name}}.\n\nYour next stage, {{next_name}}, is ready in IPFX Markets. Review its rules in your dashboard before your first trade.\n\nIPFX Capital', true),
('account_funded', 'account', 'You are funded',
 'Your funded account is ready.',
 '<p>Hello {{customer_name}},</p><p>You completed <strong>{{challenge_name}}</strong> and your funded account is now active in IPFX Markets.</p><p>Before your first payout we need to verify your identity. You can upload your documents from the Payouts page of your dashboard.</p>',
 'Hello {{customer_name}},\n\nYou completed {{challenge_name}} and your funded account is now active in IPFX Markets.\n\nBefore your first payout we need to verify your identity. You can upload your documents from the Payouts page of your dashboard.\n\nIPFX Capital', true),
('kyc_approved', 'compliance', 'Your identity is verified',
 'You can now request payouts.',
 '<p>Hello {{customer_name}},</p><p>Your identity has been verified. You can request payouts from your dashboard whenever you are eligible.</p>',
 'Hello {{customer_name}},\n\nYour identity has been verified. You can request payouts from your dashboard whenever you are eligible.\n\nIPFX Capital', true),
('kyc_rejected', 'compliance', 'We could not verify your documents',
 'Please upload new documents.',
 '<p>Hello {{customer_name}},</p><p>We were unable to verify the documents you submitted.</p><p><strong>Reason:</strong> {{note}}</p><p>Please upload new documents from the Payouts page of your dashboard.</p>',
 'Hello {{customer_name}},\n\nWe were unable to verify the documents you submitted.\n\nReason: {{note}}\n\nPlease upload new documents from the Payouts page of your dashboard.\n\nIPFX Capital', true)
on conflict (key) do update set subject = excluded.subject, preheader = excluded.preheader,
  body_html = excluded.body_html, body_text = excluded.body_text, is_active = true, updated_at = now();
-- The literals above use \n; store real line breaks for plain-text emails.
update public.email_templates set body_text = replace(body_text, '\n', E'\n')
 where key in ('account_breached','stage_passed','account_funded','kyc_approved','kyc_rejected');

-- ---- C. Internal investigation notes are owner-only ----
revoke select (investigation_note) on public.trading_accounts from authenticated;

commit;

select
  (select count(*) from storage.buckets where id = 'kyc-documents' and not public)         as kyc_bucket_private,
  (select count(*) from pg_policies where schemaname = 'storage' and policyname like 'kyc own%') as kyc_storage_policies,
  (select count(*) from pg_proc where proname = 'submit_kyc')                                as submit_kyc_fn,
  (select count(*) from email_templates where key in ('account_breached','stage_passed','account_funded','kyc_approved','kyc_rejected')) as new_templates,
  has_column_privilege('authenticated', 'public.trading_accounts', 'investigation_note', 'SELECT') as trader_can_read_note;
