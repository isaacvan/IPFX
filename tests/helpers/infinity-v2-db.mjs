import fs from 'node:fs';import {pathToFileURL} from 'node:url';
export const uid='22222222-2222-4222-8222-222222222222';
export const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8').replace(/\r\n/g,'\n');
export const sqlFile=n=>read('supabase/migrations/'+n+'.sql');
export function definition(file,name){const src=sqlFile(file),re=new RegExp('create(?: or replace)? function public\\.'+name+'\\([\\s\\S]*?\\$([a-zA-Z_]*)\\$[\\s\\S]*?\\$\\1\\$\\s*;','i');const m=src.match(re);if(!m)throw Error(name+' missing');return m[0];}
export async function v2db({adapters=true,restart=true}={}){
 const {PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js').href);const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema cron;
 create function cron.schedule(text,text,text) returns bigint language sql as 'select 1::bigint';
 create table auth.users(id uuid primary key,email_confirmed_at timestamptz,email text default 'local@example.invalid');
 create table trading_accounts(id uuid primary key default gen_random_uuid(),user_id uuid,label text,preset_id text,challenge_type text,stage int,phase text,status text,
 constraint trading_accounts_status_check check(status in('active','passed','breached','demo')),
 starting_balance numeric,balance numeric,day_start_equity numeric,day_start_date date,profit_target_pct numeric,max_drawdown_pct numeric,daily_loss_pct numeric,
 drawdown_mode text,trailing_peak numeric,trailing_peak_date date,min_trading_days int,min_trades int,max_risk_per_trade_pct numeric,daily_profit_cap_pct numeric,
 min_profitable_days_pct numeric,require_stop_loss boolean,profit_split_pct numeric,challenge_fee_usd numeric,total_paid_out numeric default 0,funded_from_account_id uuid,
 approval_request_id uuid,venue text default 'ipfx',investigation_hold boolean default false,access_revoked_at timestamptz,access_revoked_reason text,
 breach_reason text,breached_at timestamptz,breach_equity numeric,breach_floor numeric,mirror_enabled boolean default false,sl_strikes int default 0,updated_at timestamptz,created_at timestamptz default clock_timestamp());
 create table trades(id uuid primary key default gen_random_uuid(),account_id uuid,user_id uuid,symbol text,side text,volume numeric,open_price numeric,sl numeric,tp numeric,trail_distance numeric,
 status text default 'open',opened_at timestamptz default clock_timestamp(),closed_at timestamptz,pnl numeric,close_price numeric,close_reason text,parent_trade_id uuid,
 commission numeric,execution_shortfall numeric,pnl_basis text,stripped_profit numeric);
 create table pending_orders(id uuid primary key default gen_random_uuid(),account_id uuid,status text,symbol text,side text,volume numeric,trigger_price numeric,sl numeric,tp numeric,created_at timestamptz default now(),resolved_at timestamptz,order_type text,expires_at timestamptz);
 create table ab_settings(sl_deadline_seconds int);insert into ab_settings values(null);
 create function hub_check(text)returns boolean language sql as 'select true';
 create table live_quotes(symbol text primary key,mid numeric,bid numeric,ask numeric,received_at timestamptz);
 create table symbol_specs(symbol text primary key,contract_size numeric,quote_currency text,enabled boolean default true);
 create table e8_monitor_profiles(account_id bigint primary key,enabled boolean);
 create table e8_reference_quotes(id bigint,account_id bigint,symbol text,bid numeric,ask numeric,received_at timestamptz,requested_at timestamptz);
 create table ab_hedge_flags(person_a uuid,person_b uuid,status text,id bigint generated always as identity,first_seen timestamptz default now(),shared int default 4,share numeric default .5,net_ratio numeric default 0);
 create table ab_alerts(key text primary key,person_id uuid,category text,title text,resolved_at timestamptz,last_seen timestamptz,first_seen timestamptz default now(),detail text,value numeric);
 create function ab_person_of(uuid)returns uuid language sql as 'select $1';
 create function auth.uid()returns uuid language sql as 'select null::uuid';
 create function fn_is_admin()returns boolean language sql as 'select false';
 create table ab_heartbeats(worker text primary key,ok boolean,at timestamptz,detail jsonb);
 create table account_breach_events(account_id uuid primary key,user_id uuid,challenge_type text,stage int,reason text,trigger_equity numeric,breach_floor numeric);
 create table platform_legal_documents(version text primary key,kind text,document_url text);
 create table platform_legal_current(kind text primary key,version text);
 create table platform_legal_acceptances(user_id uuid,terms_version text,privacy_version text,context jsonb);
 create table user_profiles(user_id uuid primary key,age_confirmed boolean,restricted_jurisdiction boolean);
 create table trader_identity_private(user_id uuid primary key,date_of_birth date,phone_e164 text,legal_first_name text,legal_last_name text,address_line_1 text,postal_code text,country_code text);
 create table trader_kyc(user_id uuid primary key,status text);
 create table challenge_presets(id text primary key,label text,challenge_type text,stage int,starting_balance numeric,profit_target_pct numeric,max_drawdown_pct numeric,daily_loss_pct numeric,drawdown_mode text,max_risk_per_trade_pct numeric,max_attempts_per_month int,daily_profit_cap_pct numeric,min_trading_days int,min_trades int,min_profitable_days_pct numeric,require_stop_loss boolean,profit_split_pct numeric,next_preset_id text);
 create table challenge_enrolment_requests(id uuid primary key default gen_random_uuid(),application_details jsonb,user_id uuid,challenge_type text,preset_id text,status text,created_at timestamptz default now(),updated_at timestamptz,reviewed_by uuid,reviewed_at timestamptz,decision_note text,trading_account_id uuid);
 create view account_progress as select id account_id,0 trading_days,0 trades_closed,0 profitable_days,0::numeric profitable_days_pct from trading_accounts;
 create table ab_trader_profiles(person_id uuid,book_state text);
 create table sl_strikes(account_id uuid,user_id uuid,trade_id uuid unique,strike_no int,stripped_profit numeric);
 create function fn_ensure_demo_account(uuid)returns uuid language sql as 'select gen_random_uuid()';
 create table infinity_restart_offers(user_id uuid primary key,old_account_id uuid,new_account_id uuid,used_at timestamptz default now(),snapshot jsonb);
 create table infinity_retired_accounts(account_id uuid primary key,reset_id text,user_id uuid,snapshot jsonb);
 create table infinity_monthly_restarts(user_id uuid,old_account_id uuid,new_account_id uuid,month date,outcome text,detail text,created_at timestamptz default now(),unique(user_id,month));
 create table email_templates(key text primary key,category text,subject text,preheader text,body_html text,body_text text,is_active boolean);
 create table email_events(user_id uuid,template_key text,to_email text,subject text,status text,provider text,payload jsonb);
 create function accept_qualification_v2(uuid)returns text language sql as 'select ''ACCEPTED:test-fixture''';
 create table payouts(id uuid primary key default gen_random_uuid(),account_id uuid,user_id uuid,status text,period_start timestamptz,period_end timestamptz,gross_profit numeric,split_pct numeric,trader_share numeric,currency text,idempotency_key text,created_by uuid,payout_method_id uuid,programme_event text,note text);
 create table payout_methods(id uuid primary key,user_id uuid);
 create function fn_infinity_breach_lockout(uuid) returns jsonb language sql as 'select ''{"locked":false}''::jsonb';
 create function infinity_reset_context(uuid)returns jsonb language sql as 'select ''{"retired_account_ids":[],"reapplication_required":false}''::jsonb';
 create function fn_claim_account_breach(uuid,text,numeric,numeric) returns boolean language plpgsql as $$begin update public.trading_accounts set status='breached',breach_reason=$2 where id=$1;return true;end$$;
 create function qualification_progress_v2(p_account uuid)returns jsonb language sql as 'select ''{"applies":true,"eligible":true}''::jsonb';
 insert into auth.users(id,email_confirmed_at) values('${uid}',now());insert into user_profiles values('${uid}',true,false);
 insert into trader_identity_private(user_id,date_of_birth) values('${uid}','1990-01-01');insert into trader_kyc values('${uid}','verified');
 insert into platform_legal_documents(version,kind,document_url) values('test-v2','terms','/legal/test-v2.html'),('privacy','privacy','/privacy.html');insert into platform_legal_current values('privacy','privacy'),('terms','test-v2');
 insert into symbol_specs(symbol,contract_size,quote_currency) values('EURUSD',100000,'USD'),('XAUUSD',100,'USD');
 insert into live_quotes values('EURUSD',1.1,1.09995,1.10005,clock_timestamp()),('XAUUSD',2000,1999.9,2000.1,clock_timestamp());
 insert into challenge_presets values('infinity_s1','Infinity 1','infinity',1,1000,4,5,2.5,'trailing_balance',.5,1,1.4,10,30,null,true,0,'infinity_s2'),
 ('infinity_s2','Infinity 2','infinity',2,5000,7,4,2,'trailing_balance',.35,null,1.25,15,60,40,true,85,'infinity_s3'),
 ('infinity_s3','Infinity 3','infinity',3,10000,8,4,2,'trailing_balance',.35,null,1.25,10,40,null,true,85,'infinity_s4'),
 ('infinity_s4','Infinity 4','infinity',4,25000,0,4,2,'trailing_balance',.25,null,null,0,0,null,true,85,null);`);
 await db.exec(sqlFile('20261029090000_infinity_v2_versions'));
 await db.exec(sqlFile('20261029091000_infinity_v2_switch'));
 await db.exec(definition('20261008132001_infinity_quote_drawdown_guard','fn_infinity_quote_equity'));
 await db.exec(definition('20261008133001_infinity_freeze_fallback','fn_enforce_infinity_from_quotes').replace("'trailing_eod'))","'trailing_eod','trailing_balance'))").replace(" if a.drawdown_mode='trailing_intraday'", " if a.drawdown_mode='trailing_balance' then peak:=greatest(peak,a.balance);end if;\n if a.drawdown_mode='trailing_intraday'"));
 await db.exec(definition('20261005140000_infinity_sl_strikes','fn_claim_account_breach'));
 await db.exec(definition('20261005140000_infinity_sl_strikes','fn_record_sl_strike'));
 await db.exec(definition('20261009070000_launch_reliability','fn_carry_infinity_strikes'));
 await db.exec(definition('20261009070000_launch_reliability','fn_sl_warning_on_close'));
 await db.exec('create trigger infinity_carry_strikes before insert on trading_accounts for each row execute function fn_carry_infinity_strikes();create trigger sl_warning_on_close after insert or update of status,close_reason on trades for each row execute function fn_sl_warning_on_close()');
 await db.exec(sqlFile('20261029100000_infinity_v2_runtime'));
 if(adapters){
  await db.exec('create table infinity_daily_entry_pauses(account_id uuid,utc_day date,observed_gain numeric,cap_usd numeric,primary key(account_id,utc_day))');
  await db.exec(definition('20261012133000_infinity_daily_entry_limit','fn_infinity_daily_entry_limit'));
  await db.exec(definition('20261012200000_infinity_cap_closes_positions','fn_infinity_cap_closes_positions'));
  await db.exec(definition('20261012210000_infinity_counted_profit','fn_infinity_counted_profit'));
  await db.exec(definition('20260930150000_infinity_min_hold_payouts','fn_infinity_quick_trade_profit'));
  await db.exec(definition('20261009070000_launch_reliability','fn_advance_infinity_stage'));
  await db.exec(sqlFile('20261029101000_infinity_v2_adapters'));
 }
 if(restart)await db.exec(sqlFile('20261029102000_infinity_v2_restart'));
 await db.exec(sqlFile('20261007180000_atomic_ipfx_closes'));
 await db.exec(sqlFile('20261029103000_infinity_v2_pending_and_partials'));
 await db.exec(sqlFile('20261029104000_infinity_v2_authority'));
 await db.exec(sqlFile('20261029104500_infinity_v2_performance_breach'));
 await db.exec(definition('20261028120000_owner_advance_infinity_stage','fn_owner_advance_infinity_stage'));
 await db.exec(sqlFile('20261029105000_infinity_v2_review'));
 await db.exec(sqlFile('20261029105500_infinity_v2_stage_recovery'));
 await db.exec(definition('20261013100000_infinity_monthly_auto_restart','fn_infinity_monthly_auto_restart'));
 await db.exec(sqlFile('20261029106000_infinity_v2_release'));
 await db.exec(definition('20261005120000_ipfx_hub','hub_snapshot'));
 await db.exec(sqlFile('20261029107000_infinity_v2_hub_deadline'));
 await db.exec(definition('20261012220000_infinity_fresh_restart_offer','fn_infinity_restart_offer'));
 await db.exec(definition('20261012220000_infinity_fresh_restart_offer','fn_infinity_take_fresh_restart'));
 await db.exec('update infinity_v2_pricing_profiles set commission_round_turn_per_lot=6 where commission_round_turn_per_lot is null');
 await db.exec("update infinity_v2_settings set integration_ready=true,terms_version='test-v2',infinity_v2_enabled=true,cutover_at=clock_timestamp()-interval '1 day' where singleton");
 const account=async({stage=1,parent=null,version='infinity_v2',created=null}={})=>{
  if(version==='infinity_v1')await db.exec('update infinity_v2_settings set infinity_v2_enabled=false where singleton');
  const v=(await db.query(`insert into trading_accounts(user_id,label,preset_id,challenge_type,stage,phase,status,starting_balance,balance,day_start_equity,day_start_date,profit_target_pct,max_drawdown_pct,daily_loss_pct,drawdown_mode,trailing_peak,min_trading_days,min_trades,max_risk_per_trade_pct,daily_profit_cap_pct,min_profitable_days_pct,require_stop_loss,profit_split_pct,funded_from_account_id,created_at)
   select $1,label,id,challenge_type,stage,'evaluation','active',starting_balance,starting_balance,starting_balance,(clock_timestamp() at time zone 'UTC')::date,profit_target_pct,max_drawdown_pct,daily_loss_pct,drawdown_mode,starting_balance,min_trading_days,min_trades,max_risk_per_trade_pct,daily_profit_cap_pct,min_profitable_days_pct,require_stop_loss,profit_split_pct,$2,coalesce($3::timestamptz,clock_timestamp()) from challenge_presets where stage=$4 returning *`,[uid,parent,created,stage])).rows[0];
  if(version==='infinity_v1')await db.exec('update infinity_v2_settings set infinity_v2_enabled=true where singleton');return v;
 };
 return {db,account};
}
