-- Infinity stop-loss rule (owner decision 2026-10-05, live now; written into the Terms before launch):
--   * An Infinity trade still without a stop loss 30 seconds after opening is closed automatically.
--   * That trade's PROFIT is removed (a loss still counts) and it does not count towards trading days,
--     trade counts, profitable days or qualification sessions.
--   * Each one is a warning. 3 warnings in the same Infinity run end the run (breach reason 'stop_loss_rule'):
--     open trades are closed and the trader restarts from Stage 1. A new run starts on 0 warnings.
-- Other account types (demo, traditional) are not affected.

alter table public.trading_accounts add column if not exists sl_strikes int not null default 0;
alter table public.trades add column if not exists stripped_profit numeric;

create table if not exists public.sl_strikes (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.trading_accounts (id) on delete cascade,
  user_id uuid not null,
  trade_id uuid not null unique,
  strike_no int not null,
  stripped_profit numeric not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists sl_strikes_account on public.sl_strikes (account_id);
alter table public.sl_strikes enable row level security;
revoke all on public.sl_strikes from public, anon, authenticated;
grant select on public.sl_strikes to authenticated;
grant select, insert on public.sl_strikes to service_role;
drop policy if exists "traders see their own stop-loss warnings" on public.sl_strikes;
create policy "traders see their own stop-loss warnings" on public.sl_strikes for select to authenticated
  using (user_id = (select auth.uid()));

-- One warning per trade, counted atomically. Returns the account's warning count after this trade.
create or replace function public.fn_record_sl_strike(p_account uuid, p_trade uuid, p_stripped numeric)
returns int language plpgsql security definer set search_path to '' as $$
declare a public.trading_accounts; n int;
begin
  select * into a from public.trading_accounts where id = p_account for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  if exists (select 1 from public.sl_strikes where trade_id = p_trade) then return a.sl_strikes; end if;
  n := a.sl_strikes + 1;
  insert into public.sl_strikes (account_id, user_id, trade_id, strike_no, stripped_profit)
  values (a.id, a.user_id, p_trade, n, greatest(coalesce(p_stripped, 0), 0));
  update public.trading_accounts set sl_strikes = n, updated_at = clock_timestamp() where id = a.id;
  return n;
end $$;
revoke all on function public.fn_record_sl_strike(uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.fn_record_sl_strike(uuid, uuid, numeric) to service_role;

-- Breach reason 'stop_loss_rule' (3 warnings in one run), same freeze / demo switch / order cancel as the others.
alter table public.account_breach_events drop constraint if exists account_breach_events_reason_check;
alter table public.account_breach_events add constraint account_breach_events_reason_check
  check (reason = any (array['max_drawdown', 'daily_loss', 'stop_loss_rule']));

create or replace function public.fn_claim_account_breach(p_account_id uuid, p_reason text, p_trigger_equity numeric, p_breach_floor numeric)
returns boolean language plpgsql security definer set search_path to '' as $function$
declare a public.trading_accounts;
begin
  if p_reason not in ('max_drawdown','daily_loss','stop_loss_rule')
     or p_trigger_equity is null or p_breach_floor is null then
    raise exception 'INVALID_BREACH_CLAIM';
  end if;
  select * into a from public.trading_accounts where id=p_account_id for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  if a.phase='demo' or a.status='demo' then raise exception 'DEMO_CANNOT_BREACH'; end if;
  if a.status='breached' then
    perform public.fn_ensure_demo_account(a.user_id);
    return false;
  end if;
  if a.status<>'active' then raise exception 'ACCOUNT_NOT_ACTIVE'; end if;

  update public.trading_accounts
     set status='breached', breach_reason=p_reason,
         breached_at=clock_timestamp(), breach_equity=p_trigger_equity,
         breach_floor=p_breach_floor, access_revoked_at=clock_timestamp(),
         access_revoked_reason='challenge_rule_breach:'||p_reason,
         mirror_enabled=false, updated_at=clock_timestamp()
   where id=p_account_id;
  insert into public.account_breach_events(
    account_id,user_id,challenge_type,stage,reason,trigger_equity,breach_floor
  ) values (
    a.id,a.user_id,a.challenge_type,a.stage,p_reason,p_trigger_equity,p_breach_floor
  ) on conflict (account_id) do nothing;
  update public.pending_orders
     set status='cancelled', resolved_at=clock_timestamp()
   where account_id=p_account_id and status='pending';
  perform public.fn_ensure_demo_account(a.user_id);
  return true;
end;
$function$;

-- Progress: a warned trade never counts towards trading days, trade counts or profitable days.
create or replace view public.account_progress as
 WITH closed AS (
         SELECT t.account_id,
            (t.closed_at AT TIME ZONE 'UTC'::text)::date AS day,
            t.pnl,
                CASE
                    WHEN a_1.created_at >= '2026-10-01 00:00:00+00'::timestamp with time zone THEN t.close_reason IS DISTINCT FROM 'partial'::text AND (t.closed_at - t.opened_at) >= '00:01:00'::interval AND t.close_reason IS DISTINCT FROM 'no_stop_loss'::text
                    ELSE t.close_reason IS DISTINCT FROM 'no_stop_loss'::text
                END AS counts,
                CASE
                    WHEN a_1.created_at >= '2026-10-01 00:00:00+00'::timestamp with time zone THEN a_1.starting_balance * 0.0025
                    ELSE 0::numeric
                END AS min_day_profit
           FROM trades t
             JOIN trading_accounts a_1 ON a_1.id = t.account_id
          WHERE t.status = 'closed'::text AND t.closed_at IS NOT NULL
        ), days AS (
         SELECT closed.account_id,
            closed.day,
            sum(closed.pnl) AS day_pnl,
            count(*) FILTER (WHERE closed.counts) AS day_trades,
            max(closed.min_day_profit) AS min_day_profit
           FROM closed
          GROUP BY closed.account_id, closed.day
        )
 SELECT a.id AS account_id,
    a.user_id,
    COALESCE(count(d.day) FILTER (WHERE d.day_trades > 0), 0::bigint)::integer AS trading_days,
    COALESCE(sum(d.day_trades), 0::numeric)::integer AS trades_closed,
    COALESCE(count(d.day) FILTER (WHERE d.day_trades > 0 AND d.day_pnl > d.min_day_profit), 0::bigint)::integer AS profitable_days,
        CASE
            WHEN count(d.day) FILTER (WHERE d.day_trades > 0) > 0 THEN round(100.0 * count(d.day) FILTER (WHERE d.day_trades > 0 AND d.day_pnl > d.min_day_profit)::numeric / count(d.day) FILTER (WHERE d.day_trades > 0)::numeric, 2)
            ELSE NULL::numeric
        END AS profitable_days_pct
   FROM trading_accounts a
     LEFT JOIN days d ON d.account_id = a.id
  GROUP BY a.id, a.user_id;

-- Qualification sessions: a warned trade is not a session.
do $$
declare def text; target text := $q$from public.trades where account_id=p_account and status='closed' and opened_at>=c.accepted_at$q$;
begin
  def := pg_get_functiondef('public.qualification_progress_v2(uuid)'::regprocedure);
  if position('no_stop_loss' in def) = 0 then
    if position(target in def) = 0 then raise exception 'qualification_progress_v2: session query not found'; end if;
    def := replace(def, target, target || $q$ and close_reason is distinct from 'no_stop_loss'$q$);
    execute def;
  end if;
end $$;

-- Switch the 30-second rule on (enforced for Infinity accounts only, see trading-engine enforce()).
update public.ab_settings set sl_deadline_seconds = 30, updated_at = now();
