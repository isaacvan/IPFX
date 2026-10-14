import fs from'node:fs';import{pathToFileURL}from'node:url';
export const owner='11111111-1111-4111-8111-111111111111',person='22222222-2222-4222-8222-222222222222',source='33333333-3333-4333-8333-333333333333';
export const tradeId=i=>`44444444-4444-4444-8444-${String(i).padStart(12,'0')}`;
const read=name=>fs.readFileSync(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');
export async function ongoingDb(){
 const{PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js').href),db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table admins(user_id uuid);insert into admins values('${owner}');create table auth.users(id uuid,email text);insert into auth.users values('${person}','fixture@example.invalid');
 create table user_profiles(user_id uuid,full_name text);insert into user_profiles values('${person}','Synthetic Trader');
 create function ab_person_of(uuid)returns uuid language sql as 'select $1';
 create table trading_accounts(id uuid primary key,user_id uuid,challenge_type text,status text,venue text,phase text,label text,stage int);
 insert into trading_accounts values('${source}','${person}','infinity','active','ipfx','challenge','Synthetic Infinity',1);
 create table ladder_accounts(id bigint primary key,label text default 'Synthetic E8',role text,execution_enabled boolean,status text,api_env text,account_id text,server text,size_usd numeric,instrument_map jsonb,copy_test_only boolean default false,access_token_ciphertext text,refresh_token_ciphertext text,signal_group int default 0,
 check(role<>'monitor'or not execution_enabled));
 insert into ladder_accounts(id,role,execution_enabled,status,api_env,account_id,server,size_usd,instrument_map,access_token_ciphertext,refresh_token_ciphertext)values(3,'monitor',false,'evaluation','demo','300','Synthetic Broker',50000,'[]','SYNTHETIC_ONLY','SYNTHETIC_ONLY');
 create table ab_trader_profiles(person_id uuid primary key,book_state text,state_since timestamptz default now(),state_reason text,policy_version int,last_ab_exit_at timestamptz,manual_book_state text,manual_by uuid,manual_since timestamptz,manual_reason text,updated_at timestamptz);
 create table ab_person_signals(person_id uuid,investigation_hold boolean,critical_flag boolean);insert into ab_person_signals values('${person}',false,false);
 create table ab_settings(singleton boolean,book_halt boolean);insert into ab_settings values(true,false);
 create table platform_config(trading_halted boolean);insert into platform_config values(false);
 create table ladder_settings(signal_groups int);insert into ladder_settings values(1);
 create table ab_policy_versions(version int,status text,thresholds jsonb);insert into ab_policy_versions values(4,'ACTIVE','{"stage2AutoPct":2.75,"stage2AutoTarget":"AB_LIVE"}');
 create table ab_lifecycle_events(person_id uuid,from_state text,to_state text,reason text,evidence jsonb,policy_version int,actor text);
 create table admin_audit_log(actor_id uuid,action text,detail jsonb);
 create table book_capacity_limits(book text,position_limit int,margin_per_lot_usd numeric,provider_evidence text);insert into book_capacity_limits values('l3',200,500,'Synthetic documented limits');
 create table team_book_destinations(book text,status text,environment text,account_id text);
 create table copy_test_sessions(person_id uuid,destination_id bigint,state text);
 create table trades(id uuid primary key,account_id uuid,user_id uuid,symbol text,side text,parent_trade_id uuid,external_source text,status text,opened_at timestamptz,volume numeric,sl numeric);
 create table book_orders(id bigint generated always as identity,source_trade_id uuid,event text,book text,person_id uuid,symbol text,status text,qty numeric,side text,fill_price numeric,pnl_usd numeric,broker_order_id text,broker_position_id text,dispatch_state text,broker_confirmed_qty numeric,latency_ms int,created_at timestamptz default now(),error text);
 create table ab_risk_limits(book text,per_trade_max_pct numeric,account_size_usd numeric,symbol_net_lots_max numeric,room_multiple numeric,min_fill_fraction numeric,crowd_max int,per_trade_max_usd numeric,open_risk_max_usd numeric,per_trader_open_max_usd numeric,daily_loss_stop_usd numeric,daily_profit_cap_usd numeric);
 insert into ab_risk_limits values('a',.5,50000,10,1,.5,5,250,1250,500,1000,1000);
 create table ab_risk_reservations(id bigint generated always as identity,book text,source_trade_id uuid,person_id uuid,symbol text,signed_lots numeric,risk_usd numeric,status text default 'active',created_at timestamptz default now(),released_at timestamptz);
 create table book_daily_pnl(book text,day date,pnl_usd numeric);
 create function e8_sim_capture()returns trigger language plpgsql as $$declare state text;a trading_accounts;begin state:=coalesce(state,'BB_DEMO');return new;end $$;`);
 const controls=read('20261008090000_owner_model_controls.sql');
 for(const name of['ab_model_signal_group','ab_model_capabilities','ab_apply_transition','ab_owner_set_model','ab_owner_enroll_model']){
  const re=new RegExp('create (?:or replace )?function public\\.'+name+'\\([\\s\\S]*?\\$\\$;','i'),sql=controls.match(re)?.[0];if(!sql)throw Error(name);await db.exec(sql);
 }
 const risk=read('20261011043000_ab_risk_missing_config_guard.sql');await db.exec(risk.slice(risk.indexOf('CREATE OR REPLACE FUNCTION'),risk.lastIndexOf(';')+1));
 await db.exec(read('20261013193000_ongoing_owner_copy.sql'));
 await db.exec(read('20261014001500_ongoing_single_account_jwt.sql'));
 await db.exec(read('20261014010000_one_action_live_selection.sql'));
 const q=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
 const connect=()=>q(`select ongoing_copy_connect(3,.01,10,'${owner}',true,'Synthetic owner permission')r`);
 const select=()=>q(`select ongoing_copy_select(1,'${person}',true,'${owner}','Synthetic chosen trader')r`);
 const control=async(action,version=null,developer=true)=>q(`select ongoing_copy_control(1,$1,$2,'${owner}',$3,true)r`,[action,version??(await q("select version from ongoing_copy_connections where id=1")).version,developer]);
 const add=i=>db.query(`insert into trades values($1,'${source}','${person}','XAUUSD','buy',null,null,'open',clock_timestamp(),.01,3999)`,[tradeId(i)]);
 const claim=i=>q('select ongoing_copy_claim($1)r',[tradeId(i)]);
 return{db,q,connect,select,control,add,claim};
 }catch(e){await db.close();throw Error(e.message);}
}
