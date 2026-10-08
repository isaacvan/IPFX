-- Identity documents: only the owner (through the admin function, which uses the service role) can read them
-- (owner security review 2026-10-08). Before this, the rule "kyc own read" let every trader read their own folder,
-- so a hijacked trader login could have pulled that trader's ID. The site never reads documents back from the
-- browser (it only uploads, with upsert:false, which needs only the INSERT rule), so nothing depends on it.
--
--   kept:     "kyc own upload"  - a signed-in trader may add files to their OWN folder (<user id>/...) and nowhere else.
--   removed:  "kyc own read".
--   added:    three RESTRICTIVE rules (read, change, delete) that every other rule must also satisfy, so that even if
--             someone later adds a permissive read rule for this bucket by mistake, browsers still cannot open it.
-- Undo: create policy "kyc own read" on storage.objects for select to authenticated
--       using (bucket_id = 'kyc-documents' and (storage.foldername(name))[1] = (auth.uid())::text);
begin;
drop policy if exists "kyc own read" on storage.objects;
drop policy if exists "kyc no client read" on storage.objects;
drop policy if exists "kyc no client change" on storage.objects;
drop policy if exists "kyc no client delete" on storage.objects;
create policy "kyc no client read" on storage.objects as restrictive for select to anon, authenticated
  using (bucket_id <> 'kyc-documents');
create policy "kyc no client change" on storage.objects as restrictive for update to anon, authenticated
  using (bucket_id <> 'kyc-documents') with check (bucket_id <> 'kyc-documents');
create policy "kyc no client delete" on storage.objects as restrictive for delete to anon, authenticated
  using (bucket_id <> 'kyc-documents');
commit;
