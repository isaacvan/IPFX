import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { e8TraderPerformanceRead } from '../supabase/functions/_shared/e8-trader-performance.ts';
const id = '22222222-2222-4222-8222-222222222222';
const fake = (value = { available: true }) => { const calls = []; return { calls, rpc: async (fn, args) => { calls.push({ fn, args }); return { data: value, error: null }; } }; };
test('owner cache actions validate scenarios and pagination before a database call', async () => {
  const db = fake();
  assert.equal(await e8TraderPerformanceRead(db, 'overview', {}), null);
  for (const body of [{ latency: 3 }, { slippage: -1 }, { page: -1 }, { limit: 101 }, { sort: 'sql injection' }, { direction: 'x' }, { class_filter: 'invented' }, { query: 'x'.repeat(121) }]) {
    assert.equal((await e8TraderPerformanceRead(db, 'e8_trader_performance', body)).status, 400);
  }
  assert.equal(db.calls.length, 0);
  const result = await e8TraderPerformanceRead(db, 'e8_trader_performance', { latency: 15, slippage: 2, page: 1, limit: 20, direction: 'asc' });
  assert.equal(result.status, 200); assert.equal(result.body.performance.available, true);
  assert.equal(db.calls[0].fn, 'ab_e8_trader_perf_read');
  assert.deepEqual([db.calls[0].args.p_latency, db.calls[0].args.p_slippage, db.calls[0].args.p_desc], [15, 2, false]);
});
test('detail and selected-set simulation are bounded cache reads with safe IDs', async () => {
  const db = fake();
  for (const body of [{ trader_ids: [] }, { trader_ids: [id, id], book: 'a' }, { trader_ids: ['x'], book: 'a' }, { trader_ids: [id], book: 'both' }]) assert.equal((await e8TraderPerformanceRead(db, 'e8_trader_portfolio', body)).status, 400);
  assert.equal((await e8TraderPerformanceRead(db, 'e8_trader_detail', { trader_id: id })).status, 200);
  assert.equal((await e8TraderPerformanceRead(db, 'e8_trader_portfolio', { trader_ids: [id], book: 'b' })).status, 200);
  assert.deepEqual(db.calls.map(x => x.fn), ['ab_e8_trader_perf_detail', 'ab_e8_trader_perf_portfolio']);
  assert.equal((await e8TraderPerformanceRead(fake({ value: 'x'.repeat(1_500_001) }), 'e8_trader_detail', { trader_id: id })).status, 413);
  const failed = { rpc: async () => ({ data: null, error: { message: 'private database detail' } }) };
  assert.doesNotMatch(JSON.stringify(await e8TraderPerformanceRead(failed, 'e8_trader_detail', { trader_id: id })), /private database detail/);
});
test('the Brain cache reader stays behind owner MFA and does not invoke broker or refresh actions', () => {
  const source = fs.readFileSync(new URL('../supabase/functions/brain-monitor/index.ts', import.meta.url), 'utf8');
  assert.ok(source.indexOf('await e8TraderPerformanceRead') > source.indexOf('Owner access only'));
  const helper = fs.readFileSync(new URL('../supabase/functions/_shared/e8-trader-performance.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(helper, /book-executor|tradelocker|perf_refresh|fetch\(/i);
});
