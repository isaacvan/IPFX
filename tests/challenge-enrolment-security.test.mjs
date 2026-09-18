import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const migration = read('supabase/migrations/20260918143000_identity_enrolment_and_continuation_offers.sql');
const checkout = read('supabase/functions/create-payment-intent/index.ts');
const engine = read('supabase/functions/trading-engine/index.ts');
const admin = read('supabase/functions/admin-console/index.ts');
const dashboard = read('dashboard.html');
const trading = read('trading.html');

test('identity PII has no direct browser table access', () => {
  assert.match(migration, /trader_identity_private enable row level security/i);
  assert.match(migration, /challenge_enrolment_one_open_request_idx/i);
  assert.match(migration, /submit_challenge_application\(text,jsonb\)/i);
  assert.match(migration, /revoke all on public\.trader_identity_private from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.submit_identity_profile\(jsonb\) to authenticated/i);
  assert.match(migration, /date_of_birth <= \(current_date - interval '18 years'\)::date/i);
  assert.match(migration, /phone_e164 ~ '\^\\\+\[1-9\]/i);
});

test('all account activation paths require protected identity', () => {
  assert.match(checkout, /Complete your identity and address details before starting a challenge/);
  assert.match(engine, /trader_identity_private/);
  assert.match(engine, /Complete your identity and residential address before activating a challenge/);
  assert.match(dashboard, /submit_identity_profile/);
});

test('continuation pricing is immutable, bounded, progressive and non-discriminatory', () => {
  assert.match(migration, /source_account_id uuid not null unique/);
  assert.match(migration, /amount_minor integer not null check \(amount_minor between 100 and 100000\)/i);
  assert.match(checkout, /0\.35 \* progress \* progress/);
  assert.match(checkout, /0\.20 \* \(failureNumber - 1\)/);
  assert.match(checkout, /protected_attributes_used: false/);
  assert.match(checkout, /Math\.min\(cap/);
  assert.doesNotMatch(trading, /£10/);
  assert.match(trading, /quote\.product\.amount_minor/);
});

test('sensitive admin PII routes require MFA and fail closed on audit failure', () => {
  assert.match(admin, /tokenAal\(bearerToken\) !== "aal2"/);
  assert.match(admin, /challenge_application_queue_view/);
  assert.match(admin, /trader_identity_view/);
  assert.match(admin, /Personal information is unavailable because the audit trail could not be written/);
  assert.match(admin, /createSignedUrl\(d\.storage_path, 300\)/);
  assert.match(admin, /Access-Control-Allow-Origin": "https:\/\/ipfxcapital\.com"/);
});

test('Infinity and Futures CTAs retain the selected product', () => {
  const infinity = read('infinity.html');
  const futures = read('futures.html');
  const pac = read('personalised-challenge.html');
  assert.match(infinity, /start-challenge\.html\?type=infinity/);
  assert.match(futures, /start-challenge\.html\?type=futures#25k/);
  assert.match(pac, /start-challenge\.html\?type=pac/);
  assert.match(read('start-challenge.html'), /data-sku="trad_10k_p1"/);
});
