-- ============================================================
-- IPFX Capital — challenge rule engine
--
-- THE PROBLEM THIS FIXES
-- The engine stored and enforced exactly THREE rules:
-- profit_target_pct, max_drawdown_pct (static) and daily_loss_pct.
-- Every other rule marketed on the site was unenforced because the
-- schema had nowhere to put it. Concretely, before this migration a
-- trader could pass a $25K Traditional challenge with ONE trade on
-- day one — no minimum days, no minimum trades, no max risk per
-- trade — while the site advertised "Min Trading Days 5 per phase".
--
-- Rules marketed but previously unenforceable:
--   min trading days ............. all four challenges
--   min trades ................... Infinity 20, Futures 15
--   max risk per trade ........... Infinity 1%
--   daily profit cap ............. Infinity 3%
--   60%+ profitable days ......... Infinity Stage 2
--   trailing drawdown ............ Futures (EOD), Infinity
--   max attempts per month ....... Infinity 3
--   challenge type / stage ....... nothing distinguished them
--
-- Safe to run repeatedly (idempotent DDL).
-- ============================================================

alter table public.trading_accounts
  add column if not exists challenge_type text not null default 'traditional'
    check (challenge_type in ('infinity','traditional','futures','pac','funded')),
  add column if not exists stage int not null default 1,
  add column if not exists min_trading_days int not null default 0,
  add column if not exists min_trades int not null default 0,
  add column if not exists max_risk_per_trade_pct numeric(5,2),
  add column if not exists daily_profit_cap_pct numeric(5,2),
  add column if not exists min_profitable_days_pct numeric(5,2),
  add column if not exists drawdown_mode text not null default 'static'
    check (drawdown_mode in ('static','trailing_intraday','trailing_eod')),
  add column if not exists trailing_peak numeric(14,2),
  add column if not exists trailing_peak_date date,
  add column if not exists max_attempts_per_month int,
  add column if not exists require_stop_loss boolean not null default false;

comment on column public.trading_accounts.drawdown_mode is
  'static = floor fixed at starting_balance*(1-dd pct). trailing_intraday = floor trails the highest equity ever reached. trailing_eod = floor trails the highest END-OF-DAY equity only, which is what IPFX Futures markets.';
comment on column public.trading_accounts.trailing_peak is
  'High-water mark the trailing drawdown floor is measured down from. Null until the first enforce() pass sets it.';

-- ---- Progress view: the counters the pass-check needs ----
-- Trading days and trade counts are derived from trades rather than
-- stored, so they can never drift out of sync with reality.
create or replace view public.account_progress as
with closed as (
  select
    t.account_id,
    (t.closed_at at time zone 'UTC')::date as day,
    sum(t.pnl) as day_pnl,
    count(*) as day_trades
  from public.trades t
  where t.status = 'closed' and t.closed_at is not null
  group by t.account_id, (t.closed_at at time zone 'UTC')::date
)
select
  a.id as account_id,
  a.user_id,
  coalesce(count(c.day), 0)::int as trading_days,
  coalesce(sum(c.day_trades), 0)::int as trades_closed,
  coalesce(count(c.day) filter (where c.day_pnl > 0), 0)::int as profitable_days,
  case when count(c.day) > 0
    then round(100.0 * count(c.day) filter (where c.day_pnl > 0) / count(c.day), 2)
    else null end as profitable_days_pct
from public.trading_accounts a
left join closed c on c.account_id = a.id
group by a.id, a.user_id;

comment on view public.account_progress is
  'Derived per-account progress counters (trading days, trades, profitable-day ratio) used by the engine pass-check. Derived, never stored, so it cannot drift from the trade log.';

-- ---- Challenge presets: the marketed rules, in one place ----
-- The engine reads these when provisioning an account so the rules a
-- trader is held to are exactly the rules published on the site.
create table if not exists public.challenge_presets (
  id                       text primary key,
  challenge_type           text not null,
  stage                    int  not null default 1,
  label                    text not null,
  starting_balance         numeric(14,2) not null,
  fee_usd                  numeric(10,2),
  profit_target_pct        numeric(5,2) not null,
  max_drawdown_pct         numeric(5,2) not null,
  daily_loss_pct           numeric(5,2) not null,
  drawdown_mode            text not null default 'static',
  min_trading_days         int not null default 0,
  min_trades               int not null default 0,
  max_risk_per_trade_pct   numeric(5,2),
  daily_profit_cap_pct     numeric(5,2),
  min_profitable_days_pct  numeric(5,2),
  max_attempts_per_month   int,
  require_stop_loss        boolean not null default false,
  profit_split_pct         numeric(5,2) not null default 85,
  next_preset_id           text,
  created_at               timestamptz not null default now()
);

insert into public.challenge_presets
 (id, challenge_type, stage, label, starting_balance, fee_usd, profit_target_pct, max_drawdown_pct,
  daily_loss_pct, drawdown_mode, min_trading_days, min_trades, max_risk_per_trade_pct,
  daily_profit_cap_pct, min_profitable_days_pct, max_attempts_per_month, require_stop_loss,
  profit_split_pct, next_preset_id)
values
 -- Infinity: free 4-stage ladder. Risk caps require a stop-loss to be
 -- verifiable at all, so require_stop_loss is on for stages 1-3.
 ('infinity_s1','infinity',1,'Infinity Stage 1 - Evaluation',  1000,   0, 10,  8, 3,'trailing_intraday',10,20,1,3,NULL,3,true,  0,'infinity_s2'),
 ('infinity_s2','infinity',2,'Infinity Stage 2 - Funded Sim',  5000,   0, 10,  6, 3,'trailing_intraday',15, 0,1,NULL,60,NULL,true,85,'infinity_s3'),
 ('infinity_s3','infinity',3,'Infinity Stage 3 - Qualification',10000, 0, 10,2.5,3,'trailing_intraday',10, 0,1,NULL,NULL,NULL,true,85,'infinity_s4'),
 ('infinity_s4','infinity',4,'Infinity Stage 4 - Professional',25000,  0,  0, 6, 3,'trailing_eod',      0, 0,NULL,NULL,NULL,NULL,false,85,NULL),

 -- Traditional: 2 phases, static drawdown, no consistency rule.
 ('trad_10k_p1','traditional',1,'10K Challenge - Phase 1',  10000, 79, 8,10,5,'static',5,0,NULL,NULL,NULL,NULL,false,85,'trad_10k_p2'),
 ('trad_10k_p2','traditional',2,'10K Challenge - Phase 2',  10000,  0, 4,10,5,'static',5,0,NULL,NULL,NULL,NULL,false,85,NULL),
 ('trad_25k_p1','traditional',1,'25K Challenge - Phase 1',  25000,149, 8,10,5,'static',5,0,NULL,NULL,NULL,NULL,false,85,'trad_25k_p2'),
 ('trad_25k_p2','traditional',2,'25K Challenge - Phase 2',  25000,  0, 4,10,5,'static',5,0,NULL,NULL,NULL,NULL,false,85,NULL),
 ('trad_50k_p1','traditional',1,'50K Challenge - Phase 1',  50000,249, 8,10,5,'static',5,0,NULL,NULL,NULL,NULL,false,85,'trad_50k_p2'),
 ('trad_50k_p2','traditional',2,'50K Challenge - Phase 2',  50000,  0, 4,10,5,'static',5,0,NULL,NULL,NULL,NULL,false,85,NULL),
 ('trad_100k_p1','traditional',1,'100K Challenge - Phase 1',100000,399,8,10,5,'static',5,0,NULL,NULL,NULL,NULL,false,85,'trad_100k_p2'),
 ('trad_100k_p2','traditional',2,'100K Challenge - Phase 2',100000,  0,4,10,5,'static',5,0,NULL,NULL,NULL,NULL,false,85,NULL),
 ('trad_200k_p1','traditional',1,'200K Challenge - Phase 1',200000,699,8,10,5,'static',5,0,NULL,NULL,NULL,NULL,false,85,'trad_200k_p2'),
 ('trad_200k_p2','traditional',2,'200K Challenge - Phase 2',200000,  0,4,10,5,'static',5,0,NULL,NULL,NULL,NULL,false,85,NULL),

 -- Futures: one phase, EOD trailing drawdown as marketed.
 ('fut_25k','futures',1,'25K Futures Evaluation',  25000, 79,6,4,2,'trailing_eod',8,15,NULL,NULL,NULL,NULL,false,85,NULL),
 ('fut_50k','futures',1,'50K Futures Evaluation',  50000,109,6,4,2,'trailing_eod',8,15,NULL,NULL,NULL,NULL,false,85,NULL),
 ('fut_100k','futures',1,'100K Futures Evaluation',100000,199,6,4,2,'trailing_eod',8,15,NULL,NULL,NULL,NULL,false,85,NULL),
 ('fut_150k','futures',1,'150K Futures Evaluation',150000,299,6,4,2,'trailing_eod',8,15,NULL,NULL,NULL,NULL,false,85,NULL),

 -- PAC / Application: no evaluation phase, parameters agreed per trader.
 -- Values here are defaults an analyst overrides on the account row.
 ('pac_25k','pac',1,'25K Application Account',  25000,149,0,10,5,'static',0,0,NULL,NULL,NULL,NULL,false,85,NULL),
 ('pac_50k','pac',1,'50K Application Account',  50000,249,0,10,5,'static',0,0,NULL,NULL,NULL,NULL,false,85,NULL),
 ('pac_100k','pac',1,'100K Application Account',100000,399,0,10,5,'static',0,0,NULL,NULL,NULL,NULL,false,85,NULL),
 ('pac_250k','pac',1,'250K Application Account',250000,699,0,10,5,'static',0,0,NULL,NULL,NULL,NULL,false,85,NULL)
on conflict (id) do update set
  starting_balance=excluded.starting_balance, fee_usd=excluded.fee_usd,
  profit_target_pct=excluded.profit_target_pct, max_drawdown_pct=excluded.max_drawdown_pct,
  daily_loss_pct=excluded.daily_loss_pct, drawdown_mode=excluded.drawdown_mode,
  min_trading_days=excluded.min_trading_days, min_trades=excluded.min_trades,
  max_risk_per_trade_pct=excluded.max_risk_per_trade_pct,
  daily_profit_cap_pct=excluded.daily_profit_cap_pct,
  min_profitable_days_pct=excluded.min_profitable_days_pct,
  max_attempts_per_month=excluded.max_attempts_per_month,
  require_stop_loss=excluded.require_stop_loss,
  profit_split_pct=excluded.profit_split_pct, next_preset_id=excluded.next_preset_id;

alter table public.challenge_presets enable row level security;
drop policy if exists "presets readable" on public.challenge_presets;
create policy "presets readable" on public.challenge_presets for select using (true);

alter table public.trading_accounts
  add column if not exists preset_id text references public.challenge_presets(id);

-- Backfill existing accounts so nothing is left without a rule set.
update public.trading_accounts a set preset_id = p.id, challenge_type = p.challenge_type
from public.challenge_presets p
where a.preset_id is null and p.challenge_type='traditional' and p.stage=1
  and p.starting_balance = a.starting_balance;

-- Verify:
--   select id,label,profit_target_pct,max_drawdown_pct,drawdown_mode,min_trading_days,min_trades from public.challenge_presets order by challenge_type,stage;
--   select * from public.account_progress limit 5;

-- ---- audit: allow the new "modify" event ----
-- Moving a stop-loss is a real order event and belongs in the same audit
-- trail as opens, closes and rejects.
alter table public.order_audit_events drop constraint if exists order_audit_events_event_check;
alter table public.order_audit_events add constraint order_audit_events_event_check
  check (event in ('open','close','reject','modify'));
