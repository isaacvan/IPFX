import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const admin = read('supabase/functions/admin-console/index.ts');
const mirror = read('supabase/functions/live-mirror/index.ts');
const sync = read('supabase/functions/macro-calendar-sync/index.ts');
const migration = read('supabase/migrations/20260918190000_adaptive_mirror_risk_and_trader_styles.sql');
const page = read('trader-analytics.html');
const teamLogin = read('team-login.html');
const teamAccess = read('supabase/functions/team-access/index.ts');

test('risk analytics is restricted to the configured owner and MFA', () => {
  assert.match(admin, /IPFX_OWNER_EMAIL/);
  assert.match(admin, /ownerOnlyActions.*risk_analytics/);
  assert.match(admin, /sensitiveActions.*risk_analytics/);
  assert.match(admin, /tokenAal\(bearerToken\) !== "aal2"/);
  assert.match(page, /action:'risk_analytics'/);
});

test('Team Login checks owner access and completes password plus authenticator verification', () => {
  assert.match(teamAccess, /IPFX_OWNER_EMAIL/);
  assert.match(teamAccess, /client\.auth\.getUser\(\)/);
  assert.match(teamAccess, /from\("admins"\)/);
  assert.match(teamLogin, /<h1>Team Login<\/h1>/);
  assert.match(teamLogin, /signInWithPassword/);
  assert.match(teamLogin, /functions\/v1\/team-access/);
  assert.match(teamLogin, /mfa\.challengeAndVerify/);
  assert.match(teamLogin, /mfa\.enroll\(\{factorType:'totp'/);
  assert.match(teamLogin, /location\.replace\('\/admin\.html'\)/);
  assert.doesNotMatch(teamLogin, /signup\.html|Sign up/);
});

test('adaptive controls affect only own-account mirror opens and never block closes', () => {
  assert.match(mirror, /never changes the trader's challenge trade/i);
  assert.match(mirror, /event === "open" && riskDecision\.action === "skip"/);
  assert.match(read('supabase/functions/_shared/trader-risk.ts'), /event === "close".*action: "allow"/);
  assert.match(page, /closing orders always remain enabled/i);
});

test('macro ingestion is server-only and secrets never reach the page', () => {
  assert.match(sync, /TRADING_ECONOMICS_API_KEY/);
  assert.match(sync, /INTERNAL_CRON_SECRET/);
  assert.doesNotMatch(page, /TRADING_ECONOMICS_API_KEY|INTERNAL_CRON_SECRET/);
});

test('new intelligence tables have RLS and no browser grants', () => {
  for (const table of ['macro_calendar_events','trader_style_profiles','mirror_risk_policies','mirror_risk_decisions']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  }
  assert.match(migration, /revoke all on public\.macro_calendar_events[\s\S]*from anon, authenticated/i);
});
