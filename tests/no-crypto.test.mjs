import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const engine = fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(new URL('../trading.html', import.meta.url), 'utf8');
const registry = engine.slice(engine.indexOf('type Inst ='), engine.indexOf('// Futures rules:'));
const gate = engine.slice(engine.indexOf('const FUTURES_MIN_BALANCE'), engine.indexOf('// Futures trade in whole'));
const { INSTRUMENTS, instrumentGate } = new Function(stripTypeScriptTypes(registry + gate) + '\nreturn { INSTRUMENTS, instrumentGate };')();
const coins = ['BTCUSD', 'ETHUSD', 'LTCUSD', 'ADAUSD', 'SOLUSD', 'DOTUSD'];

test('every crypto entry is refused on all IPFX challenge types', () => {
  for (const challenge_type of ['demo', 'infinity', 'traditional', 'futures']) {
    for (const symbol of coins) assert.match(instrumentGate({ challenge_type, starting_balance: 100000 }, symbol), /Crypto trading is not available/);
  }
  assert.equal(instrumentGate({ challenge_type: 'infinity' }, 'EURUSD'), null);
  assert.equal(instrumentGate({ challenge_type: 'infinity' }, 'XAUUSD'), null);
  assert.equal(instrumentGate({ challenge_type: 'infinity' }, 'NSXUSD'), null);
  assert.equal(instrumentGate({ challenge_type: 'futures', starting_balance: 100000 }, 'ES'), null);
});

test('picker and watchlist data contain no crypto category or coins', () => {
  const start = html.indexOf('const WL_DATA=') >= 0 ? html.indexOf('const WL_DATA=') : html.indexOf('const WL_DATA =');
  assert.ok(start >= 0);
  const end = html.indexOf('\n};', start) + 3;
  const data = vm.runInNewContext(html.slice(start, end) + '\nWL_DATA');
  assert.ok(!('crypto' in data));
  const symbols = Object.values(data).flat().map(i => i.sym.split(':').pop());
  for (const coin of coins) assert.ok(!symbols.includes(coin));
  assert.ok(symbols.includes('EURUSD') && symbols.includes('XAUUSD') && symbols.includes('ES'));
});

test('saved crypto pending orders reject even without quotes or risk readiness', async () => {
  const start = engine.indexOf('async function processPendingOrders(');
  const end = engine.indexOf('\n}\n', start) + 3;
  const process = new Function('INSTRUMENTS', 'isTradableAccount', stripTypeScriptTypes(engine.slice(start, end)) + '\nreturn processPendingOrders;')(INSTRUMENTS, () => true);
  const updates = [];
  const db = { from: () => ({
    select() { return this; }, eq() { return this; }, order() { return this; },
    then(resolve) { return Promise.resolve({ data: coins.map((symbol, id) => ({ id, symbol })) }).then(resolve); },
    update(row) { updates.push(row); return { eq() { return this; } }; },
  }) };
  assert.deepEqual(await process(db, { id: 'test' }, [], 10000, false), []);
  assert.equal(updates.length, 6);
  for (const row of updates) {
    assert.equal(row.status, 'rejected');
    assert.match(row.reject_reason, /Crypto trading is not available/);
  }
});

test('both entry actions call the gate and legacy position specifications remain available', () => {
  for (const action of ['place_pending', 'open']) {
    const start = engine.indexOf(`if (action === "${action}")`);
    assert.ok(engine.slice(start, start + 3800).includes('instrumentGate(acct as Acct, symbol)'));
  }
  for (const coin of coins) assert.equal(INSTRUMENTS[coin].contract, 1);
});
