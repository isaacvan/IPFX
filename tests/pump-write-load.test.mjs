// Disk I/O budget: the quote pump writes a symbol's row when its price changed (plus a heartbeat), not every symbol on every tick.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const e = fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts', import.meta.url), 'utf8');
const a = e.indexOf('const ROW_HEARTBEAT_MS'), b = e.indexOf('async function pumpFxcmOnce');
const js = e.slice(a, b).replace(/: Record<string, unknown>\[\]/g, '').replace(/: \{ symbol: string \}\[\]/g, '').replace(/: Map<string, number>/g, '').replace(/: number/g, '').replace(/: Set<string>/g, '');
const ctx = {}; vm.createContext(ctx); vm.runInContext(js + '\nglobalThis.api = { rowsToWrite, ROW_HEARTBEAT_MS };', ctx);
const { rowsToWrite, ROW_HEARTBEAT_MS } = ctx.api;
const T0 = 1.79e12; // real clock values, like Date.now()
const rows = (...s) => s.map((symbol) => ({ symbol }));

test('first tick writes every symbol; unchanged symbols are then skipped until the heartbeat', () => {
  const last = new Map(), all = rows('EURUSD', 'XAUUSD', 'GBPUSD');
  assert.equal(rowsToWrite(all, [], last, T0).length, 3, 'seeds every row');
  assert.equal(rowsToWrite(all, [], last, T0 + 250).length, 0, 'nothing moved, 250ms later: no write');
  assert.equal(rowsToWrite(all, [], last, T0 + ROW_HEARTBEAT_MS - 1).length, 0);
  assert.equal(rowsToWrite(all, [], last, T0 + ROW_HEARTBEAT_MS).length, 3, 'heartbeat keeps freshness alive');
});

test('a price change is written immediately, and only for the symbol that moved', () => {
  const last = new Map(), all = rows('EURUSD', 'XAUUSD', 'GBPUSD');
  rowsToWrite(all, [], last, T0);
  const w = rowsToWrite(all, [{ symbol: 'XAUUSD' }], last, T0 + 250);
  assert.deepEqual(w.map((r) => r.symbol), ['XAUUSD']);
  assert.equal(rowsToWrite(all, [{ symbol: 'XAUUSD' }], last, T0 + 500).length, 1, 'every move is written, none are dropped');
});

test('the heartbeat is far inside the engine freshness limits so prices never look stale', () => {
  const stale = Number(/const STALE_MS = ([\d_]+);/.exec(e)[1].replace(/_/g, '')), crypto = Number(/const STALE_MS_CRYPTO = ([\d_]+);/.exec(e)[1].replace(/_/g, ''));
  assert.ok(ROW_HEARTBEAT_MS * 4 <= stale && ROW_HEARTBEAT_MS * 4 <= crypto, `heartbeat ${ROW_HEARTBEAT_MS}ms vs stale limit ${stale}ms`);
});

test('the pump upserts only the filtered rows, keeps tick history and the Realtime/hub pushes unchanged', () => {
  assert.match(e, /const toWrite = rowsToWrite\(rows, changed, rowWrittenAt, Date\.now\(\)\);/);
  assert.match(e, /toWrite\.length \? db\.from\("live_quotes"\)\.upsert\(toWrite\) : null,/);
  assert.match(e, /broadcastQuotes\(changed\),/);
  assert.match(e, /db\.from\("quote_ticks"\)\.insert\(tickRows\.map/);
  assert.match(e, /if \(changed\.length\) pushToHub\(changed\);/);
});
