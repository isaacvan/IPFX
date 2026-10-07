-- The engine already emits these source IDs. Keep audit foreign keys intact.
-- Catalog registration changes no provider connection, rate allowance or routing.
begin;
insert into public.market_data_sources(id,display_name,tier,is_official,enabled,notes)
values
 ('tradelocker','TradeLocker broker quotes','testing',false,true,
  'Existing engine quote source. Audit registration only; not proof of E8 fills or copying permission.'),
 ('ctrader','cTrader broker quotes','testing',false,true,
  'Existing engine quote source. Audit registration only; provider authorization and execution remain separate.')
on conflict(id) do nothing;
commit;
