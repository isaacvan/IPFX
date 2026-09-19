import assert from 'node:assert/strict';
import fs from 'node:fs';

const engine = fs.readFileSync('supabase/functions/trading-engine/index.ts','utf8');
const trading = fs.readFileSync('trading.html','utf8');
const dashboard = fs.readFileSync('dashboard.html','utf8');
const admin = fs.readFileSync('supabase/functions/admin-console/index.ts','utf8');
const migration = fs.readFileSync(
  'supabase/migrations/20260919183000_breach_to_demo_account.sql','utf8'
);

assert.match(migration, /phase in \('evaluation','funded','demo'\)/);
assert.match(migration, /status in \('active','passed','breached','demo'\)/);
assert.match(migration, /trading_accounts_one_demo_per_user_idx/);
assert.match(migration, /pg_advisory_xact_lock/);
assert.match(migration, /access_revoked_reason='challenge_rule_breach:'\|\|p_reason/);
assert.match(migration, /update public\.pending_orders[\s\S]*status='cancelled'/);
assert.match(migration, /perform public\.fn_ensure_demo_account\(a\.user_id\)/);
assert.match(migration, /a\.status='demo' and a\.phase='demo'/);
assert.match(migration, /revoke all on function public\.fn_ensure_demo_account\(uuid\) from public,anon,authenticated/);
assert.match(migration, /status='breached' and access_revoked_reason like 'challenge_rule_breach:%'/);

assert.match(engine, /const requestedDemo = body\.account_mode === "demo"/);
assert.match(engine, /never a client-supplied account[\s\S]*id/);
assert.match(engine, /isTradableAccount\(acct\)/);
assert.match(engine, /acct\.status === "active" && !isDemoAccount\(acct\)/);
assert.match(engine, /breach_notice: await breachNotice/);
assert.match(engine, /switched_to_demo: true/);
assert.match(engine, /order_blocked: action !== "state"/);
assert.match(engine, /reason,trigger_equity,breach_floor,triggered_at/);

assert.match(trading, /id="modeChallenge"/);
assert.match(trading, /id="modeDemo"/);
assert.match(trading, /Continue on demo/);
assert.match(trading, /Challenge\/funded access stays paused/);
assert.match(trading, /equity reached \$\{money\(breach\.trigger_equity\)\}/);
assert.match(trading, /source_account_id=a\.source_account_id/);
assert.match(trading, /selectedAccountMode='challenge'/);

assert.match(dashboard, /neq\('phase','demo'\)/);
assert.match(admin, /neq\("phase", "demo"\)/);

console.log('PASS: breached challenge accounts freeze and switch to an isolated demo account');
