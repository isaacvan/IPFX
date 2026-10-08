import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');

test('Team overview and detector omit revoked prelaunch challenges', () => {
  const admin = read('supabase/functions/admin-console/index.ts');
  const team = read('supabase/functions/team-population/index.ts');
  const detector = read('supabase/functions/trader-detector/index.ts');
  assert.match(admin, /action === "overview"[\s\S]*?trading_accounts"\)\.select\("\*"\)\.neq\("phase", "demo"\)\.is\("access_revoked_at", null\)/);
  assert.match(admin, /action === "risk_analytics"[\s\S]*?trading_accounts"\)\.select\("\*"\)\.neq\("phase", "demo"\)\.is\("access_revoked_at", null\)/);
  assert.match(team, /trading_accounts"\)[\s\S]{0,160}\.is\("access_revoked_at", null\)/);
  assert.match(detector, /trading_accounts"\)[\s\S]{0,220}\.is\("access_revoked_at", null\)/);
});

test('only redeemed code claims expose Traditional $100K on the dashboard', () => {
  const dashboard = read('dashboard.html');
  const admin = read('supabase/functions/admin-console/index.ts');
  assert.match(dashboard, /redeemedClaims=\(claims\|\|\[\]\)\.filter\(c=>c\.promo_code/);
  assert.match(dashboard, /hasTraditional100kCode/);
  assert.match(dashboard, /visibleEnrollments=/);
  assert.match(dashboard, /visibleApplications=/);
  assert.match(admin, /preset_id === "trad_100k_p1"/);
  assert.match(admin, /A redeemed Traditional \$100K challenge code is required/);
});

test('archived attempts cannot resume or trigger a new stage', () => {
  const engine = read('supabase/functions/trading-engine/index.ts');
  const admin = read('supabase/functions/admin-console/index.ts');
  const mirror = read('supabase/functions/live-mirror/index.ts');
  assert.match(engine, /const \{ data: last \}[\s\S]{0,260}\.or\("access_revoked_at\.is\.null,status\.eq\.breached"\)/);
  assert.match(engine, /challengePreviewAllowed = Date\.now\(\) >= challengePublicLaunchAt/);
  assert.match(admin, /current\.challenge_type === "infinity" && !accountId && challengesLaunched/);
  assert.match(mirror, /source challenge inactive or archived/);
});
