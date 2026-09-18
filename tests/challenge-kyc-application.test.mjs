import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const page = read('start-challenge.html');
const flow = read('assets/js/checkout-flow.js');
const migration = read('supabase/migrations/20260918224500_challenge_application_kyc_gate.sql');
const admin = read('supabase/functions/admin-console/index.ts');
const adminPage = read('admin.html');
const engine = read('supabase/functions/trading-engine/index.ts');

test('all challenge families use one themed application page', () => {
  for (const type of ['futures','infinity','pac']) assert.match(page, new RegExp(type + ': \\{'));
  assert.match(flow, /if \(sku\.startsWith\('infinity_'\)\) return 'infinity'/);
  assert.match(read('infinity.html'), /start-challenge\.html\?type=infinity/);
  assert.match(read('personalised-challenge.html'), /start-challenge\.html\?type=pac#100k/);
});

test('application collects proportionate identity and suitability data', () => {
  for (const id of ['middleNames','nationality','employmentStatus','occupation','sourceOfFunds','expectedActivity','purpose','pepStatus','idDocumentType','idIssuingCountry','idExpiry','proofAddressDate']) {
    assert.match(page, new RegExp('id="' + id + '"'));
  }
  for (const id of ['ownBehalf','accuracyConfirm','riskConfirm','screeningConsent']) assert.match(page, new RegExp('id="' + id + '" required'));
  assert.doesNotMatch(page, /id="selfie"/i);
});

test('documents are private, limited and submitted before the application', () => {
  assert.match(flow, /storage\.from\('kyc-documents'\)\.upload/);
  assert.match(flow, /10 \* 1024 \* 1024/);
  assert.match(flow, /db\.rpc\('submit_kyc'/);
  assert.ok(flow.indexOf("await uploadVerificationDocuments(user)") < flow.indexOf('await submitChallengeReview()'));
  assert.match(migration, /KYC_DOCUMENTS_REQUIRED/);
  assert.match(migration, /doc_type='id_front'/);
  assert.match(migration, /doc_type='proof_of_address'/);
  assert.match(migration, /v_address_date<current_date-interval '3 months'/);
});

test('declarations are enforced by the database and bypasses fail closed', () => {
  for (const key of ['own_behalf_confirmed','information_accurate','risk_disclosure_accepted','screening_acknowledged']) assert.match(migration, new RegExp(key));
  assert.match(engine, /Complete the challenge application, declarations and identity-document upload/);
  assert.doesNotMatch(engine, /application_details: \{ source: "promo_claim"/);
});

test('owner reviews suitability and expiring private document links', () => {
  assert.match(admin, /createSignedUrls\(paths, 300\)/);
  assert.match(admin, /trader_kyc/);
  assert.match(adminPage, /Private links expire in 5 minutes/);
  assert.match(adminPage, /Purpose:/);
  assert.match(adminPage, /PEP:/);
});
