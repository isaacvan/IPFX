// A trader closed a position that was copied to the real E8 account. The copy leg took ~30s to confirm, the browser gave up
// at 15s, the trader clicked again, and the second request answered "This position was already closed" although the first
// was about to succeed. A close must never show that error when the position is closed or is being closed.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
const engine = fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../trading.html', import.meta.url), 'utf8');
const closeBlock = engine.slice(engine.indexOf('} else if (action === "close") {'), engine.indexOf('} else if (action === "close_all") {'));

test('server: a second close of the same position says what happened instead of "already closed"', () => {
  const at = closeBlock.indexOf('if (!done) {');
  assert.ok(at > 0, 'the false result of closeTrade is handled explicitly');
  const handler = closeBlock.slice(at);
  // closed meanwhile: fall through to the normal fresh-state reply (no error)
  assert.match(handler, /else if \(now\?\.status !== "closed"\) return err\("This position was already closed/);
  // still finishing: tell the client
  assert.match(handler, /now\?\.status === "open" && now\.close_requested_at\) closingInProgress = true/);
  // the honest 409 is only for a position that is neither closed nor being closed
  assert.equal((handler.match(/return err\(/g) || []).length, 1);
  assert.match(engine, /\.\.\.\(closingInProgress \? \{ closing: true \} : \{\}\)/);
});

test('browser: a close waits long enough, tells the trader it is working, and does not click again for them', () => {
  assert.match(html, /\['close','close_all','partial_close'\]\.includes\(body\.action\)\?60000:15000/);
  const fn = html.slice(html.indexOf('async function closeTradeById(id){'), html.indexOf('function closePosition()'));
  assert.match(fn, /Closing your position… confirming it with the broker/);
  assert.match(fn, /if\(r&&r\.closing\)/);
  assert.match(fn, /\[3000,8000,15000\]\.forEach\(ms=>setTimeout\(\(\)=>\{engineCall\(\{action:'state'\}\);\},ms\)\)/);
  assert.ok(fn.indexOf('clearTimeout(slow)') > fn.indexOf('engineCall({action:\'close\''), 'the progress message is cancelled when the reply arrives');
  assert.ok(fn.indexOf('if(engineBusy)return false;') >= 0, 'a click while a close is in flight is ignored');
});

test('behaviour: the client treats a "closing" reply as success, not an error', async () => {
  // Run the real closeTradeById with the page globals stubbed.
  const src = html.slice(html.indexOf('async function closeTradeById(id){'), html.indexOf('function closePosition()'));
  const msgs = [], calls = [], timers = [];
  const ctx = { engineBusy: false, omFindTrade: () => ({ id: 'T', symbol: 'EURUSD' }), quickCloseConfirm: async () => true,
    engineCall: async (b) => { calls.push(b.action); return b.action === 'close' ? { ok: true, closing: true } : { ok: true }; },
    engineMsg: (m) => msgs.push(m), execSymbol: (s) => s, fmtPx: String, signedMoney: String,
    setTimeout: (fn, ms) => { timers.push(ms); return timers.length; }, clearTimeout() {} };
  const run = new Function(...Object.keys(ctx), `${src}; return closeTradeById;`)(...Object.values(ctx));
  assert.equal(await run('T'), true);
  assert.deepEqual(calls, ['close']);
  assert.ok(msgs.some((m) => /already being processed/.test(m)));
  assert.ok(!msgs.some((m) => /already closed/.test(m)));
  assert.deepEqual(timers.slice(-3), [3000, 8000, 15000], 'it re-reads the account three times so the position disappears on its own');
});
