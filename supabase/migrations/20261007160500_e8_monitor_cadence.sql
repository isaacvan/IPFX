begin;
-- Dispatch arrives after the cron boundary. A claim-relative deadline skips
-- the following kick; align deadlines to the next sampling boundary instead.
-- Keep leases, read-only eligibility and the separate API allowance unchanged.
create or replace function public.e8_monitor_claim() returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.e8_monitor_profiles;
begin
 select m.* into p from public.e8_monitor_profiles m join public.ladder_accounts a on a.id=m.account_id
 where m.enabled and m.next_run<=now() and (m.lease_until is null or m.lease_until<now())
 and a.role='monitor' and not a.execution_enabled and a.platform='tradelocker'
 order by m.next_run,m.account_id for update of m skip locked limit 1;
 if not found then return null; end if;
 update public.e8_monitor_profiles set lease=gen_random_uuid(),lease_until=now()+interval '45 seconds',
 next_run=to_timestamp((floor(extract(epoch from clock_timestamp())/(interval_ms/1000.0))+1)*(interval_ms/1000.0))
 where account_id=p.account_id returning * into p;
 return to_jsonb(p);
end $$;
revoke all on function public.e8_monitor_claim() from public,anon,authenticated;
grant execute on function public.e8_monitor_claim() to service_role;
commit;
