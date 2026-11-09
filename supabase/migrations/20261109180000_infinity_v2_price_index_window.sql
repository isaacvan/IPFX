-- CPU / Disk IO (9 Nov 2026): infinity_v2_price() compared received_at with clock_timestamp() inside the query. A
-- volatile bound cannot be used as an index condition, so every call walked the symbol's whole 7-day E8 reference
-- history (~40k rows, ~36k buffers, ~50 ms). It runs for every v2 order, for every v2 trade's equity mark and from the
-- live_quotes risk trigger several times a second (~60% of one CPU core). The window is now worked out once, before the
-- query: same rows, same result, a few index reads.
create or replace function public.infinity_v2_price(p_symbol text)
 returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare q public.live_quotes;r record;profile public.infinity_v2_pricing_profiles;width numeric;defaults jsonb;max_age numeric;
 now_ts timestamptz;since timestamptz;
begin
 select rules into defaults from public.infinity_rules_versions where id='infinity_v2';
 select reference_max_age_ms/1000.0 into max_age from public.infinity_v2_settings where singleton;
 max_age:=coalesce(max_age,60);
 now_ts:=clock_timestamp();since:=now_ts-make_interval(secs=>max_age);
 select * into q from public.live_quotes where symbol=p_symbol;
 if not found then return null;end if;
 select * into profile from public.infinity_v2_pricing_profiles where symbol=p_symbol;
 select e.* into r from public.e8_reference_quotes e join public.e8_monitor_profiles m on m.account_id=e.account_id and m.enabled
 where e.symbol=p_symbol and e.received_at between since and now_ts
 and e.requested_at>=since and e.ask>e.bid order by e.received_at desc limit 1;
 if found then width:=(r.ask-r.bid)*coalesce(profile.spread_markup,(defaults->>'default_spread_markup')::numeric);
 else width:=q.ask-q.bid;end if;
 return jsonb_build_object('bid',q.mid-width/2,'ask',q.mid+width/2,'spread',width,'fallback',r.id is null,
  'commission',profile.commission_round_turn_per_lot,'min_lot',coalesce(profile.min_lot,0.01),
  'reference_age_ms',case when r.id is null then null else round(extract(epoch from (clock_timestamp()-r.received_at))*1000) end);
end $function$;
