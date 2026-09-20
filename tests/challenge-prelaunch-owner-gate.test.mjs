import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = file => fs.readFileSync(file, 'utf8');

test('public start page is a launch screen and only loads checkout after the gate opens', () => {
  const page = read('start-challenge.html');
  assert.match(page, /Closed research preview/);
  assert.match(page, /A launch date will be published only after the readiness checks are complete/);
  assert.match(page, /id="challengePreviewApp" hidden/);
  assert.match(page, /functions\/v1\/team-access/);
  assert.match(page, /currentLevel !== 'aal2'/);
  assert.match(page, /document\.createElement\('script'\)/);
  assert.match(page, /script\.src = '\/assets\/js\/checkout-flow\.js'/);
  assert.doesNotMatch(page, /<script src="assets\/js\/checkout-flow\.js"><\/script>/);
});

test('team preview return path is allowlisted and cannot become an open redirect', () => {
  const page = read('team-login.html');
  assert.match(page, /\^\\\/start-challenge\\\.html/);
  assert.match(page, /safeNext/);
  assert.match(page, /location\.replace\(safeNext\)/);
});

test('database rejects non-owner applications until the explicit launch switch is enabled', () => {
  const migration = read('supabase/migrations/20260920110000_launch_and_financial_safety_controls.sql');
  assert.match(migration, /public_challenges_enabled/);
  assert.match(migration, /join public\.admins a on a\.user_id=u\.id/);
  assert.match(migration, /lower\(coalesce\(u\.email,''\)\)='paulade491@gmail\.com'/);
  assert.match(migration, /CHALLENGE_APPLICATIONS_CLOSED/);
});

test('every server activation and checkout path enforces the same pre-launch owner gate', () => {
  for (const file of [
    'supabase/functions/create-payment-intent/index.ts',
    'supabase/functions/nowpayments-checkout/index.ts',
    'supabase/functions/trading-engine/index.ts',
  ]) {
    const source = read(file);
    assert.match(source, /IPFX_PUBLIC_CHALLENGES_ENABLED/);
    assert.match(source, /IPFX_OWNER_EMAIL/);
    assert.match(source, /Challenge applications are not open to the public yet\./);
  }
  assert.match(read('supabase/functions/trading-engine/index.ts'), /claim_infinity[\s\S]{0,180}!challengePreviewAllowed/);
});
