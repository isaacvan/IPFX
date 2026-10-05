// IPFX hub (hub.ipfxcapital.com): tick-by-tick position watcher, security wiring, engine hooks, page fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Risk } from '../hub/risk.mjs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const ACC = '11111111-1111-4111-8111-111111111111', ACC2 = '22222222-2222-4222-8222-222222222222';
const today = new Date().toISOString().slice(0, 10);

function make(mode = 'active') {
  const quotes = new Map(), calls = [];
  const r = new Risk({ quotes, mode, log: () => {}, rpc: async () => null, engine: async (b) => { calls.push(b); return { ok: true, results: [] }; } });
  r.specs = { EURUSD: { contract: 100000, quote: 'USD', digits: 5 }, USDJPY: { contract: 100000, quote: 'JPY', digits: 3 } };
  r.refreshAccount = async () => {};
  r.apply({
    sl_deadline_seconds: null,
    accounts: [
      { id: ACC, status: 'active', balance: 100000, starting_balance: 100000, max_drawdown_pct: 10, daily_loss_pct: 5, day_start_equity: 100000, day_start_date: today, drawdown_mode: 'static', total_paid_out: 0, challenge_type: 'infinity' },
      { id: ACC2, status: 'active', balance: 1000, starting_balance: 1000, max_drawdown_pct: 10, daily_loss_pct: 5, day_start_equity: 1000, day_start_date: today, drawdown_mode: 'static', total_paid_out: 0, challenge_type: 'demo' },
    ],
    trades: [
      { id: 't1', account_id: ACC, symbol: 'EURUSD', side: 'buy', volume: 1, open_price: 1.1, sl: 1.095, tp: 1.11, trail_distance: null, opened_at: new Date().toISOString() },
      { id: 't2', account_id: ACC2, symbol: 'EURUSD', side: 'sell', volume: 0.1, open_price: 1.1, sl: null, tp: null, trail_distance: null, opened_at: new Date().toISOString() },
    ],
    pending: [{ id: 'p1', account_id: ACC2, symbol: 'USDJPY', side: 'buy', order_type: 'limit', trigger_price: 150, expires_at: null }],
  }, null);
  const tick = (s, b, a) => { const q = { s, b, a, m: (a + b) / 2, at: Date.now() }; quotes.set(s, q); r.onQuote(q); };
  return { r, calls, tick };
}

test('stop loss, take profit and pending orders trigger a check of that account only', async () => {
  const { r, calls, tick } = make();
  tick('EURUSD', 1.1000, 1.1001);
  assert.equal(r.queue.size, 0, 'nothing crossed, nothing to check');
  tick('EURUSD', 1.0949, 1.0950);
  assert.deepEqual([...r.queue.entries()], [[ACC, 'stop_loss']]);
  await r.flush();
  assert.deepEqual(calls[0], { action: 'hub_enforce', account_ids: [ACC] });
  tick('USDJPY', 149.98, 149.99);
  assert.equal(r.queue.get(ACC2), 'pending_order');
});

test('loss limit: an account within 5% of its daily allowance of the floor is checked; demo accounts never', () => {
  const { r, tick } = make();
  r.trades.get('t1').sl = null; r.trades.get('t1').tp = null;
  tick('EURUSD', 1.0520, 1.0521);                // -4,800 USD: within 250 of the 95,000 daily floor
  assert.equal(r.queue.get(ACC), 'loss_limit');
  const l = r.limits(r.accounts.get(ACC));
  assert.equal(Math.round(l.equity), 95200); assert.equal(l.floor, 95000); assert.equal(l.band, 250);
  assert.equal(r.limits(r.accounts.get(ACC2)), null);
});

test('shadow mode counts what it would do but never calls the engine; cooldown stops repeat calls', async () => {
  const { r, calls, tick } = make('shadow');
  tick('EURUSD', 1.0949, 1.0950);
  tick('EURUSD', 1.0940, 1.0941);
  assert.equal(r.stats.triggers.stop_loss, 1, '2s cooldown per account');
  await r.flush();
  assert.equal(calls.length, 0);
});

test('P&L conversion matches the engine (JPY quote converted through USDJPY)', () => {
  const { r, tick } = make();
  tick('USDJPY', 150, 150.01);
  const pnl = r.pnl({ symbol: 'USDJPY', side: 'buy', volume: 1, open_price: 149 });
  assert.ok(Math.abs(pnl - (150 - 149) * 100000 / 150.005) < 1);
});

test('security: hub holds no service key; every hub call checks its own secret; prices never block the pump', () => {
  const server = read('hub/server.mjs'), risk = read('hub/risk.mjs');
  assert.doesNotMatch(server + risk, /service_role|SERVICE_ROLE/);
  assert.match(server, /timingSafeEqual/);
  assert.match(server, /fetch\(`\$\{SB_URL\}\/auth\/v1\/user`/, 'traders are verified by Supabase Auth');
  assert.match(server, /maxPayload: 8 \* 1024/);
  assert.match(server, /ws\.bufferedAmount > 512 \* 1024/, 'one slow phone cannot back up the hub');
  const sql = read('supabase/migrations/20261005120000_ipfx_hub.sql');
  for (const f of ['hub_snapshot', 'hub_watch', 'hub_heartbeat']) assert.match(sql, new RegExp(`if not public\\.hub_check\\(p_secret\\) then raise exception`));
  assert.doesNotMatch(sql, /vault\.create_secret/, 'the secret is set outside migrations (public repo)');
  const eng = read('supabase/functions/trading-engine/index.ts');
  assert.match(eng, /if \(!hubSecretOk\(req\.headers\.get\("x-hub-secret"\)\)\) return err\("Not authorized", 401\);/);
  assert.match(eng, /if \(changed\.length\) pushToHub\(changed\);/);
  assert.doesNotMatch(eng, /await pushToHub/);
  assert.ok(eng.indexOf('body.action === "hub_enforce"') < eng.indexOf('authClient.auth.getUser()'));
});

test('trading page: hub first, everything falls back when it drops; own checks relax only when the watcher is active', () => {
  const page = read('trading.html');
  assert.match(page, /const HUB_WS='wss:\/\/hub\.ipfxcapital\.com\/ws';/);
  assert.match(page, /ws\.onclose=\(\)=>\{hubOk=false;hubRisk=false;hubWs=null;/);
  assert.match(page, /if\(pushing&&hubRisk&&hubLive\(\)\)return since>=10000;/);
  assert.match(page, /hubRisk=m\.risk==='active'&&m\.rk===true&&m\.feed!=null&&m\.feed<5000;/);
  assert.match(page, /if\(hubLive\(\)&&Date\.now\(\)-lastWlPoll<30000\)return;/);
});

test('Brain: red alert when the hub stops reporting (a quiet feed only counts while the market is open)', () => {
  const sql = read('supabase/migrations/20261005130000_brain_hub_alert.sql');
  assert.match(sql, /'system:hub', 'critical'/);
  assert.match(sql, /where hb\.worker = 'hub' and \(hb\.at < now\(\) - interval '2 minutes' or \(not hb\.ok and public\.ab_fx_market_open\(\)\)\)/);
  assert.match(read('assets/js/team-brain.js'), /hub: 'IPFX hub \(live prices \+ position watcher\)'/);
  assert.match(read('hub/server.mjs'), /MAX_PER_IP = Number\(env\.MAX_PER_IP \|\| 30\)/, 'per-address connection limit stays on by default');
});

test('demo accounts: the 10s sweep and the hub enforce stops, targets and orders even when the trader is offline', () => {
  const eng = read('supabase/functions/trading-engine/index.ts');
  assert.equal((eng.match(/!\(isTradableAccount\(acct as Acct\) \|\| acct\.status === "breached"\)/g) || []).length, 2);
  assert.doesNotMatch(eng, /\["active", "breached"\]\.includes\(acct\.status\)/);
  assert.match(eng, /const isTradableAccount = \(acct: Acct\) => acct\.status === "active" \|\| isDemoAccount\(acct\);/);
});

test('the hub ignores accounts the engine would not act on (suspended / revoked, or not tradable)', () => {
  const { r, tick } = make('shadow');
  r.accounts.get(ACC).revoked = true;
  tick('EURUSD', 1.0949, 1.0950);
  assert.equal(r.queue.has(ACC), false);
  r.accounts.get(ACC).revoked = false; r.accounts.get(ACC).status = 'passed';
  tick('EURUSD', 1.0940, 1.0941);
  assert.equal(r.queue.has(ACC), false);
});
