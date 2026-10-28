// Owner decision 2026-10-28: one trade idea (same symbol and direction) carries at most one trade's risk, however many tickets it is split into.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
const src = fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts', import.meta.url), 'utf8');
const fnSrc = src.slice(src.indexOf('function sameIdeaLimitReason('), src.indexOf('async function sameIdeaRiskUsd('));
const c = vm.createContext({}); vm.runInContext(stripTypeScriptTypes(fnSrc), c);
test('a first order, or a de-risked one, is allowed; a second full-size ticket on the same idea is refused', () => {
  assert.equal(c.sameIdeaLimitReason(null, 5, 5, 'EURUSD'), null);
  assert.equal(c.sameIdeaLimitReason(0, 5, 5, 'EURUSD'), null);           // earlier stop moved to break-even carries no risk
  assert.equal(c.sameIdeaLimitReason(2.5, 2.5, 5, 'EURUSD'), null);       // two half-size tickets still fit one trade's risk
  assert.match(c.sameIdeaLimitReason(5, 5, 5, 'EURUSD'), /Same-trade limit: you already have \$5\.00 at risk on this EURUSD trade idea/);
  assert.match(c.sameIdeaLimitReason(3, 2.02, 5, ''), /Same-trade limit/);  // over by more than a cent
  assert.equal(c.sameIdeaLimitReason(3, 2.005, 5, ''), null);             // within the one-cent tolerance the other limits use
});
test('the check runs on market orders and on resting-order activation, for same symbol and direction only', () => {
  assert.match(src, /const sameRisk = await sameIdeaRiskUsd\(state\.open, symbol, side\);/);
  assert.match(src, /const sameReason = sameIdeaLimitReason\(sameRisk, riskUsd, perTrade, symbol\);/);
  assert.match(src, /sameIdeaRiskUsd\(working, symbol, String\(o\.side\)\)/);
  assert.match(src, /openRiskUsd\(open\.filter\(\(t\) => t\.symbol === symbol && t\.side === side\)\)/);
  assert.match(src, /const same = sameIdeaLimitReason\(sameIdeaRisk, riskUsd, maxRisk, ""\);/);
});
