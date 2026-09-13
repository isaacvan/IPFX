// Isolated PostgreSQL WASM test. No credentials, network, production data or persisted DB.
// Pass the installed @electric-sql/pglite package directory as the first argument.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const packageDir=process.argv[2];
if(!packageDir) throw new Error('Pass the local @electric-sql/pglite package directory');
const { PGlite }=await import(pathToFileURL(resolve(packageDir,'dist/index.js')).href);
const db=new PGlite();
let checks=0;
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create table public.trading_accounts(id uuid primary key,user_id uuid references auth.users(id),challenge_type text,status text,created_at timestamptz default now());
    create table public.trades(id uuid primary key);
    create table public.a_book_rule_snapshots(id uuid primary key,trading_account_id uuid references public.trading_accounts(id),effective_at timestamptz);
    create function public.fn_is_admin() returns boolean language sql stable as $$select coalesce(current_setting('test.is_admin',true),'false')='true'$$;
    grant usage on schema public to authenticated,anon,service_role;`);
  for(const file of ['20260912120000_challenge_specific_trader_detector.sql','20260913090000_trader_detector_hardening.sql']) {
    await db.exec(await readFile(resolve('supabase/migrations',file),'utf8'));
    console.log('Migration executed: '+file); checks++;
  }
  const uid='00000000-0000-4000-8000-000000000001', aid='00000000-0000-4000-8000-000000000002';
  await db.query('insert into auth.users values($1)',[uid]);
  await db.query("insert into trading_accounts(id,user_id,challenge_type,status) values($1,$2,'traditional','active')",[aid,uid]);
  const policy=(await db.query("select id from trader_detector_policy_versions where challenge_type='traditional' and version=2")).rows[0].id;
  const stamp=new Date(Date.now()-10000).toISOString();
  const lease=(await db.query('select trader_detector_claim_scan() result')).rows[0].result;
  assert.ok(lease.lease_token);checks++;
  assert.equal((await db.query('select trader_detector_claim_scan() result')).rows[0].result,null);checks++;
  await db.query('select trader_detector_finish_scan($1,$2)',[lease.lease_token,aid]);
  const resumed=(await db.query('select trader_detector_claim_scan() result')).rows[0].result;
  assert.equal(resumed.after_account_id,aid);checks++;
  await assert.rejects(db.query('select trader_detector_finish_scan($1,$2)',[lease.lease_token,null]),/SCAN_LEASE_LOST/);checks++;
  await db.query('select trader_detector_finish_scan($1,$2)',[resumed.lease_token,null]);
  const record={trading_account_id:aid,user_id:uid,policy_id:policy,as_of_at:stamp,source_cutoff_at:stamp,state:'HIGH_POTENTIAL',
    probability_status:'DESCRIPTIVE_UNCALIBRATED',probability_edge_positive:0.9,independent_idea_count:30,effective_sample_size:20,
    active_trading_days:20,data_quality:1,metrics:{},gates:[],reasons:[],evidence_sha256:'a'.repeat(64),input_sha256:'b'.repeat(64),live_enabled:false};
  const commit=async (r,expected=null)=>(await db.query('select trader_detector_commit_assessment($1::jsonb,$2::uuid) result',[JSON.stringify(r),expected])).rows[0].result;
  const first=await commit(record);assert.equal(first.inserted,true);assert.equal(first.alerts_queued,1);checks++;
  assert.equal((await commit(record)).inserted,false);checks++;
  await assert.rejects(commit({...record,evidence_sha256:'c'.repeat(64)}),/STALE_DETECTOR_STATE/);checks++;
  await assert.rejects(commit({...record,evidence_sha256:'c'.repeat(64),state:'PROFITABILITY_CONFIRMED'},first.assessment_id),/VALIDATED_FORECAST/);checks++;
  await assert.rejects(db.query('update trader_detector_assessments set reasons=$1::jsonb where id=$2',[JSON.stringify(['changed']),first.assessment_id]),/IMMUTABLE/);checks++;
  await db.query('select trader_detector_record_failure($1,$2,$3)',[aid,new Date(Date.now()-5000).toISOString(),'missing input']);
  assert.equal((await db.query('select data_status from trader_detector_states')).rows[0].data_status,'ERROR');checks++;
  const now=new Date().toISOString(); await commit({...record,as_of_at:now});
  assert.equal((await db.query('select data_status from trader_detector_states')).rows[0].data_status,'OK');checks++;
  await db.exec("set role authenticated; set test.is_admin='false';");
  assert.equal((await db.query('select * from trader_detector_assessments')).rows.length,0);checks++;
  await db.exec("set test.is_admin='true';");
  assert.equal((await db.query('select * from trader_detector_assessments')).rows.length,1);checks++;
  await assert.rejects(commit(record),/permission denied/);checks++;
  await db.exec('reset role; set role service_role;');
  await assert.rejects(db.query("update trader_detector_states set state='LIVE_REVIEW_REQUIRED'"),/permission denied/);checks++;
  await db.exec('reset role;');
  // Positive calibrated path, followed by altered-input and missing-copy attacks.
  const cut='2025-01-01T00:00:00Z';
  await db.query("update trader_detector_policy_versions set status='VALIDATED',model_sha256=$1,training_cutoff_at=$2,validation_reference='isolated synthetic test' where id=$3",['d'.repeat(64),cut,policy]);
  const cal=(await db.query(`insert into trader_detector_calibrations(policy_id,model_sha256,outcome_definition,horizon_days,training_cutoff_at,
    validation_start_at,validation_end_at,sample_count,metrics,evidence_sha256,validation_reference,trader_holdout_verified,prospective_verified,
    approved_by,approved_at,expires_at) values($1,$2,'Synthetic positive future net outcome over thirty days',30,$3,
    '2025-02-01','2025-04-01',100,'{}',$4,'synthetic test',true,true,$5,'2025-05-01','2099-01-01') returning id`,
    [policy,'d'.repeat(64),cut,'e'.repeat(64),uid])).rows[0].id;
  const forecast=(await db.query(`insert into trader_detector_forecasts(calibration_id,trading_account_id,policy_id,input_sha256,source_cutoff_at,predicted_at,expires_at,probability)
    values($1,$2,$3,$4,$5,$5,'2099-01-01',0.97) returning id`,[cal,aid,policy,record.input_sha256,stamp])).rows[0].id;
  const rule=(await db.query('insert into a_book_rule_snapshots values(gen_random_uuid(),$1,$2) returning id',[aid,stamp])).rows[0].id;
  const risk=(await db.query(`insert into trader_detector_risk_reviews(trading_account_id,policy_id,input_sha256,source_cutoff_at,as_of_at,expires_at,
    reconciled,complete_history,open_positions_marked,cash_flows_reconciled,rule_breach,equity,daily_floor,total_floor,stressed_open_loss,
    rule_snapshot_id,evidence_reference,audit_sha256,verified_by) values($1,$2,$3,$4,$4,'2099-01-01',true,true,true,true,false,1000,950,900,10,$5,'synthetic',$6,$7) returning id`,
    [aid,policy,record.input_sha256,stamp,rule,'f'.repeat(64),uid])).rows[0].id;
  const gates=['accounting_basis','mark_to_market_risk','rule_snapshot','trade_stage_provenance','no_critical_risk','validation_evidence','data_quality',
    'confirmed_effective_evidence','confirmed_days','challenge_stage','positive_stages','regime_coverage','concentration','stability','tail_risk','pac_validation','calibration'];
  const confirmed={...record,as_of_at:new Date().toISOString(),state:'PROFITABILITY_CONFIRMED',evidence_sha256:'1'.repeat(64),forecast_id:forecast,risk_review_id:risk,
    gates:gates.map(key=>({key,status:'PASS'}))};
  const second=await commit(confirmed,first.assessment_id);assert.equal(second.inserted,true);checks++;
  assert.equal((await db.query('select calibrated_future_probability from trader_detector_assessments where id=$1',[second.assessment_id])).rows[0].calibrated_future_probability,'0.9700000000');checks++;
  await assert.rejects(commit({...confirmed,evidence_sha256:'2'.repeat(64),input_sha256:'3'.repeat(64)},second.assessment_id),/FORECAST_EVIDENCE_BINDING/);checks++;
  await assert.rejects(commit({...confirmed,evidence_sha256:'2'.repeat(64),state:'LIVE_REVIEW_REQUIRED'},second.assessment_id),/MATCHED_COPY/);checks++;
  await assert.rejects(commit({...confirmed,evidence_sha256:'2'.repeat(64),gates:[]},second.assessment_id),/CONFIRMATION_GATE/);checks++;
  const third=await commit({...record,as_of_at:new Date().toISOString(),evidence_sha256:'4'.repeat(64)},second.assessment_id);
  assert.equal((await db.query('select alert_type from trader_detector_alerts where assessment_id=$1',[third.assessment_id])).rows[0].alert_type,'RISK_DETERIORATION');checks++;
  console.log(`PASS: ${checks} isolated database checks. PostgreSQL runtime: ${(await db.query('select version() v')).rows[0].v}`);
} finally {await db.close();}
