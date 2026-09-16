insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'desktop-releases',
  'desktop-releases',
  false,
  536870912,
  array[
    'application/octet-stream',
    'application/x-msdownload',
    'application/vnd.microsoft.portable-executable',
    'application/x-apple-diskimage',
    'application/zip'
  ]::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "IPFX owner can download desktop releases" on storage.objects;
create policy "IPFX owner can download desktop releases"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'desktop-releases'
  and (select auth.uid()) = 'f77286ef-8b51-47f3-b6b7-a62f541a4239'::uuid
);
