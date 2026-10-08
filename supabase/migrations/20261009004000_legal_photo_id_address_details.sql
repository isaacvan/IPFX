-- Publish only after the new form and immutable documents are publicly verified.
begin;
insert into public.platform_legal_documents(version,kind,source_sha256,document_url)values
 ('2026-10-09-1.8','terms','7ae023a78da50c3554ab31f1b5133515ed80a9cdf00b54444549c4b3c06b4aba','/legal/2026-10-09-v1.8/terms.html'),
 ('2026-10-09-1.3','privacy','dcd8e5819bf29c1fd4656d52d0913380d70504647d71f94326f10e3862ff2692','/legal/2026-10-09-v1.3/privacy.html');
update public.platform_legal_current set version='2026-10-09-1.8' where kind='terms';
update public.platform_legal_current set version='2026-10-09-1.3' where kind='privacy';
commit;
