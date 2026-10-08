-- Terms 1.6 and Privacy 1.2: demo, practice and simulated copies; what order data goes to brokers (never identity documents).
-- Earlier versions stay immutable; this publishes new ones and makes them current.
begin;
insert into public.platform_legal_documents(version,kind,source_sha256,document_url) values
 ('2026-10-08-1.6','terms','ea0143073874d35796ba7d379c0a28f7b63a18cb5bc41c5130f9d31170308d4b','/legal/2026-10-08-v1.6/terms.html'),
 ('2026-10-08-1.2','privacy','245c9c458bde70253e422127f80641ed666bbad860377a5020afc2341ea24dec','/legal/2026-10-08-v1.2/privacy.html');
update public.platform_legal_current set version='2026-10-08-1.6' where kind='terms';
update public.platform_legal_current set version='2026-10-08-1.2' where kind='privacy';
commit;
