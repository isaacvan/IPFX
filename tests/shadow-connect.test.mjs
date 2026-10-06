// Connecting the 10 TradeLocker demo copy accounts with one login.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const admin = read('supabase/functions/ladder-admin/index.ts');

test('"add every account on this login" is demo copy only, skips accounts already connected, and starts with copying off', () => {
  assert.match(admin, /const all = body\.all === true && role === "shadow"/);
  assert.match(admin, /have\.has\(`\$\{server\}\|\$\{accountId\}`\)\) \{ skipped\+\+; continue; \}/);
  assert.match(admin, /execution_enabled: false, role, api_env: env/);
  assert.match(admin, /env !== "demo" && role !== "monitor"/, 'copy accounts still demo environment only');
});

test('demo copy accounts carry no fee, and the E8 monitor still can never be switched on', () => {
  assert.match(admin, /fee_usd: role === "shadow" \? 0 : fee/);
  assert.match(admin, /The E8 monitor account is read-only and can never receive copies/);
});

test('the Treasury form offers it and the password is cleared after submit', () => {
  assert.match(read('team-treasury.html'), /<select id="laAll">/);
  const js = read('assets/js/team-treasury.js');
  assert.match(js, /all: \$\('laAll'\)\.value === '1'/);
  assert.match(js, /finally \{ \$\('laPassword'\)\.value = ''/);
});
