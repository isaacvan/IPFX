// Self-service account deletion: real SQL in PGlite (needs DEMO_TEST_DEPS), plus static checks of the function and pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const skip = !process.env.DEMO_TEST_DEPS;
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const U = '22222222-2222-4222-8222-222222222222', OWNER = '11111111-1111-4111-8111-111111111111';

async function db0() {
  const { PGlite } = await import(pathToFileURL(process.env.DEMO_TEST_DEPS + '/node_modules/@electric-sql/pglite/dist/index.js').href);
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
   create table auth.users(id uuid primary key,email text,phone text,raw_user_meta_data jsonb,raw_app_meta_data jsonb,encrypted_password text,banned_until timestamptz,deleted_at timestamptz,updated_at timestamptz,
     confirmation_token text,recovery_token text,email_change text,email_change_token_new text,email_change_token_current text,phone_change text,phone_change_token text,reauthentication_token text);
   create table auth.identities(user_id uuid,identity_data jsonb);create table auth.sessions(user_id uuid);create table auth.mfa_factors(user_id uuid);create table auth.one_time_tokens(user_id uuid);
   create table trading_accounts(id uuid primary key default gen_random_uuid(),user_id uuid,status text,access_revoked_at timestamptz,access_revoked_reason text,mirror_enabled boolean,updated_at timestamptz,investigation_hold boolean default false);
   create table trades(id uuid primary key default gen_random_uuid(),account_id uuid,status text,pnl numeric);
   create table pending_orders(account_id uuid,status text);
   create table payouts(user_id uuid,status text);
   create table admin_audit_log(actor_id uuid not null,action text,target_user_id uuid,detail jsonb);
   create table email_events(user_id uuid,to_email text,template_key text);
   create table user_profiles(user_id uuid,full_name text);
   create table trader_identity_private(user_id uuid,legal_first_name text);
   create table security_events(user_id uuid,ip_address text);
   create table order_audit_events(user_id uuid,client_ip text);
   create table ab_alerts(key text unique,title text,person_id uuid);
   create table email_templates(key text primary key,category text,subject text,preheader text,body_html text,body_text text,is_active boolean);
   insert into auth.users(id,email,raw_user_meta_data) values('${U}','trader@example.invalid','{"full_name":"Test Trader"}'),('${OWNER}','owner@example.invalid','{}');
   insert into auth.identities values('${U}','{"email":"trader@example.invalid"}');insert into auth.sessions values('${U}');
   insert into trading_accounts(id,user_id,status) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','${U}','active'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','${U}','breached');
   insert into user_profiles values('${U}','Test Trader');insert into trader_identity_private values('${U}','Test');
   insert into security_events values('${U}','203.0.113.9');insert into order_audit_events values('${U}','203.0.113.9');
   insert into email_events values('${U}','trader@example.invalid','x');insert into ab_alerts values('k','Test Trader copied',null);`);
  await db.exec(read('supabase/migrations/20261127150000_account_deletion.sql'));
  return db;
}
const q = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];

test('a request stops trading, a cancel restores only what it stopped, and open trades block it', { skip }, async () => {
  const db = await db0();
  try {
    await db.query(`insert into trades(account_id,status) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','open')`);
    await assert.rejects(db.query('select public.fn_request_account_deletion($1)', [U]), /CLOSE_OPEN_POSITIONS_FIRST/);
    await db.exec(`update trades set status='closed'`);
    const r = (await q(db, 'select public.fn_request_account_deletion($1) r', [U])).r;
    assert.equal(r.ok, true); assert.match(r.cancel_token, /^[0-9a-f]{64}$/);
    assert.equal((await q(db, `select access_revoked_reason from trading_accounts where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`)).access_revoked_reason, 'account_deletion_requested');
    assert.equal((await q(db, `select access_revoked_reason x from trading_accounts where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'`)).x, null, 'breached account untouched');
    assert.equal((await q(db, 'select public.fn_request_account_deletion($1) r', [U])).r.already_requested, true);
    await q(db, 'select public.fn_cancel_account_deletion($1)', [r.cancel_token]);
    assert.equal((await q(db, `select access_revoked_at from trading_accounts where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`)).access_revoked_at, null);
    assert.equal((await q(db, 'select status from account_deletion_requests')).status, 'cancelled');
  } finally { await db.close(); }
});

test('erase removes personal data and names; the scrub leaves only an anonymous sign-in record', { skip }, async () => {
  const db = await db0();
  try {
    const e = (await q(db, 'select public.fn_gdpr_erase_user($1,$2) r', [U, U])).r;
    assert.equal(e.email, 'trader@example.invalid');
    for (const t of ['user_profiles', 'trader_identity_private', 'security_events', 'email_events']) assert.equal(Number((await q(db, `select count(*) n from ${t}`)).n), 0, t);
    assert.equal((await q(db, 'select client_ip from order_audit_events')).client_ip, null);
    assert.equal((await q(db, 'select title from ab_alerts')).title, 'Deleted trader copied');
    assert.equal((await q(db, `select status from trading_accounts where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`)).status, 'closed');
    assert.equal(Number((await q(db, 'select count(*) n from auth.sessions')).n), 0);
    await q(db, 'select public.fn_gdpr_scrub_auth($1,$2)', [U, U]);
    const u = await q(db, 'select email,raw_user_meta_data m,banned_until from auth.users where id=$1', [U]);
    assert.match(u.email, /^deleted-22222222@deleted\.invalid$/); assert.deepEqual(u.m, {}); assert.ok(u.banned_until);
    assert.equal(Number((await q(db, 'select count(*) n from auth.identities')).n), 0);
    assert.equal(Number((await q(db, `select count(*) n from admin_audit_log where action like 'gdpr_erasure%'`)).n), 2);
  } finally { await db.close(); }
});

test('function and pages: DELETE confirmation, cancel link, 7 days, storage first, email before scrub, no partner name', () => {
  const fn = read('supabase/functions/account-deletion/index.ts');
  assert.match(fn, /String\(body\.confirm \?\? ""\)\.trim\(\)\.toUpperCase\(\) !== "DELETE"/);
  assert.match(fn, /delete-account\.html\?cancel=\$\{data\.cancel_token\}/);
  assert.ok(fn.indexOf('storage.from("kyc-documents").remove') < fn.indexOf('fn_gdpr_erase_user'), 'documents go first');
  assert.ok(fn.indexOf('"data_erasure_confirmation"') < fn.indexOf('fn_gdpr_scrub_auth'), 'confirmation is sent before the email address is scrubbed');
  assert.match(fn, /req\.headers\.get\("x-cron-secret"\) !== env\.CRON_SECRET/);
  const sql = read('supabase/migrations/20261127150000_account_deletion.sql');
  assert.match(sql, /erase_after timestamptz not null default now\(\) \+ interval '7 days'/);
  const dash = read('dashboard.html'); const page = read('delete-account.html');
  assert.match(dash, /id="deleteAccountBtn"/); assert.match(dash, /functions\/v1\/account-deletion/);
  assert.match(page, /action: 'cancel', token: token/);
  for (const t of [fn, page, dash.slice(dash.indexOf('delAcctModal') - 200, dash.indexOf('delAcctModal') + 2500)]) assert.doesNotMatch(t, /\bE8\b/);
});
