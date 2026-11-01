-- Terms 2.3 (adds clause 4.6A, Infinity v2) becomes the site-wide current Terms (owner request, 1 Nov 2026).
-- terms.html now serves the same text as /legal/2026-10-31-v2.3/terms.html, and the application form records 2026-10-31-2.3.
begin;
update public.platform_legal_current set version='2026-10-31-2.3' where kind='terms';
commit;
