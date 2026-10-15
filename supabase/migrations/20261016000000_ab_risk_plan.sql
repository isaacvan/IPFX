-- A-book risk plan for the E8 copy account(s), one set of rules for every trader:
--   size by risk:     each copy risks a fixed $ (lots worked out from the trader's stop; broker stop at stop_multiple x
--                     the trader's stop distance), so wide-stop trades are taken smaller instead of being refused.
--   per trader:       at most trader_max_open open copies; no new copies for a trader whose copies lost
--                     trader_daily_cut_usd today (UTC).
--   kill switch:      the equity guard reads the broker account every 10 seconds. When the broker's day P&L (closed today
--                     + open) reaches -kill_day_loss_usd, or equity falls to equity_floor_usd, execution is switched off and
--                     every position on the account is closed. It stays off until the owner turns it back on.
--   broker closes:    a copy closed by its own broker stop is recorded from the broker receipt, so the trader's later close
--                     is skipped instead of waiting forever for a receipt.
-- Installing this changes nothing until the owner saves a plan; every new field defaults to off.
alter table public.ongoing_copy_connections
 add column size_mode text not null default 'fixed' check(size_mode in('fixed','risk')),
 add column risk_per_trade_usd numeric check(risk_per_trade_usd is null or(risk_per_trade_usd>=1 and risk_per_trade_usd<=1000)),
 add column stop_multiple numeric not null default 1.5 check(stop_multiple>=1 and stop_multiple<=3),
 add column trader_max_open int check(trader_max_open is null or trader_max_open between 1 and 50),
 add column trader_daily_cut_usd numeric check(trader_daily_cut_usd is null or(trader_daily_cut_usd>=1 and trader_daily_cut_usd<=50000)),
 add column kill_switch_on boolean not null default false,
 add column kill_day_loss_usd numeric check(kill_day_loss_usd is null or(kill_day_loss_usd>=1 and kill_day_loss_usd<=100000)),
 add column equity_floor_usd numeric check(equity_floor_usd is null or equity_floor_usd>0),
 add column kill_tripped_at timestamptz,
 add column kill_reason text,
 add constraint ongoing_risk_mode_needs_amount check(size_mode<>'risk' or risk_per_trade_usd is not null),
 add constraint ongoing_kill_needs_amount check(not kill_switch_on or kill_day_loss_usd is not null);

create table public.ab_equity_guard(
 account_id bigint primary key references public.ladder_accounts(id),
 read_at timestamptz not null default now(),
 balance numeric,equity numeric,today_net numeric,open_net numeric,day_pnl numeric,positions int,error text,
 tripped_at timestamptz,trip_reason text,last_flatten jsonb
);
alter table public.ab_equity_guard enable row level security;
revoke all on public.ab_equity_guard from public,anon,authenticated;
grant select,insert,update on public.ab_equity_guard to service_role;

-- Save the whole plan in one versioned, audited change. Allowed while execution is ON; applies to new copies.
create function public.ongoing_copy_risk_plan(p_connection bigint,p_version int,p_actor uuid,p_plan jsonb,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.ongoing_copy_connections;mode text:=p_plan->>'size_mode';
 risk numeric:=nullif(p_plan->>'risk_per_trade_usd','')::numeric;mult numeric:=coalesce(nullif(p_plan->>'stop_multiple','')::numeric,1.5);
 tmax int:=nullif(p_plan->>'trader_max_open','')::int;tcut numeric:=nullif(p_plan->>'trader_daily_cut_usd','')::numeric;
 kon boolean:=coalesce((p_plan->>'kill_switch_on')::boolean,false);kill numeric:=nullif(p_plan->>'kill_day_loss_usd','')::numeric;
 floor_usd numeric:=nullif(p_plan->>'equity_floor_usd','')::numeric;
 lots numeric:=nullif(p_plan->>'lots','')::numeric;don boolean:=(p_plan->>'daily_loss_on')::boolean;dusd numeric:=nullif(p_plan->>'daily_loss_usd','')::numeric;
begin
 if not exists(select 1 from public.admins where user_id=p_actor) or length(trim(coalesce(p_reason,'')))<5 then raise exception 'OWNER_PERMISSION_REQUIRED';end if;
 select * into c from public.ongoing_copy_connections where id=p_connection for update;
 if not found or not c.connected or c.actor_id<>p_actor then raise exception 'SAVED_ACCOUNT_NOT_READY';end if;
 if p_version is distinct from c.version then raise exception 'STALE_CONNECTION_VERSION';end if;
 if mode not in('fixed','risk') or (mode='risk' and (risk is null or risk<1 or risk>1000)) or mult<1 or mult>3
  or (tmax is not null and (tmax<1 or tmax>50)) or (tcut is not null and (tcut<1 or tcut>50000))
  or (kon and (kill is null or kill<1 or kill>100000)) or (floor_usd is not null and floor_usd<=0)
  or (lots is not null and (lots<=0 or lots>1)) or (don and (dusd is null or dusd<1 or dusd>50000))
  -- Daily new-copy limit must sit below the kill switch, or the kill switch would trip on ordinary planned losses.
  or (kon and don and dusd>=kill)
  then raise exception 'RISK_PLAN_OUT_OF_RANGE';end if;
 update public.ongoing_copy_connections set size_mode=mode,risk_per_trade_usd=coalesce(risk,risk_per_trade_usd),stop_multiple=mult,
  trader_max_open=tmax,trader_daily_cut_usd=tcut,kill_switch_on=kon,kill_day_loss_usd=coalesce(kill,kill_day_loss_usd),equity_floor_usd=floor_usd,
  broker_lots=coalesce(lots,broker_lots),daily_loss_on=coalesce(don,daily_loss_on),daily_loss_usd=coalesce(dusd,daily_loss_usd),
  version=version+1,updated_at=now()where id=c.id returning * into c;
 insert into public.admin_audit_log(actor_id,action,detail)values(p_actor,'ongoing_copy_risk_plan',jsonb_build_object('connection',c.id,'size_mode',c.size_mode,
  'risk_per_trade',c.risk_per_trade_usd,'stop_multiple',c.stop_multiple,'trader_max_open',c.trader_max_open,'trader_daily_cut',c.trader_daily_cut_usd,
  'daily_loss',case when c.daily_loss_on then c.daily_loss_usd end,'kill',case when c.kill_switch_on then c.kill_day_loss_usd end,'equity_floor',c.equity_floor_usd,
  'max_lots',c.broker_lots,'execution_on',c.execution_on,'reason',left(trim(p_reason),300)));
 return jsonb_build_object('ok',true,'id',c.id,'version',c.version);
end $$;

-- Equity guard: store the broker reading and decide. Trips at most once per breach: switches execution off (same effect
-- as the owner's OFF) and asks the caller to close every position while the breach lasts.
create function public.ongoing_copy_guard_save(p_account bigint,p_reading jsonb)returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.ongoing_copy_connections;g public.ab_equity_guard;day numeric;eq numeric;pos int;breach text;was_on boolean;
 num constant text:='^-?[0-9]+(\.[0-9]+)?$';
begin
 day:=case when coalesce(p_reading->>'today_net','')~num and coalesce(p_reading->>'open_net','')~num then (p_reading->>'today_net')::numeric+(p_reading->>'open_net')::numeric end;
 eq:=case when coalesce(p_reading->>'equity','')~num then (p_reading->>'equity')::numeric end;
 pos:=case when coalesce(p_reading->>'positions','')~'^[0-9]+$' then (p_reading->>'positions')::int end;
 insert into public.ab_equity_guard as e(account_id,read_at,balance,equity,today_net,open_net,day_pnl,positions,error)
  values(p_account,now(),case when coalesce(p_reading->>'balance','')~num then (p_reading->>'balance')::numeric end,eq,
   case when coalesce(p_reading->>'today_net','')~num then (p_reading->>'today_net')::numeric end,case when coalesce(p_reading->>'open_net','')~num then (p_reading->>'open_net')::numeric end,
   day,pos,left(p_reading->>'error',200))
  on conflict(account_id)do update set read_at=excluded.read_at,error=excluded.error,
   balance=coalesce(excluded.balance,e.balance),equity=coalesce(excluded.equity,e.equity),today_net=coalesce(excluded.today_net,e.today_net),
   open_net=coalesce(excluded.open_net,e.open_net),day_pnl=coalesce(excluded.day_pnl,e.day_pnl),positions=coalesce(excluded.positions,e.positions)
  returning * into g;
 -- A failed or incomplete read never trips and never clears anything.
 if p_reading ? 'error' or day is null then return jsonb_build_object('ok',true,'flatten',false,'reason','READING_INCOMPLETE');end if;
 select * into c from public.ongoing_copy_connections where account_id=p_account and connected for update;
 if not found or not c.kill_switch_on then return jsonb_build_object('ok',true,'flatten',false,'day_pnl',day);end if;
 breach:=case when day<=-c.kill_day_loss_usd then 'DAY_LOSS' when c.equity_floor_usd is not null and eq is not null and eq<=c.equity_floor_usd then 'EQUITY_FLOOR' end;
 if breach is null then return jsonb_build_object('ok',true,'flatten',false,'day_pnl',day);end if;
 was_on:=c.execution_on;
 if was_on then
  update public.ongoing_copy_connections set execution_on=false,version=version+1,updated_at=now(),kill_tripped_at=now(),
   kill_reason=breach||': day P&L '||round(day,2)||', equity '||coalesce(round(eq,2)::text,'unknown')where id=c.id;
  insert into public.admin_audit_log(actor_id,action,detail)values(c.actor_id,'ongoing_copy_kill_switch',jsonb_build_object('connection',c.id,'reason',breach,
   'day_pnl',day,'equity',eq,'limit',c.kill_day_loss_usd,'floor',c.equity_floor_usd,'positions',pos,'execution_switched_off',true));
  update public.ab_equity_guard set tripped_at=now(),trip_reason=breach where account_id=p_account;
 end if;
 return jsonb_build_object('ok',true,'flatten',was_on or coalesce(pos,0)>0,'reason',breach,'day_pnl',day,'equity',eq,'connection_id',c.id,'tripped_now',was_on);
end $$;

create function public.ongoing_copy_guard_flattened(p_account bigint,p_result jsonb)returns void language sql security definer set search_path='' as $$
 update public.ab_equity_guard set last_flatten=jsonb_build_object('at',now())||coalesce(p_result,'{}'::jsonb) where account_id=p_account;
 insert into public.admin_audit_log(actor_id,action,detail)select c.actor_id,'ongoing_copy_flatten',jsonb_build_object('account',p_account)||coalesce(p_result,'{}'::jsonb)
  from public.ongoing_copy_connections c where c.account_id=p_account;
$$;

-- A copy closed at the broker by its own stop: record that broker close against the owned open copy (or resolve an exit
-- that was later dispatched to the already-closed position). Exact broker receipt required; nothing is sent.
create function public.fn_record_ongoing_broker_close(p_open_id bigint)returns jsonb
language plpgsql security definer set search_path='' as $$
declare root public.book_orders;c public.ongoing_copy_connections;op public.book_orders;f public.cost_fills;n int:=0;cand public.cost_fills;remaining numeric;price numeric;pnl numeric;
begin
 select * into root from public.book_orders where id=p_open_id and event='open' and status='filled' and ongoing_copy_connection_id is not null for update;
 if not found then return jsonb_build_object('ok',false,'reason','OWNED_OPEN_COPY_REQUIRED');end if;
 select * into c from public.ongoing_copy_connections where id=root.ongoing_copy_connection_id;
 if not found or root.book<>'l'||c.account_id or root.broker_position_id !~ '^[1-9][0-9]{0,19}$' or root.side not in('buy','sell')
  or root.fill_price is null or root.price_scale_per_lot is null or root.price_scale_per_lot<=0 then return jsonb_build_object('ok',false,'reason','OPEN_OWNERSHIP_UNVERIFIED');end if;
 select root.qty-coalesce(sum(broker_confirmed_qty),0)into remaining from public.book_orders where book=root.book and source_trade_id=root.source_trade_id and event<>'open' and dispatch_state='confirmed';
 if remaining<=0 then return jsonb_build_object('ok',true,'skipped','ALREADY_CLOSED');end if;
 for cand in select * from public.cost_fills x where x.account_id=c.account_id and x.raw->>'positionId'=root.broker_position_id
  and x.raw->>'isOpen'='false' and lower(x.raw->>'status')='filled' and x.raw->>'side'=(case root.side when 'buy' then 'sell' else 'buy' end)
  and coalesce(x.raw->>'createdDate','')~'^[0-9]{13}$' and (x.raw->>'createdDate')::numeric>=extract(epoch from root.created_at)*1000
  and coalesce(x.raw->>'filledQty','')~'^[0-9]+([.][0-9]+)?$' and coalesce(x.raw->>'avgPrice','')~'^[0-9]+([.][0-9]+)?$' and x.ref~'^[1-9][0-9]{0,19}$'
  and not exists(select 1 from public.book_orders b where b.book=root.book and b.broker_order_id=x.ref and b.dispatch_state='confirmed')
 loop n:=n+1;f:=cand;end loop;
 if n=0 then return jsonb_build_object('ok',false,'reason','WAITING_BROKER_CLOSE_RECEIPT');end if;
 if n<>1 or (f.raw->>'filledQty')::numeric<>remaining then return jsonb_build_object('ok',false,'reason','BROKER_CLOSE_NEEDS_REVIEW','receipts',n);end if;
 price:=(f.raw->>'avgPrice')::numeric;pnl:=round((price-root.fill_price)*(case root.side when 'buy' then 1 else -1 end)*remaining*root.price_scale_per_lot,2);
 select * into op from public.book_orders where book=root.book and source_trade_id=root.source_trade_id and event<>'open' and dispatch_state<>'confirmed' order by id limit 1 for update;
 if found then
  update public.book_orders set status='closed',dispatch_state='confirmed',broker_confirmed_qty=op.qty,broker_order_id=f.ref,fill_price=price,
   pnl_usd=round((price-root.fill_price)*(case root.side when 'buy' then 1 else -1 end)*op.qty*root.price_scale_per_lot,2),
   error='Closed earlier at the broker (stop or kill switch); recorded from broker receipt',updated_at=now()where id=op.id and op.qty=remaining returning * into op;
  if not found then return jsonb_build_object('ok',false,'reason','BROKER_CLOSE_NEEDS_REVIEW');end if;
 else
  insert into public.book_orders(book,source_trade_id,person_id,event,idempotency_key,symbol,side,qty,status,dispatch_state,broker_confirmed_qty,broker_order_id,
   broker_position_id,fill_price,pnl_usd,price_scale_per_lot,ongoing_copy_connection_id,error)
  values(root.book,root.source_trade_id,root.person_id,'close',root.book||':'||root.source_trade_id||':close',root.symbol,case root.side when 'buy' then 'sell' else 'buy' end,
   remaining,'closed','confirmed',remaining,f.ref,root.broker_position_id,price,pnl,root.price_scale_per_lot,c.id,'Closed at the broker by its stop; recorded from broker receipt')
  returning * into op;
 end if;
 perform public.fn_finalize_book_exit(op.id);
 return jsonb_build_object('ok',true,'exit_id',op.id,'pnl_usd',op.pnl_usd,'fill_price',price);
end $$;

-- Admission: per-trader limits, and the sizing rules for this copy (a trader with their own lots uses fixed lots).
do $claim$declare src text;a1 text:='insert into public.ongoing_copy_intents(connection_id,source_trade_id)values(c.id,t.id);';
 a2 text:='''broker_lots'',coalesce(s.lots,c.broker_lots),';begin
 src:=pg_get_functiondef('public.ongoing_copy_claim(uuid)'::regprocedure);
 if array_length(string_to_array(src,a1),1)<>2 or array_length(string_to_array(src,a2),1)<>2 then raise exception 'RISK_PLAN_CLAIM_SOURCE_DRIFT';end if;
 src:=replace(src,a1,
 'if c.trader_max_open is not null and (select count(*) from public.book_orders o join public.trades st on st.id=o.source_trade_id where o.ongoing_copy_connection_id=c.id and o.event=''open'' and o.person_id=s.person_id
   and o.status in(''sent'',''filled'',''reconciliation_required'') and st.status=''open''
   and not exists(select 1 from public.book_orders e where e.book=o.book and e.source_trade_id=o.source_trade_id and e.event=''close'' and e.dispatch_state=''confirmed''))>=c.trader_max_open
  then return jsonb_build_object(''handled'',true,''ok'',false,''reason'',''TRADER_OPEN_COPY_LIMIT'');end if;
 if c.trader_daily_cut_usd is not null and coalesce((select sum(e.pnl_usd) from public.book_orders e join public.book_orders o on o.book=e.book and o.source_trade_id=e.source_trade_id and o.event=''open''
   where o.ongoing_copy_connection_id=c.id and o.person_id=s.person_id and e.event<>''open'' and e.status=''closed'' and e.updated_at>=date_trunc(''day'',now() at time zone ''utc'') at time zone ''utc''),0)<=-c.trader_daily_cut_usd
  then return jsonb_build_object(''handled'',true,''ok'',false,''reason'',''TRADER_DAILY_LOSS_CUT'');end if;
 '||a1);
 src:=replace(src,a2,a2||'''size_mode'',case when s.lots is not null then ''fixed'' else c.size_mode end,''risk_per_trade_usd'',c.risk_per_trade_usd,''stop_multiple'',c.stop_multiple,');
 execute src;
end $claim$;

-- Daily new-copy limit also counts the broker's own closed P&L for its day when the guard has a fresh reading.
do $risk$declare src text;a1 text:='day_loss := greatest(-day_pnl, 0);';begin
 src:=pg_get_functiondef('public.ab_reserve_risk(text,uuid,uuid,text,numeric,numeric)'::regprocedure);
 if array_length(string_to_array(src,a1),1)<>2 then raise exception 'RISK_PLAN_RESERVE_SOURCE_DRIFT';end if;
 execute replace(src,a1,a1||E'\n  if la.id is not null then day_loss := greatest(day_loss, coalesce((select -g.today_net from public.ab_equity_guard g where g.account_id = la.id and g.read_at > now() - interval ''2 minutes'' and g.today_net < 0), 0)); end if;');
end $risk$;

-- Every 10 seconds while a copy account has execution or the kill switch on.
create function public.kick_equity_guard()returns void language plpgsql security definer set search_path='' as $$
declare secret text;
begin
 if not exists(select 1 from public.ongoing_copy_connections where connected and(execution_on or kill_switch_on))then return;end if;
 select decrypted_secret into secret from vault.decrypted_secrets where name='ipfx_book_executor_secret' limit 1;
 if secret is null then raise warning 'equity guard not run: Vault secret missing';return;end if;
 perform net.http_post(url:='https://agulweemteoeagscmppy.supabase.co/functions/v1/book-executor',
  headers:=jsonb_build_object('x-book-secret',secret,'Content-Type','application/json'),body:=jsonb_build_object('action','equity_guard'),timeout_milliseconds:=9000);
end $$;

do $$declare f text;begin foreach f in array array['ongoing_copy_risk_plan(bigint,int,uuid,jsonb,text)','ongoing_copy_guard_save(bigint,jsonb)','ongoing_copy_guard_flattened(bigint,jsonb)',
 'fn_record_ongoing_broker_close(bigint)','kick_equity_guard()'] loop
 execute 'revoke all on function public.'||f||' from public,anon,authenticated';execute 'grant execute on function public.'||f||' to service_role';end loop;end $$;

do $cron$begin
 if exists(select 1 from pg_extension where extname='pg_cron') then
  perform cron.unschedule(jobid) from cron.job where jobname='ipfx-equity-guard';
  perform cron.schedule('ipfx-equity-guard','10 seconds','select public.kick_equity_guard()');
 end if;
end $cron$;
