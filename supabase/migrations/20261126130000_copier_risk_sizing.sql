-- Copier v2 sizing (owner decision 26 Nov 2026): every copy risks a fixed dollar amount to the trader's stop.
-- Infinity trades are tiny (median 0.01-0.02 lots); copied one-for-one, IBKR's minimum commission per order would
-- cost ~20 pips on EURUSD and no trader could pass the 5x-cost rule. $100 to a 9-pip EURUSD stop is ~1.1 lots,
-- where commission is ~0.4 pips. A trade opened without a stop is sized to the symbol's typical stop distance.
begin;
alter table public.copy_settings
  add column if not exists sizing text not null default 'risk' check (sizing in ('risk', 'ratio')),
  add column if not exists copy_risk_usd numeric not null default 100 check (copy_risk_usd > 0 and copy_risk_usd <= 2000);
update public.copy_settings set max_lots_per_order = 3 where singleton and max_lots_per_order = 1;
alter table public.copy_symbols add column if not exists default_stop_pips numeric not null default 10 check (default_stop_pips > 0);
update public.copy_symbols set default_stop_pips = v.p from (values
  ('EURUSD', 10), ('GBPUSD', 12), ('AUDUSD', 10), ('NZDUSD', 10), ('USDCAD', 12), ('USDCHF', 10), ('USDJPY', 12),
  ('EURJPY', 15), ('GBPJPY', 20), ('EURGBP', 8), ('EURCAD', 15), ('AUDCAD', 12),
  ('XAUUSD', 50), ('NSXUSD', 40), ('SPXUSD', 10), ('DJI', 40), ('GER40', 20), ('FRA40', 15), ('UK100', 15)) as v(s, p)
where copy_symbols.symbol = v.s;
commit;
