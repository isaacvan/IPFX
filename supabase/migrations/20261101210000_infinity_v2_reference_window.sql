-- Infinity v2 price buffer fix (audit finding A01/A02, 1 Nov 2026).
-- infinity_v2_price() applies the 1.75x E8 spread only when it finds an E8 reference quote no older than 3 seconds. The E8 reference
-- worker samples each symbol every 10-30 seconds, so almost every order fell back to the plain IPFX spread and the cost buffer was
-- not applied. The window is now a setting (default 60 seconds): an E8 spread that is a minute old is still a faithful width, and
-- only the width is taken from it (the price still comes from the IPFX feed). When no reference is that recent, the price still
-- falls back to the IPFX spread so trading never stops; the result says so (fallback=true) and reports the reference age.
begin;
alter table public.infinity_v2_settings add column if not exists reference_max_age_ms int not null default 60000
  check (reference_max_age_ms between 1000 and 600000);

create or replace function public.infinity_v2_price(p_symbol text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare q public.live_quotes;r record;profile public.infinity_v2_pricing_profiles;width numeric;defaults jsonb;max_age numeric;
begin
 select rules into defaults from public.infinity_rules_versions where id='infinity_v2';
 select reference_max_age_ms/1000.0 into max_age from public.infinity_v2_settings where singleton;
 max_age:=coalesce(max_age,60);
 select * into q from public.live_quotes where symbol=p_symbol;
 if not found then return null;end if;
 select * into profile from public.infinity_v2_pricing_profiles where symbol=p_symbol;
 select e.* into r from public.e8_reference_quotes e join public.e8_monitor_profiles m on m.account_id=e.account_id and m.enabled
 where e.symbol=p_symbol and e.received_at between clock_timestamp()-make_interval(secs=>max_age) and clock_timestamp()
 and e.requested_at>=clock_timestamp()-make_interval(secs=>max_age) and e.ask>e.bid order by e.received_at desc limit 1;
 if found then width:=(r.ask-r.bid)*coalesce(profile.spread_markup,(defaults->>'default_spread_markup')::numeric);
 else width:=q.ask-q.bid;end if;
 return jsonb_build_object('bid',q.mid-width/2,'ask',q.mid+width/2,'spread',width,'fallback',r.id is null,
  'commission',profile.commission_round_turn_per_lot,'min_lot',coalesce(profile.min_lot,0.01),
  'reference_age_ms',case when r.id is null then null else round(extract(epoch from (clock_timestamp()-r.received_at))*1000) end);
end $$;
commit;
