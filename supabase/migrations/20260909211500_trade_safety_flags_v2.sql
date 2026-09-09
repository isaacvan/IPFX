-- ============================================================
-- IPFX Capital — extend trade_safety_flags with three more patterns
--
-- 20260909193000_trade_safety_flags.sql already flags UNUSUAL_SAME_SYMBOL_SIZE
-- (this trade's volume vs its own account/symbol median), REQUIRED_STOP_MISSING
-- and ACCOUNT_STOP_RISK_LIMIT. Those catch one outsized trade and a missing
-- stop. This adds three patterns that describe SEQUENCES of trades, which a
-- single-trade check cannot see:
--
--   CAP_HUGGING     — three trades in a row all sized right at the account's
--                      risk ceiling. Distinct from one big trade: it is what
--                      "stopped varying size, running every trade at the
--                      maximum the rules allow" looks like.
--   REVENGE_SIZING   — size increased sharply within minutes of a loss on
--                      the same account. The sizing signature of trying to
--                      win a loss back immediately rather than following a
--                      plan.
--   DRAWDOWN_SWING    — this trade's own risk, alone, would consume most of
--                      the account's remaining drawdown buffer if it lost.
--                      True regardless of whether it is unusual for this
--                      trader specifically.
--
-- Same table, same trigger, same reason/evidence/status shape as before —
-- this is CREATE OR REPLACE on the existing function, not a new table, so
-- the review queue and RLS the first migration set up need no changes.
--
-- Descriptive only: none of this blocks an order (the hard caps in
-- trading-engine already do that) and none of it auto-actions an account.
-- An admin reviews trade_safety_flags and decides what, if anything, to do.
--
-- Safe to run repeatedly (idempotent DDL).
-- ============================================================

begin;

create or replace function public.capture_trade_safety_flags() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  a public.trading_accounts; spec public.symbol_specs; baseline numeric; n integer;
  risk_amount numeric; risk_fraction numeric;
  cap_usd numeric; near_cap_count integer;
  last_trade public.trades; seconds_since_last numeric;
  dd_floor numeric; latest_equity numeric; dd_buffer numeric;
begin
  if new.status<>'open' then return new; end if;
  if TG_OP='UPDATE' and new.volume is not distinct from old.volume and new.sl is not distinct from old.sl then return new; end if;
  select * into a from public.trading_accounts where id=new.account_id;
  select * into spec from public.symbol_specs where symbol=new.symbol;

  -- ---- existing: UNUSUAL_SAME_SYMBOL_SIZE ----
  select count(*),percentile_cont(0.5) within group(order by volume) into n,baseline
    from (select volume from public.trades where account_id=new.account_id and symbol=new.symbol
      and id<>new.id and opened_at<new.opened_at order by opened_at desc limit 30) h;
  if n>=20 and baseline>0 and new.volume>baseline*3 then
    insert into public.trade_safety_flags(trade_id,account_id,user_id,reason,evidence)
      values(new.id,new.account_id,new.user_id,'UNUSUAL_SAME_SYMBOL_SIZE',
        jsonb_build_object('volume',new.volume,'baseline_median_volume',baseline,'baseline_fills',n,
          'threshold_multiple',3,'symbol',new.symbol,'basis','same_account_same_contract_not_strategy_probability'))
      on conflict(trade_id,reason) do update set evidence=excluded.evidence,status='open';
  end if;

  -- ---- existing: REQUIRED_STOP_MISSING ----
  if new.sl is null and a.require_stop_loss then
    insert into public.trade_safety_flags(trade_id,account_id,user_id,reason,evidence)
      values(new.id,new.account_id,new.user_id,'REQUIRED_STOP_MISSING',jsonb_build_object('symbol',new.symbol))
      on conflict(trade_id,reason) do update set evidence=excluded.evidence,status='open';
  end if;

  -- ---- existing: ACCOUNT_STOP_RISK_LIMIT ----
  if new.sl is not null and spec.quote_currency='USD' and spec.contract_size>0 and a.starting_balance>0 then
    risk_amount:=greatest(case when new.side='buy' then new.open_price-new.sl else new.sl-new.open_price end,0)*new.volume*spec.contract_size;
    risk_fraction:=risk_amount/a.starting_balance;
    if a.max_risk_per_trade_pct is not null and risk_fraction>a.max_risk_per_trade_pct/100 then
      insert into public.trade_safety_flags(trade_id,account_id,user_id,reason,evidence)
        values(new.id,new.account_id,new.user_id,'ACCOUNT_STOP_RISK_LIMIT',
          jsonb_build_object('stop_risk_usd',risk_amount,'starting_balance',a.starting_balance,
            'risk_fraction',risk_fraction,'limit_pct',a.max_risk_per_trade_pct,
            'excludes_gap_slippage',true))
        on conflict(trade_id,reason) do update set evidence=excluded.evidence,status='open';
    end if;

    -- ---- new: CAP_HUGGING ----
    -- risk_amount/risk_fraction above are already computed for this trade;
    -- reuse them rather than recomputing.
    if a.max_risk_per_trade_pct is not null then
      cap_usd := a.starting_balance * a.max_risk_per_trade_pct / 100;
      if cap_usd > 0 and risk_amount >= cap_usd * 0.9 then
        select count(*) into near_cap_count from (
          select greatest(case when tr.side='buy' then tr.open_price-tr.sl else tr.sl-tr.open_price end,0)
                 * tr.volume * sp.contract_size as r
          from public.trades tr join public.symbol_specs sp on sp.symbol=tr.symbol
          where tr.account_id=new.account_id and tr.sl is not null and tr.opened_at<=new.opened_at
          order by tr.opened_at desc limit 3
        ) last3 where r >= cap_usd * 0.9;
        if near_cap_count >= 3 then
          insert into public.trade_safety_flags(trade_id,account_id,user_id,reason,evidence)
            values(new.id,new.account_id,new.user_id,'CAP_HUGGING',
              jsonb_build_object('stop_risk_usd',risk_amount,'cap_usd',round(cap_usd,2),'symbol',new.symbol,
                'basis','last_3_stop_sized_trades_all_at_or_above_90pct_of_cap'))
            on conflict(trade_id,reason) do update set evidence=excluded.evidence,status='open';
        end if;
      end if;
    end if;

    -- ---- new: DRAWDOWN_SWING ----
    if a.max_drawdown_pct is not null then
      if a.drawdown_mode = 'static' then
        dd_floor := a.starting_balance * (1 - a.max_drawdown_pct/100);
      else
        dd_floor := coalesce(a.trailing_peak, a.starting_balance) * (1 - a.max_drawdown_pct/100);
      end if;
      select equity into latest_equity from public.equity_snapshots
        where account_id=new.account_id order by created_at desc limit 1;
      dd_buffer := coalesce(latest_equity, a.starting_balance) - dd_floor;
      if dd_buffer > 0 and risk_amount >= dd_buffer * 0.5 then
        insert into public.trade_safety_flags(trade_id,account_id,user_id,reason,evidence)
          values(new.id,new.account_id,new.user_id,'DRAWDOWN_SWING',
            jsonb_build_object('stop_risk_usd',risk_amount,'remaining_drawdown_buffer_usd',round(dd_buffer,2),
              'pct_of_buffer',round(100*risk_amount/dd_buffer,1),'symbol',new.symbol))
          on conflict(trade_id,reason) do update set evidence=excluded.evidence,status='open';
      end if;
    end if;
  end if;

  -- ---- new: REVENGE_SIZING ----
  -- Independent of the sl/contract_size guard above -- compares raw
  -- volume, not dollar risk, so it still fires even without a stop.
  select * into last_trade from public.trades
    where account_id=new.account_id and id<>new.id and status='closed' and closed_at is not null
      and closed_at<=new.opened_at
    order by closed_at desc limit 1;
  if found and last_trade.pnl is not null and last_trade.pnl < 0 then
    seconds_since_last := extract(epoch from (new.opened_at - last_trade.closed_at));
    if seconds_since_last >= 0 and seconds_since_last <= 900
       and last_trade.volume > 0 and new.volume >= last_trade.volume * 1.75 then
      insert into public.trade_safety_flags(trade_id,account_id,user_id,reason,evidence)
        values(new.id,new.account_id,new.user_id,'REVENGE_SIZING',
          jsonb_build_object('this_volume',new.volume,'prior_volume',last_trade.volume,
            'prior_loss_usd',last_trade.pnl,'seconds_after_loss',round(seconds_since_last)))
        on conflict(trade_id,reason) do update set evidence=excluded.evidence,status='open';
    end if;
  end if;

  return new;
end $$;

revoke all on function public.capture_trade_safety_flags() from public,anon,authenticated;

-- Widen the check constraint the first migration put on trade_safety_flags.reason
-- to admit the three new values (a bare CHECK on an inline enum, if the first
-- migration used one -- confirmed it did not, `reason text not null` with no
-- check, so nothing to alter here; left as a comment in case that changes).

commit;

-- Verify after deploying:
--   select reason, count(*) from public.trade_safety_flags group by 1 order by 1;
--   select * from public.trade_safety_flags where status='open' order by created_at desc limit 20;
