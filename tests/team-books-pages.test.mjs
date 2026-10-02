import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const js = read('assets/js/team-books.js');
const a = read('team-a-book.html');
const b = read('team-b-book.html');
const login = read('team-login.html');
const analytics = read('trader-analytics.html');
const population = read('supabase/functions/team-population/index.ts');
const connector = read('supabase/functions/team-book-connect/index.ts');
const schema = read('supabase/migrations/20261002010000_team_book_destinations.sql');

test('Team Analytics inline JavaScript parses', () => {
  const scripts = [...analytics.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]).filter(Boolean);
  assert.ok(scripts.length > 0);
  for (const source of scripts) new vm.Script(source);
});

test('both Team book pages use the owner-only analytics endpoint and no browser broker order', () => {
  assert.match(js, /action: 'risk_analytics'/);
  assert.doesNotMatch(js, /tradelocker-connect|live-mirror|marketOrder|placeMarketOrder/);
  assert.match(a, /data-book="a"/);
  assert.match(b, /data-book="b"/);
  assert.match(login, /team-a-book\|team-b-book/);
});

test('A assignments require an explicit approved server route', () => {
  assert.match(js, /value\.approved !== true/);
  assert.match(js, /value\.state === 'A' \|\| value\.state === 'SPLIT'/);
  assert.match(a, /No.*orders|does not place orders/);
});

test('funded projection is withheld without exact 0.01-lot broker evidence', () => {
  assert.match(js, /Number\(day\.executed_lots\) === 0\.01/);
  assert.match(js, /finite\(day\.gross_price_pnl_usd\)/);
  assert.match(js, /Unavailable — fixed-size fills not verified/);
  assert.match(b, /0\.2 lots is position size, not a 0\.2% risk limit/);
});

test('registered users, demo accounts and challenge accounts are distinct and refreshable', () => {
  assert.match(population, /registered_users_count/);
  assert.match(population, /registered_without_account/);
  assert.match(population, /\.range\(offset, offset \+ 999\)/);
  assert.match(population, /aal\(bearer\) !== "aal2"/);
  assert.match(population, /req\.method !== "GET"/);
  assert.doesNotMatch(population, /\.insert\(|\.update\(|\.delete\(|placeMarketOrder|mirror_targets/);
  assert.match(analytics, /\/functions\/v1\/team-population/);
  assert.match(js, /\/functions\/v1\/team-population/);
  assert.match(analytics, /Registered users without a trading account/);
  assert.match(analytics, /Demo trading accounts/);
  assert.match(js, /setInterval\(\(\) => \{ if \(document\.visibilityState === 'visible'\) load\(\); \}, 30000\)/);
});

test('book login stores encrypted tokens only and cannot arm the existing same-direction copier', () => {
  assert.match(connector, /aal\(bearer\) !== "aal2"/);
  assert.match(connector, /encryptSecret\(tokenSet\.accessToken/);
  assert.match(connector, /encryptSecret\(tokenSet\.refreshToken/);
  assert.doesNotMatch(connector, /\.from\("mirror_targets"\)|placeMarketOrder|\/functions\/v1\/live-mirror|\.from\("trading_accounts"\)/);
  assert.match(schema, /enable row level security/);
  assert.match(schema, /revoke all on public\.team_book_destinations from public, anon, authenticated/);
  assert.match(a, /id="connectAll"[^>]*disabled/);
  assert.match(b, /id="connectAll"[^>]*disabled/);
});
