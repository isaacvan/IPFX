// Big Build step 2: quiet prices stay fresh through the hub, so pages stop asking the engine for a price every 0.75s.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const engine = read('supabase/functions/trading-engine/index.ts'), hub = read('hub/server.mjs'), page = read('trading.html');

test('engine: heartbeat rows become hub quotes (fresh received time, same price); moved symbols are not duplicated', () => {
  const a = engine.indexOf('function heartbeatQuotes'), b = engine.indexOf('function ticksToStore');
  const js = engine.slice(a, b).replace(/: Record<string, unknown>\[\]/g, '').replace(/: \{ symbol: string \}\[\]/g, '').replace(/: Quote\[\]/g, '');
  const ctx = {}; vm.createContext(ctx); vm.runInContext(js + '\nglobalThis.f = heartbeatQuotes;', ctx);
  const now = '2026-10-26T08:00:01.500Z';
  const rows = [
    { symbol: 'EURUSD', bid: 1.1, ask: 1.1002, mid: 1.1001, spread: 0.0002, provider_ts: '2026-10-26T07:59:50Z', feed_ts: now, received_at: now, source: 'ctrader' },
    { symbol: 'XAUUSD', bid: 4100, ask: 4100.4, mid: 4100.2, spread: 0.4, provider_ts: null, feed_ts: now, received_at: now, source: 'ctrader' },
    { symbol: 'GBPUSD', bid: 0, ask: 1.3, mid: 0.65, spread: 1.3, received_at: now },
  ];
  const out = ctx.f(rows, [{ symbol: 'XAUUSD' }]);
  assert.equal(out.length, 1, 'XAUUSD already goes as a real move; a bad row is dropped');
  assert.equal(out[0].symbol, 'EURUSD'); assert.equal(out[0].receivedTs, Date.parse(now)); assert.equal(out[0].bid, 1.1);
  assert.match(engine, /const hubBatch = changed\.concat\(heartbeatQuotes\(rows\.length \? rowsToWrite\(rows, changed, hubBeatAt, now\) : \[\], changed\)\);\n\s*if \(hubBatch\.length\) pushToHub\(hubBatch\);/);
});

test('hub: a re-confirmed price refreshes screens but only a price move is recorded as a chart tick', () => {
  assert.match(hub, /if \(!previous \|\| previous\.m !== q\.m\) ticks\.add\(q\.s, q\.rt, q\.m\);/);
});

function due({ hubLive = true, hubRisk = true, pushedAgo = 500, exposed = false, feedState = 'live', idleMs = 1000, rt = null } = {}) {
  const a = page.indexOf('function ticketPollDue(){'), b = page.indexOf('let lastPushedQuoteAt=0;');
  const now = 1_800_000_000_000;
  const ctx = { Date: { now: () => now }, feedState, rtQuoteChan: rt, hubRisk, hubLive: () => hubLive, lastPushedQuoteAt: now - pushedAgo,
    engineState: { open_trades: exposed ? [{}] : [], pending_orders: [] }, lastUserActivity: now - idleMs, lastTicketPoll: 0 };
  vm.createContext(ctx); vm.runInContext(page.slice(a, b) + '\nglobalThis.check = (since) => { lastTicketPoll = Date.now() - since; return ticketPollDue(); };', ctx);
  // the smallest interval (ms) at which a poll becomes due
  for (const ms of [750, 2250, 3000, 10000, 15000, 30000, 60000]) if (ctx.check(ms)) return ms;
  return Infinity;
}

test('poll schedule: hub streaming + watcher active = 30s with positions / 60s without; anything wrong falls back to the fast schedule', () => {
  assert.equal(due({ exposed: true }), 30000);
  assert.equal(due({ exposed: false }), 60000);
  assert.equal(due({ exposed: true, hubRisk: false }), 2250, 'hub watcher not active: the page keeps its own fast risk check');
  assert.equal(due({ exposed: false, hubRisk: false }), 15000);
  assert.equal(due({ exposed: true, hubLive: false, pushedAgo: 60_000 }), 750, 'no hub, no pushes: full speed, exactly as before');
  assert.equal(due({ exposed: true, pushedAgo: 4000 }), 750, 'prices stopped arriving for 3s+: full speed');
  assert.equal(due({ feedState: 'closed' }), 60000, 'market closed with the hub connected');
  assert.equal(due({ feedState: 'closed', hubLive: false }), 10000, 'market closed without the hub: as before');
});

test('watchlist: with the hub live and conversions fresh, one engine check every 2 minutes (4s when a conversion is stale)', () => {
  assert.ok(page.includes("if(hubLive()&&Date.now()-lastWlPoll<(conversions.some(s=>!clientQuoteFresh(liveQuotesBySymbol.get(s)))?4000:120000))return;"));
});

test('the price feed never waits on the database, and the hub restarts the pump if the database scheduler stalls', () => {
  assert.match(engine, /if \(!\(\(expected && secret === expected\) \|\| hubSecretOk\(req\.headers\.get\("x-hub-secret"\)\)\)\) return err\("Not authorized", 401\);/);
  assert.doesNotMatch(engine, /await refreshWatched\(db\)/, 'no database read blocks a price tick');
  assert.match(engine, /if \(changed\.length\) broadcastQuotes\(changed\)\.catch\(\(\) => \{\}\);/);
  assert.match(engine, /dbWriteBusy = true;\n\s*Promise\.all\(\[/, 'database writes run behind the prices, one batch at a time');
  assert.doesNotMatch(engine.slice(engine.indexOf('const hubBatch'), engine.indexOf('pushed += changed.length;')), /await /, 'nothing awaited between a price and the hub');
  assert.match(hub, /if \(now - lastIngestAt < 4000 \|\| now - lastPumpKick < 9000\) return;/);
  assert.match(hub, /engine\(\{ action: 'pump', duration_ms: 11000 \}\)/);
});

test('the pump starts even when the database is slow: start-up reads give up after 1.5s and the TradeLocker lease starts in the background', () => {
  const a = engine.indexOf('async function runQuotePump'), b = engine.indexOf('while (Date.now() < until)', a);
  const startup = engine.slice(a, b);
  assert.doesNotMatch(startup, /await db\.from\(/, 'no plain database read before the first price');
  assert.equal((startup.match(/await quickRead/g) || []).length, 4, 'config, cTrader reservations, TradeLocker reservations, seed');
  assert.match(engine, /const cfg = fresh \?\? lastFeedCfg;/);
  assert.match(engine, /TradeLockerFeed\.start\(db, feedMode, feedConn, runId, until\)\.then\(\(f\) => \{ tl = f; \}\)/);
  assert.doesNotMatch(engine, /tl = await TradeLockerFeed\.start/);
});

test('quickRead returns the data, or null after the timeout, and never throws', async () => {
  const a = engine.indexOf('async function quickRead'), b = engine.indexOf('async function runQuotePump');
  const js = engine.slice(a, b).replace(/<T>/g, '').replace(/: PromiseLike<\{ data: T \| null \}>/g, '').replace(/: Promise<T \| null>/g, '').replace(/new Promise<null>/g, 'new Promise');
  const ctx = { setTimeout, Promise }; vm.createContext(ctx); vm.runInContext(js + '\nglobalThis.q = quickRead;', ctx);
  assert.deepEqual(await ctx.q(Promise.resolve({ data: { a: 1 } })), { a: 1 });
  assert.equal(await ctx.q(new Promise(() => {}), 20), null, 'a hung database read gives up');
  assert.equal(await ctx.q(Promise.reject(new Error('x'))), null);
});
