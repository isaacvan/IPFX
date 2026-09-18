import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const migration = read('supabase/migrations/20260918203000_manual_challenge_approval_gate.sql');
const admin = read('supabase/functions/admin-console/index.ts');
const engine = read('supabase/functions/trading-engine/index.ts');
const checkout = read('assets/js/checkout-flow.js');
const dashboard = read('dashboard.html');
const adminPage = read('admin.html');

test('every challenge family is application-gated against an exact preset', () => {
  assert.match(migration, /challenge_type in \('infinity','traditional','futures','pac'\)/i);
  assert.match(migration, /unique index if not exists challenge_enrolment_user_preset_uidx/i);
  assert.match(migration, /preset_id=p_sku and status='approved'/i);
  assert.match(migration, /raise exception 'CHALLENGE_APPROVAL_REQUIRED'/i);
  assert.match(checkout, /submit_challenge_application/);
  assert.match(checkout, /if \(sku\.startsWith\('fut_'\)\) return 'futures'/);
  assert.match(dashboard, /p_challenge_type:'pac'/);
  assert.match(engine, /preset_id", "infinity_s1"/);
});

test('identity and residential details are required before application', () => {
  for (const field of [
    'legal_first_name', 'legal_last_name', 'date_of_birth', 'phone_e164',
    'address_line_1', 'city', 'postal_code', 'country_code', 'nationality_code',
  ]) assert.match(migration, new RegExp(field));
  assert.match(migration, /IDENTITY_REQUIRED/);
  assert.match(migration, /VERIFIED_EMAIL_REQUIRED/);
  assert.match(migration, /RESTRICTED_JURISDICTION/);
  assert.match(migration, /date_of_birth <= \(current_date - interval '18 years'\)::date/i);
  assert.match(migration, /phone_e164 ~ '\^\[\+\]\[1-9\]/i);
  assert.match(migration, /revoke all on public\.trader_identity_private from public, anon, authenticated/i);
});

test('legacy challenges are reversibly hidden without rewriting trading outcomes', () => {
  assert.match(migration, /challenge_access_revocations/);
  assert.match(migration, /set access_revoked_at=now\(\)/i);
  assert.match(migration, /access_revoked_at is null/i);
  assert.doesNotMatch(migration, /update public\.(trades|pending_orders)\b/i);
  assert.doesNotMatch(migration, /delete from public\.(trading_accounts|trades|pending_orders)\b/i);
  assert.doesNotMatch(migration, /set status='breached'/i);
  assert.match(engine, /\.is\("access_revoked_at", null\)/);
});

test('owner decision screen says Yes or No and refreshes every ten seconds', () => {
  assert.match(admin, /ownerOnlyActions[\s\S]*"application_queue", "application_decide"/);
  assert.match(admin, /\["approved", "denied"\]\.includes\(status\)/);
  assert.match(admin, /manual_challenge_approval_denied/);
  assert.match(adminPage, /Approved for this challenge\?/);
  assert.match(adminPage, />Yes<\/button>/);
  assert.match(adminPage, />No<\/button>/);
  assert.match(adminPage, /setInterval\(refreshAdminView,10000\)/);
});

test('traders see the 24-hour review state and cannot pay before approval', () => {
  assert.match(checkout, /review whether you can start this challenge within the next 24 hours/i);
  assert.match(checkout, /No payment has been requested and no trading account has been created/i);
  assert.match(engine, /pending_review: true/);
  assert.match(engine, /reviewed within the next 24 hours/i);
  assert.match(dashboard, /reviewed within the next 24 hours/i);
});

