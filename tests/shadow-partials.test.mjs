// Shadow copy: partial closes are priced from the demo account's own quote, with no extra order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const exec = read('supabase/functions/book-executor/index.ts');
const engine = read('supabase/functions/trading-engine/index.ts');
const sql = read('supabase/migrations/20261006100000_shadow_partials.sql');
const fn = (name) => { const i = exec.indexOf(`async function ${name}(`); assert.ok(i >= 0, name + ' exists'); const j = exec.indexOf('\nasync function ', i + 10); return exec.slice(i, j < 0 ? undefined : j); };

test('a partial close sends no broker order: it only reads the demo account quote', () => {
  for (const name of ['shadowPriceSlices', 'shadowPartial']) {
    assert.doesNotMatch(fn(name), /placeMarketOrder|closePositionQty|book_orders|ab_reserve_risk/, name);
  }
  assert.match(fn('shadowPriceSlices'), /readClient\(dest\.env\)\.quote\(/);
  assert.match(fn('shadowPriceSlices'), /leg\.side === "buy" \? q\.bid : q\.ask/, 'exit uses the side a close would trade');
});

test('slices are idempotent, never priced late, and priced after a late fill, before the final close, and by the sweep', () => {
  assert.match(sql, /slice_trade_id uuid not null unique/);
  assert.match(fn('shadowPartial'), /23505/);
  assert.match(exec, /const SLICE_MAX_AGE_MS = 3 \* 60_000/);
  assert.match(fn('shadowOpen'), /if \(positionId\) await shadowPriceSlices/);
  assert.match(fn('shadowClose'), /await shadowPriceSlices\(db, tradeId\)/);
  assert.match(fn('shadowReconcile'), /shadowPriceSlices\(db, String\(w\)\)/);
});

test('engine sends the slice id on every partial close and the executor routes it', () => {
  assert.match(engine, /shadowLater\(db, acct as Acct, \{ event: "shadow_partial", source_trade_id: target\.id, slice_trade_id: closedSlice\.id \}\)/);
  assert.match(exec, /body\.event === "shadow_partial"/);
});

test('funded-size maths weights every exit by volume and leaves out unpriced trades', () => {
  assert.match(sql, /r\.final_vol \* \(r\.final_exit - r\.entry\) \+ r\.slice_vol_move/);
  assert.match(sql, /\(r\.final_vol \+ r\.slice_vol\) \* p_funded \/ r\.size_usd/);
  assert.match(sql, /where r\.all_priced/);
  assert.match(sql, /'incomplete'/);
  assert.match(read('assets/js/team-brain.js'), /they are not confirmed broker fills/);
});

test('A-book and B-book partial closes are unchanged (they already shrink by fraction)', () => {
  assert.match(engine, /bookLater\(\{ event: "partial_close", source_trade_id: target\.id, fraction: vol \/ full, slice_id: closedSlice\.id \}\)/);
  assert.match(exec, /event === "partial_close" \? "partial_close" : "close"/);
});

test('the E8 monitor guarantee still holds: the read client has no order functions', () => {
  assert.doesNotMatch(read('supabase/functions/_shared/tradelocker-read.ts'), /placeMarketOrder|closePosition/);
});
