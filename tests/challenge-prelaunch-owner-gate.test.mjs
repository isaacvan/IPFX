import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = file => fs.readFileSync(file, 'utf8');

test('public start page is a launch screen and only loads checkout after the gate opens', () => {
  const page = read('start-challenge.html');
  assert.match(page, /Launching<br>1 October 2026/);
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

test('database rejects non-owner applications until the public launch', () => {
  const migration = read('supabase/migrations/20260919034000_owner_only_challenge_preview_until_launch.sql');
  assert.match(migration, /2026-10-01 00:00:00 Europe\/London/);
  assert.match(migration, /join public\.admins a on a\.user_id=u\.id/);
  assert.match(migration, /lower\(coalesce\(u\.email,''\)\)='paulade491@gmail\.com'/);
  assert.match(migration, /CHALLENGES_LAUNCH_OCTOBER_1/);
  assert.match(migration, /revoke all on function public\.submit_challenge_application\(text,jsonb,text\) from public,anon/);
});

test('every server activation and checkout path enforces the same pre-launch owner gate', () => {
  for (const file of [
    'supabase/functions/create-payment-intent/index.ts',
    'supabase/functions/nowpayments-checkout/index.ts',
    'supabase/functions/trading-engine/index.ts',
  ]) {
    const source = read(file);
    assert.match(source, /2026-09-30T23:00:00Z/);
    assert.match(source, /IPFX_OWNER_EMAIL/);
    assert.match(source, /Challenges launch 1 October 2026\./);
  }
  assert.match(read('supabase/functions/trading-engine/index.ts'), /claim_infinity[\s\S]{0,180}!challengePreviewAllowed/);
});
