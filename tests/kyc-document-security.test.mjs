// Identity-document protection (owner security review 2026-10-08): no pre-made links, one document at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fn = read('supabase/functions/admin-console/index.ts');
const page = read('admin.html');
const alertSql = read('supabase/migrations/20261008160000_kyc_document_view_alert.sql');

test('the only place a document link is created is the on-demand action, valid for 60 seconds', () => {
  assert.equal((fn.match(/createSignedUrls?\(/g) || []).length, 1, 'exactly one link-creating call in the whole function');
  assert.match(fn, /from\("kyc-documents"\)\.createSignedUrl\(doc\.storage_path, 60\)/);
  const start = fn.indexOf('if (action === "kyc_document_url") {');
  const end = fn.indexOf('if (action === "kyc_queue") {');
  assert.ok(start > 0 && end > start, 'action exists before the queue');
  assert.ok(fn.indexOf('createSignedUrl(', 0) > start && fn.indexOf('createSignedUrl(', 0) < end, 'the call is inside kyc_document_url');
});

test('queues list documents by id only and never return a link', () => {
  const app = fn.slice(fn.indexOf('const uniqueDocuments'), fn.indexOf('if (action === "application_decide")'));
  assert.doesNotMatch(app, /\burl:|signedUrl|createSigned/, 'application queue carries no links');
  assert.match(app, /id: item\.id, doc_type: item\.doc_type, uploaded_at: item\.created_at/);
  const kyc = fn.slice(fn.indexOf('if (action === "kyc_queue")'), fn.indexOf('queueAuditError'));
  assert.doesNotMatch(kyc, /signedUrl|createSigned|\burl:/, 'KYC queue carries no links');
});

test('document access is owner-only, needs MFA, is rate limited, and is audited before the link exists', () => {
  assert.match(fn, /const ownerOnlyActions = new Set\([^)]*"kyc_queue", "kyc_document_url"/);
  assert.match(fn, /const sensitiveActions = new Set\([^)]*"kyc_queue", "kyc_document_url"/);
  const a = fn.slice(fn.indexOf('if (action === "kyc_document_url") {'), fn.indexOf('if (action === "kyc_queue") {'));
  assert.match(a, /if \(!UUID\.test\(documentId\)\)/);
  assert.doesNotMatch(a, /admin:kyc_document_hour/, "owner removed only the hourly document cap");
  assert.match(a, /allowRequest\(db, "admin:kyc_document_day", user\.id, 350, 86400\)/);
  assert.match(a, /catch \(error\)[\s\S]*Document protection unavailable", 503\)/, 'fails closed if the limiter is down');
  assert.ok(a.indexOf('logAdminStrict("kyc_document_view"') > 0 && a.indexOf('logAdminStrict("kyc_document_view"') < a.indexOf('createSignedUrl('), 'audit row written first');
  assert.match(a, /if \(!audited\) return err\("Documents are unavailable because the audit trail could not be written\."/);
  assert.match(a, /ip: clientIp/);
});

test('API responses are never cached', () => {
  assert.match(fn, /"Content-Type": "application\/json", "Cache-Control": "no-store"/);
});

test('admin page opens documents on click only, and says so', () => {
  assert.match(page, /async function openKycDoc\(documentId\)/);
  assert.match(page, /action:'kyc_document_url',document_id:documentId/);
  assert.match(page, /w\.opener=null/);
  assert.match(page, /onclick="openKycDoc\('\$\{esc\(d\.id\)\}'\)"/);
  assert.match(page, /onclick="openKycDoc\('\$\{esc\(doc\.id\)\}'\)"/);
  assert.doesNotMatch(page, /<a href="\$\{esc\((d|doc)\.url\)\}"/, 'no document anchors from pre-made urls remain');
  assert.match(page, /link lasts 60 seconds and every view is logged|link lasts 60 seconds, every view is logged/);
  assert.doesNotMatch(page, /links expire in 5 minutes|Private links expire in 5 minutes/);
});

test('the Brain warns when an unusual number of documents is opened (20+ an hour, critical at 35)', () => {
  assert.match(alertSql, /select 'security:kyc_views', case when v\.n >= 35 then 'critical' else 'warning' end, 'rules'/);
  assert.match(alertSql, /action = 'kyc_document_view' and created_at > now\(\) - interval '1 hour'/);
  assert.match(alertSql, /where v\.n >= 20/);
  assert.match(alertSql, /create index if not exists admin_audit_action_time on public\.admin_audit_log \(action, created_at desc\)/);
  assert.match(alertSql, /select 'ring:' \|\| f\.id/, 'the hedge-ring block is preserved');
  assert.match(alertSql, /'system:hub'/, 'older alert blocks are preserved');
});

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
test('both alert migrations load in order on a real PostgreSQL engine', { skip: !process.env.DEMO_TEST_DEPS }, async () => {
  const { PGlite } = await import(pathToFileURL(process.env.DEMO_TEST_DEPS + '/node_modules/@electric-sql/pglite/dist/index.js').href);
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema cron; create table cron.job(jobid bigint generated always as identity, jobname text);
      create function cron.unschedule(bigint) returns boolean language sql as 'select true';
      create function cron.schedule(text,text,text) returns bigint language sql as 'select 1::bigint';
      create table trading_accounts(id uuid primary key default gen_random_uuid(), user_id uuid not null, status text, phase text);
      create table trades(id uuid primary key default gen_random_uuid(), account_id uuid, symbol text, side text, volume numeric, pnl numeric, status text, opened_at timestamptz);
      create table ab_heartbeats(worker text primary key, ok boolean, at timestamptz, detail jsonb);
      create function ab_person_of(u uuid) returns uuid language sql as 'select u';
      create table trader_identity_private(user_id uuid primary key, legal_first_name text, legal_last_name text, date_of_birth date, phone_e164 text, address_line_1 text, postal_code text, country_code text);
      create table admin_audit_log(id bigint generated always as identity primary key, actor_id uuid, action text, created_at timestamptz not null default now());`);
    await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261008150000_ab_hedge_ring_detection.sql', import.meta.url), 'utf8'));
    await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261008160000_kyc_document_view_alert.sql', import.meta.url), 'utf8'));
    const idx = (await db.query(`select count(*)::int c from pg_indexes where indexname = 'admin_audit_action_time'`)).rows[0].c;
    assert.equal(idx, 1);
    const def = (await db.query(`select pg_get_functiondef('public.ab_alerts_scan()'::regprocedure) d`)).rows[0].d;
    assert.match(def, /security:kyc_views/);
    assert.match(def, /'ring:' \|\| f\.id/);
  } finally { await db.close(); }
});

test('identity details are masked by the server; the full details need an audited, rate-limited click', () => {
  // the queues return only a hint
  assert.match(fn, /identity: maskIdentity\(identityByUser\.get\(row\.user_id\)\),/);
  assert.match(fn, /identity: maskIdentity\(identity \? \{ \.\.\.identity, user_id: row\.user_id \} : null\), documents: files,/);
  const mask = fn.slice(fn.indexOf('function maskIdentity'), fn.indexOf('function maskIdentity') + 900);
  assert.match(mask, /age: Number\.isFinite\(born\)/);
  assert.match(mask, /phone_hint: phone\.length >= 4/);
  assert.doesNotMatch(mask.slice(mask.indexOf('return {')), /date_of_birth|phone_e164|address_line|postal_code/, 'the masked object carries no raw DOB, phone or street address');
  // the reveal action
  const r = fn.slice(fn.indexOf('if (action === "kyc_identity_reveal") {'), fn.indexOf('if (action === "kyc_document_url") {'));
  assert.match(fn, /const ownerOnlyActions = new Set\([^)]*"kyc_identity_reveal"/);
  assert.match(fn, /const sensitiveActions = new Set\([^)]*"kyc_identity_reveal"/);
  assert.match(r, /allowRequest\(db, "admin:kyc_identity_hour", user\.id, 60, 3600\)/);
  assert.match(r, /allowRequest\(db, "admin:kyc_identity_day", user\.id, 300, 86400\)/);
  assert.match(r, /Identity protection unavailable", 503/);
  assert.ok(r.indexOf('logAdminStrict("kyc_identity_reveal"') > 0 && r.indexOf('logAdminStrict("kyc_identity_reveal"') < r.indexOf('return json({ ok: true, identity })'), 'audit first, details second');
  assert.match(r, /if \(!UUID\.test\(targetId\)\)/);
  // the page
  assert.match(page, /function identityCell\(i,userId\)/);
  assert.match(page, /action:'kyc_identity_reveal',user_id:userId/);
  assert.match(page, /hides in 60 seconds/);
  assert.match(page, /setTimeout\(\(\)=>\{const e=document\.getElementById\('idc_'\+userId\)/);
  assert.match(page, /60000\);/, 'the details hide again after 60 seconds');
  assert.doesNotMatch(page, /k\.identity\.date_of_birth|k\.identity\.phone_e164|esc\(i\.date_of_birth\|\|'/, 'the queues no longer print raw DOB or phone');
});
