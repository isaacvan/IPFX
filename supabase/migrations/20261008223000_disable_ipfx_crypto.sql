-- IPFX Markets does not accept cryptocurrency entries. Keep existing position
-- and history rows so traders can still close/manage prior exposure.
begin;

update public.symbol_specs
set enabled = false, disabled_reason = 'Crypto trading is not available on IPFX Markets.'
where asset_class = 'crypto' or symbol in ('BTCUSD','ETHUSD','LTCUSD','ADAUSD','SOLUSD','DOTUSD');

create or replace function public.ipfx_block_crypto_entry()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  sym text := regexp_replace(upper(new.symbol), '^.*:', '');
begin
  -- Broker-imported records are outside IPFX Markets; closed history is kept.
  if exists (select 1 from public.trading_accounts a where a.id = new.account_id
             and coalesce(a.venue, 'ipfx') = 'ipfx')
     and (sym in ('BTCUSD','ETHUSD','LTCUSD','ADAUSD','SOLUSD','DOTUSD')
          or exists (select 1 from public.symbol_specs s where s.symbol = sym and s.asset_class = 'crypto')) then
    if (tg_table_name = 'trades' and new.status = 'open')
       or (tg_table_name = 'pending_orders' and new.status = 'pending') then
      raise exception 'Crypto trading is not available on IPFX Markets.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.ipfx_block_crypto_entry() from public, anon, authenticated;

drop trigger if exists ipfx_no_crypto_trade on public.trades;
create trigger ipfx_no_crypto_trade before insert on public.trades
for each row execute function public.ipfx_block_crypto_entry();
drop trigger if exists ipfx_no_crypto_pending on public.pending_orders;
create trigger ipfx_no_crypto_pending before insert or update of symbol, status on public.pending_orders
for each row execute function public.ipfx_block_crypto_entry();

update public.pending_orders p
set status = 'cancelled', resolved_at = now(), reject_reason = 'Crypto trading is not available on IPFX Markets.'
where p.status = 'pending'
  and exists (select 1 from public.trading_accounts a where a.id = p.account_id and coalesce(a.venue, 'ipfx') = 'ipfx')
  and (regexp_replace(upper(p.symbol), '^.*:', '') in ('BTCUSD','ETHUSD','LTCUSD','ADAUSD','SOLUSD','DOTUSD')
       or exists (select 1 from public.symbol_specs s where s.symbol = p.symbol and s.asset_class = 'crypto'));

commit;
