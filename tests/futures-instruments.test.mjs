import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const engine = read('supabase/functions/trading-engine/index.ts').replace(/\r\n/g, '\n');
const admin = read('supabase/functions/admin-console/index.ts');
const syncer = read('supabase/functions/trade-syncer-shadow/index.ts');
const html = read('trading.html');
const migration = read('supabase/migrations/20260919130000_cme_futures_symbols.sql');

// symbol -> { digits, contract, max }
const fromEngine = {};
for (const m of engine.matchAll(/\b([A-Z0-9]+):\s*F\("([A-Z0-9]+)=F",\s*(\d+),\s*([\d.]+),\s*([\d.]+),\s*(\d+)\)/g)) {
  assert.equal(m[1], m[2], `engine key ${m[1]} must match its Yahoo code ${m[2]}`);
  fromEngine[m[1]] = { digits: +m[3], spread: +m[4], contract: +m[5], max: +m[6] };
}
const SYMBOLS = Object.keys(fromEngine);

test('the engine defines all 15 CME contracts with the correct multipliers', () => {
  const expected = { ES: 50, MES: 5, NQ: 20, MNQ: 2, YM: 5, MYM: 0.5, RTY: 50, M2K: 5, CL: 1000, MCL: 100, GC: 100, MGC: 10, NG: 10000, ZB: 1000, ZN: 1000 };
  assert.deepEqual(Object.fromEntries(SYMBOLS.map((s) => [s, fromEngine[s].contract])), expected);
});

test('micro contracts are exactly one tenth of the full-size contract', () => {
  for (const [micro, full] of [['MES', 'ES'], ['MNQ', 'NQ'], ['MYM', 'YM'], ['M2K', 'RTY'], ['MCL', 'CL'], ['MGC', 'GC']]) {
    assert.equal(fromEngine[micro].contract * 10, fromEngine[full].contract, micro);
  }
});

test('admin firm-risk map agrees with the engine (else exposure is sized as forex)', () => {
  const block = [...admin.matchAll(/ES: 50, MES: 5[^\n]*/g)];
  assert.equal(block.length, 2, 'both firm-risk maps must include futures');
  for (const b of block) for (const s of SYMBOLS) assert.match(b[0], new RegExp(String.raw`\b${s}: ${fromEngine[s].contract}\b`), s);
});

test('trade syncer map agrees with the engine', () => {
  for (const s of SYMBOLS) {
    const m = syncer.match(new RegExp(String.raw`\b${s}: \{ digits: (\d+), contract: ([\d.]+)`));
    assert.ok(m, `${s} missing from trade-syncer-shadow`);
    assert.equal(+m[1], fromEngine[s].digits, `${s} digits`);
    assert.equal(+m[2], fromEngine[s].contract, `${s} contract`);
  }
});

test('trading screen specs agree with the engine', () => {
  for (const s of SYMBOLS) {
    const m = html.match(new RegExp(String.raw`\b${s}:\[([\d.]+),(\d+),(\d+)\]`));
    assert.ok(m, `${s} missing from trading.html FUT_SPECS`);
    assert.equal(+m[1], fromEngine[s].contract, `${s} contract`);
    assert.equal(+m[2], fromEngine[s].max, `${s} max contracts`);
    assert.equal(+m[3], fromEngine[s].digits, `${s} digits`);
    assert.match(html, new RegExp(String.raw`sym:'CME:${s}'`), `${s} watchlist entry`);
  }
});

test('database migration agrees with the engine', () => {
  for (const s of SYMBOLS) {
    const m = migration.match(new RegExp(String.raw`values\('${s}','[^']*','future',(\d+),([\d.]+),'USD',1,(\d+),1,`));
    assert.ok(m, `${s} missing from the symbol_specs migration`);
    assert.equal(+m[1], fromEngine[s].digits, `${s} digits`);
    assert.equal(+m[2], fromEngine[s].contract, `${s} contract`);
    assert.equal(+m[3], fromEngine[s].max, `${s} max volume`);
  }
  assert.match(migration, /'future'\]/, 'asset_class constraint must allow futures');
});

test('futures trade only on Futures accounts, in whole contracts, in CME hours', () => {
  assert.match(engine, /CME futures can only be traded on a Futures Challenge account/);
  assert.match(engine, /Futures Challenge accounts trade CME futures only/);
  assert.match(engine, /Volume must be a whole number of contracts/);
  assert.match(engine, /cls === "future"\) return futuresSessionOpen\(\)/);
  assert.equal((engine.match(/instrumentGate\(acct as Acct, symbol\)/g) || []).length, 2, 'gate must guard both market and pending orders');
  assert.equal((engine.match(/volumeError\(symbol, volume\)/g) || []).length, 2);
});

test('ZB and ZN are limited to $100K+ accounts, as advertised', () => {
  assert.match(engine, /ZB: 100_000, ZN: 100_000/);
});

// ---- behaviour: run the engine's own gate/volume functions (types stripped) ----
import { stripTypeScriptTypes } from 'node:module';
const start = engine.indexOf('const FUTURES_MIN_BALANCE');
const end = engine.indexOf('// ---------- price feed');
const chunk = engine.slice(start, engine.indexOf('\n}\n', engine.indexOf('function volumeError')) + 3);
const INSTRUMENTS = Object.fromEntries([
  ...SYMBOLS.map((s) => [s, { cls: 'future', maxContracts: fromEngine[s].max }]),
  ['EURUSD', { cls: 'forex' }], ['XAUUSD', { cls: 'metal' }],
]);
const { instrumentGate, volumeError } = new Function('INSTRUMENTS', stripTypeScriptTypes(chunk) + '\nreturn { instrumentGate, volumeError };')(INSTRUMENTS);

test('behaviour: futures instruments only on Futures accounts, and Futures accounts only trade futures', () => {
  assert.equal(instrumentGate({ challenge_type: 'futures', starting_balance: 25000 }, 'ES'), null);
  assert.match(instrumentGate({ challenge_type: 'traditional', starting_balance: 50000 }, 'ES'), /only be traded on a Futures Challenge/);
  assert.match(instrumentGate({ challenge_type: 'infinity', starting_balance: 1000 }, 'MNQ'), /only be traded on a Futures Challenge/);
  assert.match(instrumentGate({ challenge_type: 'futures', starting_balance: 25000 }, 'EURUSD'), /trade CME futures only/);
  assert.equal(instrumentGate({ challenge_type: 'traditional', starting_balance: 25000 }, 'EURUSD'), null);
});

test('behaviour: Treasuries need a $100K+ Futures account', () => {
  assert.match(instrumentGate({ challenge_type: 'futures', starting_balance: 50000 }, 'ZB'), /\$100K/);
  assert.equal(instrumentGate({ challenge_type: 'futures', starting_balance: 100000 }, 'ZN'), null);
  assert.equal(instrumentGate({ challenge_type: 'futures', starting_balance: 25000 }, 'NG'), null);
});

test('behaviour: futures volume must be a whole number of contracts within the cap', () => {
  assert.equal(volumeError('ES', 1), null);
  assert.equal(volumeError('ES', 20), null);
  assert.match(volumeError('ES', 21), /whole number of contracts, 1-20/);
  assert.match(volumeError('ES', 0.5), /whole number/);
  assert.match(volumeError('MES', 1.5), /whole number/);
  assert.equal(volumeError('MES', 100), null);
  assert.match(volumeError('MES', 101), /1-100/);
  assert.match(volumeError('ES', NaN), /whole number/);
});

test('behaviour: forex and metals keep the 0.01-100 lot rule', () => {
  assert.equal(volumeError('EURUSD', 0.01), null);
  assert.equal(volumeError('XAUUSD', 100), null);
  assert.match(volumeError('EURUSD', 0.001), /0.01/);
  assert.match(volumeError('EURUSD', 101), /0.01/);
});

test('sanity: 1 ES contract moving 1 point is worth $50; 1 MES is $5; 1 CL moving $1 is $1,000', () => {
  assert.equal(fromEngine.ES.contract * 1, 50);
  assert.equal(fromEngine.MES.contract * 1, 5);
  assert.equal(fromEngine.CL.contract * 1, 1000);
});
