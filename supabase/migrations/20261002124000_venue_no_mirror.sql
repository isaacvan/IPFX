-- Broker-demo challenges never copy-trade: imported positions must not be mirrored back to a broker.
create or replace function public.fn_set_challenge_venue() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(new.challenge_type, '') = 'demo' then new.venue := 'ipfx'; return new; end if;
  if new.funded_from_account_id is not null then
    select coalesce(a.venue, 'ipfx') into new.venue from public.trading_accounts a where a.id = new.funded_from_account_id;
  else
    select coalesce(c.challenge_venue, 'ipfx') into new.venue from public.platform_config c where c.id = true;
  end if;
  new.venue := coalesce(new.venue, 'ipfx');
  if new.venue <> 'ipfx' then new.mirror_enabled := false; end if;
  return new;
end $$;
create or replace function public.fn_venue_blocks_mirror() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.venue <> 'ipfx' and new.mirror_enabled then new.mirror_enabled := false; end if;
  return new;
end $$;
drop trigger if exists trading_accounts_venue_no_mirror on public.trading_accounts;
create trigger trading_accounts_venue_no_mirror before update of mirror_enabled, venue on public.trading_accounts
  for each row execute function public.fn_venue_blocks_mirror();
