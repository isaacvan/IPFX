import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {pathToFileURL}from 'node:url';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const baseline=JSON.parse(read('tests/fixtures/kyc-submission-baseline.json'));
const helperContext={window:{},setTimeout:fn=>{fn()},Promise,Date,Error,String,Object};vm.createContext(helperContext);vm.runInContext(read('assets/js/verification-upload.js'),helperContext);const helper=helperContext.window.IPFXVerification;
test('non-expiring national ID has an explicit option; other IDs still require dates',()=>{
 assert.equal(helper.expiryProblem('national_id',true,''),null);
 assert.ok(helper.expiryProblem('passport',true,''));assert.ok(helper.expiryProblem('driving_licence',true,''));assert.ok(helper.expiryProblem('national_id',true,'2099-01-01'));
 assert.equal(helper.expiryProblem('passport',false,'2099-01-01'),null);assert.ok(helper.expiryProblem('passport',false,''));assert.ok(helper.expiryProblem('passport',false,'2000-01-01'));
 assert.match(read('start-challenge.html'),/id="idHasNoExpiry"/);assert.match(read('assets/js/checkout-flow.js'),/id_has_no_expiry: \$\('idHasNoExpiry'\)\.checked/);
});
test('the actual checkbox removes date validation only for national IDs and resets when the document type changes',()=>{
 const flow=read('assets/js/checkout-flow.js'),start=flow.indexOf('  function syncIdExpiry()'),end=flow.indexOf("  $('idDocumentType').addEventListener",start);
 const elements={idDocumentType:{value:'national_id'},idHasNoExpiry:{checked:true},idNoExpiryOption:{hidden:true},idExpiry:{value:'2099-01-01',disabled:false,required:true},idExpiryRequired:{hidden:false}};
 const context={$:id=>elements[id]};vm.createContext(context);vm.runInContext(flow.slice(start,end)+'\nglobalThis.sync=syncIdExpiry;',context);context.sync();
 assert.equal(elements.idNoExpiryOption.hidden,false);assert.equal(elements.idExpiry.disabled,true);assert.equal(elements.idExpiry.required,false);assert.equal(elements.idExpiry.value,'');
 elements.idDocumentType.value='passport';context.sync();assert.equal(elements.idHasNoExpiry.checked,false);assert.equal(elements.idNoExpiryOption.hidden,true);assert.equal(elements.idExpiry.disabled,false);assert.equal(elements.idExpiry.required,true);
 const html=read('start-challenge.html');assert.ok(html.indexOf('/assets/js/verification-upload.js')<html.indexOf('(async function challengeLaunchGate'), 'helper loads before asynchronous form startup');
});
test('transient KYC failures retry the same object list; permanent failures stay rejected',async()=>{
 const documents=[{doc_type:'id_front',path:'synthetic-only/not-a-real-file'}],calls=[];
 const db={rpc:async(_,params)=>{calls.push(params.p_documents);return calls.length===1?{error:{message:'Failed to fetch'}}:{data:'pending',error:null}}};
 assert.equal(await helper.submit(db,documents),'pending');assert.equal(calls.length,2);assert.ok(calls.every(x=>x===documents));
 let permanent=0;await assert.rejects(helper.submit({rpc:async()=>{permanent++;return {error:{code:'42501',message:'KYC_BAD_PATH'}}}},documents),/do not match/);assert.equal(permanent,1);
 await assert.rejects(helper.submit({rpc:async()=>({data:null,error:null})},documents),/not confirmed/);
 assert.match(helper.failure({code:'28000',message:'NOT_SIGNED_IN'}),/session has expired/);
});
test('actual form upload retries reuse private objects and preserve a successfully uploaded front if the back fails',async()=>{
 const flow=read('assets/js/checkout-flow.js'),start=flow.indexOf('  async function uploadVerificationDocuments'),end=flow.indexOf('  // International dialling',start);
 const front={size:10,type:'application/pdf'},back={size:10,type:'application/pdf'},elements={idFront:{files:[front]},idBack:{files:[back]}};
 const uploads=[],submissions=[];let backFails=true,submitFails=true;
 const context={window:{IPFXVerification:{submit:async(_,docs)=>{submissions.push(docs);if(submitFails)throw Error('Synthetic submission failure');return'pending'}}},$:(id)=>elements[id],crypto:{randomUUID:(()=>{let i=0;return()=>String(++i)})()},Map,Set,Error,String,Date,
 db:{storage:{from:()=>({upload:async(path,file)=>{uploads.push({path,file});if(file===back&&backFails)return {error:{message:'Synthetic upload outage'}};return {error:null}}})}}};
 const initial=flow.slice(flow.indexOf('  const allowedDocumentTypes'),start);
 vm.createContext(context);vm.runInContext('let existingKyc=false;const uploadedFiles=new Map();\n'+initial+flow.slice(start,end)+'\nglobalThis.upload=uploadVerificationDocuments;',context);
 const user={id:'synthetic-user'};
 await assert.rejects(context.upload(user),/Could not securely upload/);backFails=false;
 await assert.rejects(context.upload(user),/Synthetic submission failure/);submitFails=false;await context.upload(user);
 assert.equal(uploads.filter(x=>x.file===front).length,1);assert.equal(uploads.filter(x=>x.file===back).length,2);
 assert.equal(uploads.filter(x=>x.file===back)[0].path,uploads.filter(x=>x.file===back)[1].path);
 assert.equal(submissions[0][0].path,submissions[1][0].path);assert.equal(submissions[0][1].path,submissions[1][1].path);
 await context.upload(user);assert.equal(submissions.length,2,'successful receipt prevents resubmission');
});
test('actual deployed application gates accept declared non-expiring national ID without auto-approval',async()=>{
 const {PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js'));const db=new PGlite();
 const user='11111111-1111-4111-8111-111111111111',path=user+'/synthetic.pdf';
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema storage;
  create function auth.uid()returns uuid language sql as $$select '${user}'::uuid$$;
  create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);insert into auth.users values('${user}','synthetic@example.invalid',now());
  create table storage.objects(bucket_id text,name text);insert into storage.objects values('kyc-documents','${path}');
  create table public.trader_kyc(user_id uuid primary key,status text,note text,updated_at timestamptz);
  create table public.kyc_submissions(id uuid default gen_random_uuid(),user_id uuid,doc_type text not null,storage_path text not null);
  create table public.challenge_enrolment_requests(id uuid primary key default gen_random_uuid(),user_id uuid,challenge_type text,preset_id text,status text default 'pending',application_details jsonb,updated_at timestamptz default now());
  create table public.challenge_presets(id text,challenge_type text,stage integer,label text);insert into challenge_presets values('infinity_s1','infinity',1,'Synthetic Infinity');
  create table public.infinity_reset_users(user_id uuid,reset_id text);create table public.infinity_reset_batches(id text,reset_at timestamptz);
  create table public.trader_identity_private(user_id uuid,updated_at timestamptz);insert into trader_identity_private values('${user}',now());
  create table public.admins(user_id uuid);create table public.user_profiles(user_id uuid,restricted_jurisdiction boolean);
  create table public.security_events(user_id uuid,event_type text,created_at timestamptz);
  create table public.acceptance_checks(details jsonb);
  create function public.legal_acceptance_record(jsonb,jsonb)returns void language sql as $$insert into public.acceptance_checks values($1)$$;`);
  await db.exec(baseline.submit_kyc);await db.exec(baseline.submit_application);await db.exec(read('supabase/migrations/20261009184531_id_submission_recovery.sql'));
  const docs=[{doc_type:'id_front',path}];assert.equal((await db.query('select submit_kyc($1)r',[docs])).rows[0].r,'pending');
  await db.query('select submit_kyc($1)',[docs]);await db.query('select submit_kyc($1)',[[{doc_type:'id_front',storage_path:path}]]);assert.equal((await db.query('select count(*)::int n from kyc_submissions')).rows[0].n,1);
  await assert.rejects(db.query('select submit_kyc($1)',[[{doc_type:'id_front',path:'other-user/file.pdf'}]]),/KYC_BAD_PATH/);
  await assert.rejects(db.query('select submit_kyc($1)',[[{doc_type:'id_front',path:user+'/missing.pdf'}]]),/KYC_FILE_MISSING/);
  await assert.rejects(db.query('select submit_kyc($1)',[[{doc_type:'id_back',path}]]),/KYC_PHOTO_ID_REQUIRED/);
  await assert.rejects(db.query('select submit_kyc($1)',[[{path}]]),/KYC_BAD_TYPE/);
  const details={age_confirmed:true,terms_accepted:true,cancellation_waiver:true,own_behalf_confirmed:true,information_accurate:true,risk_disclosure_accepted:true,screening_acknowledged:true,held_earnings_acknowledged:true,employment_status:'student',occupation:'Synthetic tester',source_of_funds:'savings',expected_activity:'casual',purpose:'skill_development',pep_status:'no',id_document_type:'national_id',id_issuing_country:'BD',id_has_no_expiry:true,id_expiry_date:null};
  const apply=async extra=>(await db.query("select submit_challenge_application('infinity',$1,'infinity_s1')r",[{...details,...extra}])).rows[0].r;
  const submitted=await apply({});assert.equal(submitted.status,'pending');assert.equal(submitted.application_details.id_has_no_expiry,true);assert.equal(submitted.application_details.id_expiry_date,null);
  const repeat=await apply({});assert.equal(repeat.id,submitted.id);
  assert.equal((await db.query('select count(*)::int n from acceptance_checks')).rows[0].n,2);
  for(const extra of [{id_document_type:'passport'},{id_document_type:'driving_licence'},{id_expiry_date:'2099-01-01'},{id_has_no_expiry:false,id_expiry_date:null},{id_has_no_expiry:false,id_expiry_date:'2000-01-01'},{id_has_no_expiry:'true',id_expiry_date:null},{id_has_no_expiry:false,id_expiry_date:'infinity'}])await assert.rejects(apply(extra),/DOCUMENT_DATES_INVALID|NON_EXPIRING_ID_INVALID/);
  assert.equal((await apply({id_has_no_expiry:false,id_expiry_date:'2099-01-01',id_document_type:'passport'})).status,'pending');
  const before=(await db.query('select count(*)::int n from acceptance_checks')).rows[0].n;await assert.rejects(apply({held_earnings_acknowledged:false}),/HELD_EARNINGS_ACK/);assert.equal((await db.query('select count(*)::int n from acceptance_checks')).rows[0].n,before);
  await db.exec("update trader_kyc set status='verified'");assert.equal((await db.query('select submit_kyc($1)r',[docs])).rows[0].r,'verified');
  assert.equal((await db.query("select has_function_privilege('anon','submit_kyc(jsonb)','execute')allowed")).rows[0].allowed,false);
 }finally{await db.close()}
});
