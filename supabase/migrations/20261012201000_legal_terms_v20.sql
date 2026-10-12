-- Terms 2.0: for runs whose application accepts this version, reaching the Infinity daily profit cap closes open
-- positions and cancels pending orders (engine + fn_infinity_cap_closes_positions). Earlier versions stay immutable.
begin;
insert into public.platform_legal_documents(version,kind,source_sha256,document_url)
 values('2026-10-12-2.0','terms','24d8b0d78ee30704f56bb0b757c2207b1b918726ee5acb8ec2bf33b8de101054','/legal/2026-10-12-v2.0/terms.html');
update public.platform_legal_current set version='2026-10-12-2.0' where kind='terms';
commit;
