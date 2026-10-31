-- Owner approved 31 Oct 2026: publish Terms 2.3 (adds clause 4.6A, Infinity v2) as the terms Infinity v2 restarts and switches accept,
-- and switch Infinity v2 on. The cutover stays 1 Nov 2026 00:00 UTC, so runs started before it stay on Infinity v1.
-- The site-wide current terms (platform_legal_current) stay 2.2 for now: paid checkout pins 2.2 and must be updated together.
begin;
insert into public.platform_legal_documents(version,kind,source_sha256,document_url)
 values('2026-10-31-2.3','terms','0dbbc91c470506c588f66ce1a83fbdd5f8ea2fd1f3a803c16a9b37d48d3990ab','/legal/2026-10-31-v2.3/terms.html')
 on conflict (version) do nothing;
update public.infinity_v2_settings set terms_version='2026-10-31-2.3', infinity_v2_enabled=true where singleton;
commit;
