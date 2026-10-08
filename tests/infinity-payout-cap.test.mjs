// Infinity: Stage 2 target 6%, Stage 3 target 8%, Stage 3 payout capped at $722 (owner decision 2026-10-08).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../supabase/migrations/20261008100000_infinity_targets_payout_cap.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('targets move to 6% (Stage 2) and 8% (Stage 3) for new stage accounts only', () => {
  assert.match(sql, /update public\.challenge_presets set profit_target_pct = 6 where id = 'infinity_s2' and profit_target_pct = 5;/);
  assert.match(sql, /update public\.challenge_presets set profit_target_pct = 8 where id = 'infinity_s3' and profit_target_pct = 6;/);
  assert.doesNotMatch(sql, /update public\.trading_accounts/, 'existing accounts keep the target they were created with');
});

test('the Stage 3 payout is 85% of profit but never more than $722, and the $500 minimum stays', () => {
  assert.match(sql, /share:=least\(round\(gross\*0\.85,2\),722\);/);
  assert.match(sql, /if share<500 then raise exception 'BELOW_MINIMUM:MINIMUM \$500'/);
  assert.match(sql, /available_share:=least\(round\(\(greatest\(s3_profit,0\)\+case when first_exists then 0 else greatest\(s2_profit,0\) end\)\*0\.85,2\),722\);/);
  assert.match(sql, /held_share:=case when first_exists then 0 else least\(round\(greatest\(s2_profit,0\)\*0\.85,2\),722\) end/);
  assert.match(sql, /'max_payout',722/);
});

test('completion checks stay valid at the higher targets and the guards are unchanged', () => {
  assert.match(sql, /s3\.balance < s3\.starting_balance\*1\.06/, '8% completion always satisfies the 6% floor');
  assert.match(sql, /KYC_NOT_VERIFIED/);
  assert.match(sql, /STAGE3_COMPLETION_PAYOUT_ALREADY_REQUESTED/);
  assert.match(sql, /INVALID_PAYOUT_METHOD/);
});
