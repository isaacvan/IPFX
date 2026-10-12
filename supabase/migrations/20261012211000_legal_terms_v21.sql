-- Terms 2.1: counted profit (at most the daily profit cap of each day's profit counts toward the target) for runs that
-- accept this version, and an explicit "every requirement at the same time" clause. Earlier versions stay immutable.
begin;
insert into public.platform_legal_documents(version,kind,source_sha256,document_url)
 values('2026-10-12-2.1','terms','948d3ca1234e078a72e46f827df39862ae0f31750191e548af1284a5fd316e50','/legal/2026-10-12-v2.1/terms.html');
update public.platform_legal_current set version='2026-10-12-2.1' where kind='terms';
commit;
