// Safe E8 copy limits (owner approved 2026-11-19): E8 $50k allows $625 daily loss and $3,000 drawdown.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const sql = fs.readFileSync(new URL('../supabase/migrations/20261119120000_ab_safe_e8_limits.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
test('both books: $400 daily stop, $200 open risk, $25 a trade and per trader, crowd 2, drawdown ladder 1.5k/2k/2.5k', () => {
  assert.match(sql, /daily_loss_stop_usd = 400, open_risk_max_usd = 200, per_trade_max_usd = 25, per_trader_open_max_usd = 25,/);
  assert.match(sql, /crowd_max = 2/);
  assert.match(sql, /dd_halve_usd = 1500, dd_quarter_usd = 2000, dd_stop_usd = 2500/);
  assert.match(sql, /where book in \('a', 'b'\);/);
});
test('the function change refuses to apply over an unreviewed live version', () => {
  assert.match(sql, /md5\(pg_get_functiondef\('public\.ab_reserve_risk\(text,uuid,uuid,text,numeric,numeric\)'::regprocedure\)\) <> 'b9e269dc4bfaf2636ced43e76ef9af1a'/);
});
test('books A and B share one open-risk and daily-loss total; drawdown halves, quarters, then stops', () => {
  assert.match(sql, /books := case when p_book in \('a', 'b'\) then array\['a', 'b'\] else array\[p_book\] end;/);
  assert.equal((sql.match(/book = any\(books\)/g) || []).length, 3);
  assert.match(sql, /'drawdown stop reached'/);
  assert.match(sql, /dd_factor := 0\.25;/);
  assert.match(sql, /dd_factor := 0\.5;/);
  assert.match(sql, /room := dd_factor \* least\(per_trade,/);
});
test('E8 ladder accounts use the book A limits scaled to their size unless the owner set their own daily loss', () => {
  assert.match(sql, /ratio := la\.size_usd \/ coalesce\(nullif\(lim\.account_size_usd, 0\), 50000\);/);
  assert.match(sql, /if public\.ongoing_copy_owner_daily_loss\(la\.id\) is null then/);
  assert.match(sql, /stop_usd := least\(stop_usd, coalesce\(lim\.daily_loss_stop_usd \* ratio, stop_usd\)\);/);
});
