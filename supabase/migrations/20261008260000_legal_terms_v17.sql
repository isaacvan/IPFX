-- Terms 1.7: fair-process wording in Section 8 (no contradiction with Section 12), Infinity payout carve-out and
-- Stage 4 payout defaults in Section 10, recovery of payments paid in error, qualified freeze wording in 13.5.
-- Earlier versions stay immutable.
begin;
insert into public.platform_legal_documents(version,kind,source_sha256,document_url)
 values('2026-10-08-1.7','terms','70c22c5e824493f48403d0f95c56acdc3527ff5a47f419ac175337bf646b5526','/legal/2026-10-08-v1.7/terms.html');
update public.platform_legal_current set version='2026-10-08-1.7' where kind='terms';
commit;
