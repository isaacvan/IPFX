-- The outbox kicker used a Vault entry that was never created, so the cloud dispatcher never ran.
-- It now sends a dedicated dispatch secret (Vault: ipfx_mirror_dispatch_secret; Edge secret MIRROR_DISPATCH_SECRET).
-- The secret value itself is set outside migrations and is never committed.
create or replace function public.kick_demo_mirror_outbox()
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare secret text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets
    where name = 'ipfx_mirror_dispatch_secret' limit 1;
  if secret is null then raise warning 'demo mirror outbox not scheduled: Vault secret missing'; return; end if;
  if not exists (select 1 from public.demo_mirror_outbox where status = 'pending' and next_attempt_at <= now()) then return; end if;
  perform net.http_post(
    url := 'https://agulweemteoeagscmppy.supabase.co/functions/v1/mirror-dispatch',
    headers := jsonb_build_object('x-dispatch-secret', secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
end; $function$;
revoke all on function public.kick_demo_mirror_outbox() from public, anon, authenticated;
