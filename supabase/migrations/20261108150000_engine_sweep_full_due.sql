-- Usage (8 Nov 2026): the trading engine's backup sweep runs a full per-account pass only every 30 s while the hub risk
-- engine is healthy. Each 10 s call can land on a fresh Edge isolate, so "when was the last full pass" lives here.
alter table public.engine_sweep_lease add column if not exists last_full_at timestamptz;

-- True (and stamps now) when the last full pass is at least p_seconds old; p_seconds = 0 always runs (hub not covering).
create or replace function public.engine_sweep_full_due(p_seconds integer)
returns boolean language plpgsql security definer set search_path to 'public' as $$
begin
  update public.engine_sweep_lease set last_full_at = now()
   where id and (coalesce(p_seconds, 0) <= 0 or last_full_at is null
                 or last_full_at <= now() - make_interval(secs => least(greatest(p_seconds, 0), 120)));
  return found;
end $$;
revoke all on function public.engine_sweep_full_due(integer) from public, anon, authenticated;
grant execute on function public.engine_sweep_full_due(integer) to service_role;
