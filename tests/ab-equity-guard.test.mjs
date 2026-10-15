// Runs the real equity-guard code from book-executor with synthetic broker and database I/O. No network or tokens.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm'; import { stripTypeScriptTypes } from 'node:module';
import { decodeAccountState } from '../supabase/functions/_shared/e8-account-totals.ts';
const text = fs.readFileSync(new URL('../supabase/functions/book-executor/index.ts', import.meta.url), 'utf8');
const code = text.slice(text.indexOf('async function flattenAccount('), text.indexOf('// Every copy or reverse that did not happen'));
const columns = ['balance', 'projectedBalance', 'todayGross', 'todayNet', 'todayFees', 'openGrossPnL', 'openNetPnL', 'positionsCount', 'ordersCount'].map((id) => ({ id }));
const state = (v) => ({ d: { accountDetailsData: columns.map((c) => v[c.id] ?? 0) } });

function guard({ decision = { flatten: false, day_pnl: -100 }, positions = ['501', '502'], legs = [], readError = null, after = [] } = {}) {
  const rpc = [], closed = [], direct = []; let snapshots = 0;
  const db = {
    rpc: async (name, args) => { rpc.push({ name, args }); return name === 'ongoing_copy_guard_save' ? { data: decision, error: null } : { data: { ok: true }, error: null }; },
    from: (table) => { const q = { select: () => q, eq: () => q, in: () => q, upsert: async () => ({ error: null }), then: (r) => r({ data: table === 'ongoing_copy_connections' ? [{ id: 1, account_id: 3, execution_on: true, kill_switch_on: true }] : table === 'book_orders' ? legs : [], error: null }) }; return q; },
  };
  const ctx = vm.createContext({ Date, Number, String, Math, Promise, Set, JSON, decodeAccountState,
    guardAccount: async () => ({ token: 'synthetic', accountId: '300', accNum: '1' }),
    accountRiskSnapshot: async () => { snapshots++; if (readError) throw new Error(readError); return { config: { accountDetailsConfig: { columns } }, state: state({ balance: 49000, projectedBalance: 48300, todayNet: -400, openNetPnL: -300 }), positionIds: snapshots > 1 ? after : positions }; },
    closeOwnedLeg: async (db_, leg, full, slice) => { closed.push({ id: leg.id, full, slice }); return { book: 'l3', confirmed: true }; },
    closePositionQty: async (token, accNum, id, qty) => { direct.push({ id, qty }); return {}; },
  });
  const run = vm.runInContext(stripTypeScriptTypes(code) + '\nequityGuard', ctx);
  return { run: () => run(db), rpc, closed, direct };
}

test('a healthy reading is saved with the broker day figures and nothing is closed', async () => {
  const g = guard(); const r = await g.run();
  const save = g.rpc.find((x) => x.name === 'ongoing_copy_guard_save');
  assert.deepEqual(JSON.parse(JSON.stringify(save.args.p_reading)), { balance: 49000, equity: 48300, today_net: -400, open_net: -300, positions: 2 });
  assert.equal(g.closed.length, 0); assert.equal(g.direct.length, 0); assert.equal(r.accounts[0].day_pnl, -100);
});

test('a breach closes every owned copy through the exit journal, then anything else still open at the broker', async () => {
  const legs = [{ id: 11, broker_position_id: '501' }, { id: 12, broker_position_id: '502' }];
  const g = guard({ decision: { flatten: true, reason: 'DAY_LOSS', day_pnl: -760, equity: 48300 }, legs, after: ['777'] }); const r = await g.run();
  assert.deepEqual(g.closed.map((x) => [x.id, x.full, x.slice]), [[11, true, 'kill'], [12, true, 'kill']]);
  assert.deepEqual(g.direct, [{ id: '777', qty: 0 }]);
  const done = g.rpc.find((x) => x.name === 'ongoing_copy_guard_flattened');
  assert.equal(done.args.p_result.owned_closed, 2); assert.equal(done.args.p_result.other_closed, 1); assert.equal(done.args.p_result.reason, 'DAY_LOSS');
  assert.equal(r.accounts[0].tripped, true);
});

test('a failed broker read is recorded and never trips or closes anything', async () => {
  const g = guard({ readError: 'RATE_LIMITED', decision: { flatten: true, reason: 'DAY_LOSS' } }); await g.run();
  const saves = g.rpc.filter((x) => x.name === 'ongoing_copy_guard_save');
  assert.equal(saves.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(saves[0].args.p_reading)), { error: 'RATE_LIMITED' });
  assert.equal(g.closed.length, 0); assert.equal(g.direct.length, 0);
});

test('owned copies missing from the broker are recorded as broker-stop closes from the receipt', async () => {
  const g = guard({ positions: ['501'], legs: [{ id: 11, broker_position_id: '501' }, { id: 12, broker_position_id: '502' }] }); await g.run();
  assert.deepEqual(g.rpc.filter((x) => x.name === 'fn_record_ongoing_broker_close').map((x) => x.args.p_open_id), [12]);
});
