import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const migration = read('../supabase/migrations/20260920100000_phase_specific_risk_caps.sql');
const infinityV3 = read('../supabase/migrations/20260920173000_infinity_only_october_launch.sql');
const engine = read('../supabase/functions/trading-engine/index.ts');
const terms = read('../terms.html');
const home = read('../index.html');
const infinity = read('../infinity.html');
const futures = read('../futures.html');
const pac = read('../personalised-challenge.html');

test('every programme receives the approved phase-specific base cap', () => {
  for (const fragment of [
    "challenge_type = 'infinity' and stage between 1 and 3 then 0.70",
    "challenge_type = 'infinity' and stage = 4 then 0.50",
    "challenge_type = 'traditional' and stage = 1 then 0.75",
    "challenge_type = 'traditional' and stage = 2 then 0.50",
    "challenge_type = 'traditional' and stage = 3 then 0.40",
    "challenge_type = 'futures' and stage = 1 then 0.50",
    "challenge_type = 'futures' and stage = 2 then 0.40",
    "challenge_type = 'pac' then 0.50",
  ]) assert.ok(migration.includes(fragment), fragment);
  assert.match(migration, /require_stop_loss = true/);
  assert.match(migration, /coalesce\(a\.phase, ''\) <> 'demo'/);
  for (const fragment of [
    "where id = 'infinity_s1'",
    'max_risk_per_trade_pct = 0.50',
    "where id = 'infinity_s2'",
    "where id = 'infinity_s3'",
    'max_risk_per_trade_pct = 0.35',
    "where id = 'infinity_s4'",
    'max_risk_per_trade_pct = 0.25',
  ]) assert.ok(infinityV3.includes(fragment), fragment);
});

test('engine tightens risk against live drawdown and daily buffers everywhere', () => {
  assert.match(engine, /DRAWDOWN_BUFFER_RISK_FRACTION = 0\.20/);
  assert.match(engine, /DAILY_BUFFER_RISK_FRACTION = 0\.25/);
  assert.match(engine, /Math\.min\([\s\S]*base,[\s\S]*drawdownRemaining \* DRAWDOWN_BUFFER_RISK_FRACTION,[\s\S]*dailyRemaining \* DAILY_BUFFER_RISK_FRACTION/);
  assert.ok((engine.match(/effectiveRiskLimit\(/g) || []).length >= 7, 'market, pending, slippage, aggregate, modify and status paths must use it');
  assert.match(engine, /max_risk_per_trade_usd: liveRiskLimit\?\.effective/);
});

test('Terms disclose the current caps, mandatory stops and dynamic calculation', () => {
  for (const value of ['0.75%', '0.50%', '0.40%', '0.35%', '0.25%', '20%', '25%']) {
    assert.ok(terms.includes(value), value);
  }
  assert.match(terms, /Dynamic risk protection/);
  assert.match(terms, /stop-loss is mandatory/i);
});

test('marketing pages show live Supabase-backed risk fields', () => {
  assert.match(infinity, /data-preset="infinity_s1" data-field="risk"/);
  assert.match(infinity, /data-preset="infinity_s3" data-field="risk"/);
  assert.match(home, /data-preset="trad_25k_p1" data-field="risk_pct"/);
  assert.match(home, /data-preset="fut_150k_p2" data-field="risk_pct"/);
  assert.match(futures, /data-preset="fut_25k_p1" data-field="risk_pct"/);
  assert.match(pac, /0\.50% of starting balance is the safety ceiling/);
});
