-- New challenge accounts take the site-wide venue (platform_config.challenge_venue); later stages and funded
-- accounts inherit their parent's venue. Demo accounts always stay on IPFX Markets.
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
  return new;
end $$;
drop trigger if exists trading_accounts_set_venue on public.trading_accounts;
create trigger trading_accounts_set_venue before insert on public.trading_accounts
  for each row execute function public.fn_set_challenge_venue();
