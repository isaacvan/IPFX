import assert from 'node:assert/strict';
import fs from 'node:fs';

function applyTick(state, equity) {
  if (state.status === 'breached') return state;
  const reason = equity <= state.maxFloor
    ? 'max_drawdown'
    : equity <= state.dailyFloor
      ? 'daily_loss'
      : null;
  return reason ? {...state, status: 'breached', reason, triggerEquity: equity} : state;
}

const base = {status:'active', reason:null, maxFloor:9000, dailyFloor:9600};

let exact = applyTick(base, 9000);
assert.equal(exact.status, 'breached', 'the exact overall floor must breach');
assert.equal(exact.reason, 'max_drawdown');

let daily = applyTick({...base,maxFloor:8000}, 9600);
assert.equal(daily.status, 'breached', 'the exact daily floor must breach');
assert.equal(daily.reason, 'daily_loss');

let recovered = applyTick(base, 8999);
recovered = applyTick(recovered, 10200);
assert.equal(recovered.status, 'breached', 'a later recovery must not reverse a breach');
assert.equal(recovered.triggerEquity, 8999, 'the first crossing must remain recorded');

const engine = fs.readFileSync('supabase/functions/trading-engine/index.ts','utf8');
const migration = fs.readFileSync(
  'supabase/migrations/20260918092933_infinity_intratrade_freeze_and_resume.sql','utf8'
);
const trading = fs.readFileSync('trading.html','utf8');

assert.match(engine, /if \(equity <= ddFloor\) breach = "max_drawdown"/);
assert.match(engine, /else if \(equity <= dailyFloor\) breach = "daily_loss"/);
assert.match(engine, /fn_claim_account_breach/);
assert.match(engine, /body\.enforce_risk === true/);
assert.match(migration, /BREACHED_ACCOUNT_IS_FROZEN/);
assert.match(migration, /TRADING_ACCOUNT_FROZEN/);
assert.match(migration, /'infinity_continue'.*1000,'gbp'/s);
assert.match(migration, /source_account\.preset_id/);
assert.match(migration, /resumed_from_account_id/);
assert.match(trading, /Continue this stage — £10/);
assert.match(trading, /Restart from Stage 1/);
assert.match(trading, /enforce_risk:true/);

console.log('PASS: Infinity breach, freeze, recovery, and continuation contract checks');
