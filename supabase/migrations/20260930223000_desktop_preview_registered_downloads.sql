-- Allow signed-in IPFX users to download the existing unsigned preview.
-- Upload remains restricted to the separately authorized GitHub workflow.
drop policy if exists "IPFX owner can download desktop releases" on storage.objects;
drop policy if exists "IPFX users can download desktop previews" on storage.objects;
create policy "IPFX users can download desktop previews"
on storage.objects for select to authenticated
using (
  bucket_id = 'desktop-releases'
  and name ~ '^v0\.1\.0-preview\.3/IPFX-Markets-UNSIGNED-PREVIEW-0\.1\.0-preview\.3-(win-x64\.exe|mac-(arm64|x64)\.dmg)\.(manifest\.json|part-[0-9]{4}-of-[0-9]{4})$'
  and (select auth.uid()) is not null
);
