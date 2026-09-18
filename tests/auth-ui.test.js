import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const login = fs.readFileSync(path.join(root, 'login.html'), 'utf8');
const trading = fs.readFileSync(path.join(root, 'trading.html'), 'utf8');

test('website and Markets login use the pinned Supabase client with bounded waits', () => {
  for (const html of [login, trading]) {
    assert.match(html, /@supabase\/supabase-js@2\.57\.4\/dist\/umd\/supabase\.min\.js/);
    assert.match(html, /Promise\.race\(\[signIn,\s*timeout\]\)/);
  }
  assert.doesNotMatch(login, /error\.status\s*===\s*400/);
  assert.match(login, /The email or password is incorrect\./);
  assert.match(trading, /The email or password is incorrect\./);
});

test('Markets keeps only trading chrome and centers the reusable login modal', () => {
  assert.doesNotMatch(trading, /id="dashboardBackBtn"/);
  assert.doesNotMatch(trading, /class="back-btn desktop-download-link"/);
  assert.doesNotMatch(trading, /<div class="ipfx-launch-footer"/);
  assert.match(trading, /\.desktop-auth\{display:none;position:fixed;inset:0/);
  assert.match(trading, /\.desktop-auth\.open\{display:flex\}/);
});
