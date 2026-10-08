-- Keep the already-recorded Terms 1.3 source immutable; preserve the concurrent
-- plain-English exposure-session clarification in a new published version.
begin;
insert into public.platform_legal_documents(version,kind,source_sha256,document_url)
 values('2026-10-08-1.4','terms','25c8c731a74656ca0fa8e988aedda6815ec428d3a009fa1f9e35321e55f6ff7d','/legal/2026-10-08-v1.4/terms.html');
update public.platform_legal_current set version='2026-10-08-1.4' where kind='terms';
commit;
