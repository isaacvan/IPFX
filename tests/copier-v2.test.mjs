// Copier v2 (owner request 2026-11-26): engine -> hub copier -> IBKR bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Copier, commissionPips, settle, limitFill, entryLimit } from '../hub/copier.mjs';
import { parseCalendar, blackout } from '../hub/news.mjs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SETTINGS = { mode: 'shadow', entry_tolerance_pips: 0.3, fill_timeout_ms: 1500, news_window_s: 120, modelled_latency_ms: 400, copy_ratio: 1, max_lots_per_order: 1, max_open_copies: 10 };
const EURUSD = { symbol: 'EURUSD', enabled: true, pip: 0.0001, tolerance_pips: null, extra_spread_pips: 0.3, stop_slippage_pips: 0.3, commission_rate: 0.00002, commission_min_usd: 2, news_currencies: ['EUR', 'USD'], broker_symbol: 'EUR', broker_sec_type: 'CASH', broker_exchange: 'IDEALPRO', broker_currency: 'USD' };

function rig({ settings = SETTINGS, events = [] } = {}) {
  let t = 1_000_000;
  const quotes = new Map(), saved = [];
  const news = { check: (cur, at, w) => blackout(events, cur, at, w), summary: () => ({}) };
  const c = new Copier({ quotes, rpc: async (n, a) => { saved.push([n, a]); return null; }, log: () => {}, news, now: () => t });
  c.applyConfig({ settings, symbols: [EURUSD], qualified: [U(9)], open: [] });
  const q = (b, a) => quotes.set('EURUSD', { s: 'EURUSD', b, a, rt: t });
  const advance = (ms) => { for (let i = 0; i < ms; i += 50) { t += 50; c.tick(); } };
  return { c, q, advance, saved, now: () => t };
}
const openEv = (over = {}) => ({ k: 'open', id: U(1), u: U(2), a: U(3), s: 'EURUSD', sd: 'buy', v: 1, p: 1.1, sl: 1.098, tp: 1.104, sc: 100000, ct: 100000, ...over });

test('costs: commission has a per-order minimum, so small copies pay far more per pip', () => {
  assert.equal(Math.round(commissionPips({ lots: 1, price: 1.1, scale: 100000, rate: 0.00002, minUsd: 2, pip: 0.0001 }) * 100) / 100, 0.44);
  assert.equal(commissionPips({ lots: 0.1, price: 1.1, scale: 100000, rate: 0.00002, minUsd: 2, pip: 0.0001 }), 4);
  const s = settle({ side: 'buy', pip: 0.0001, traderOpen: 1.1, traderClose: 1.101, copyOpen: 1.10002, copyClose: 1.10098, extraSpreadPips: 0.3, commission: 0.44 });
  assert.deepEqual([s.trader_pips, s.entry_slip_pips, s.exit_slip_pips, s.cost_pips, s.copy_pips], [10, 0.2, 0.2, 1.14, 8.86]);
});
test('entry limits: trader fill plus tolerance; a buy fills at the ask only at or under the limit', () => {
  assert.equal(entryLimit('buy', 1.1, 0.3, 0.0001).toFixed(5), '1.10003');
  assert.equal(entryLimit('sell', 1.1, 0.3, 0.0001).toFixed(5), '1.09997');
  assert.equal(limitFill('buy', 1.10003, { b: 1.1, a: 1.10002 }), 1.10002);
  assert.equal(limitFill('buy', 1.10003, { b: 1.10002, a: 1.10004 }), null);
  assert.equal(limitFill('sell', 1.09997, { b: 1.09998, a: 1.1 }), 1.09998);
});

test('shadow: a market copy fills after the modelled latency, then a manual close is priced after the latency too', () => {
  const r = rig();
  r.q(1.09998, 1.1);
  r.c.onIntent(openEv({ te: r.now() }));
  const row = r.c.rows.get(`${U(1)}:shadow`);
  assert.equal(row.entry_status, 'skipped');           // not decided before the latency has passed
  r.advance(400);
  assert.equal(row.entry_status, 'filled'); assert.equal(row.copy_open, 1.1);
  r.q(1.101, 1.10102);
  r.c.onIntent({ k: 'close', id: U(1), p: 1.101, r: 'manual', te: r.now() });
  r.advance(450);
  assert.ok(row.closed_at);
  assert.equal(row.trader_pips, 10);
  assert.equal(row.copy_close, 1.101);
  assert.equal(row.commission_pips, 0.44);
  assert.equal(row.cost_pips, 0.74);                     // 0 slippage + 0.3 extra spread + 0.44 commission
  assert.equal(row.copy_pips, 9.26);
});
test('shadow: if price runs away beyond the tolerance within the timeout, the copy is missed (never chased)', () => {
  const r = rig();
  r.q(1.1001, 1.1002);                                  // 2 pips above the trader's fill
  r.c.onIntent(openEv({ te: r.now() }));
  r.advance(2000);
  const row = r.c.rows.get(`${U(1)}:shadow`);
  assert.equal(row.entry_status, 'missed');
  r.c.onIntent({ k: 'close', id: U(1), p: 1.103, r: 'manual', te: r.now() });
  assert.equal(row.trader_pips, 30); assert.equal(row.copy_pips, 0);
});
test('shadow: high-impact news within 2 minutes skips the copy', () => {
  const r = rig({ events: [{ at: 1_000_000 + 60_000, cur: 'USD', title: 'Non-Farm Payrolls' }] });
  r.q(1.09998, 1.1);
  r.c.onIntent(openEv({ te: r.now() }));
  const row = r.c.rows.get(`${U(1)}:shadow`);
  assert.match(row.skip_reason, /^news:USD Non-Farm Payrolls/);
  r.advance(500);
  assert.equal(row.entry_status, 'skipped');
});
test('shadow: a copied pending order rests at the broker, so it fills at its trigger with no latency cost', () => {
  const r = rig();
  r.c.onIntent({ k: 'pending', id: U(5), u: U(2), a: U(3), s: 'EURUSD', sd: 'buy', v: 1, p: 1.095, ot: 'limit', sc: 100000, ct: 100000 });
  r.c.onIntent(openEv({ pid: U(5), p: 1.09498, te: r.now() }));
  const row = r.c.rows.get(`${U(1)}:shadow`);
  assert.equal(row.entry_status, 'filled'); assert.equal(row.copy_open, 1.095); assert.equal(row.latency.entry, 'resting');
});
test('shadow: a stop-loss exit rests at the broker and slips; a take-profit does not', () => {
  const r = rig();
  r.q(1.09998, 1.1);
  r.c.onIntent(openEv({ te: r.now() })); r.advance(400);
  r.c.onIntent({ k: 'close', id: U(1), p: 1.098, r: 'sl', sl: 1.098, te: r.now() });
  const row = r.c.rows.get(`${U(1)}:shadow`);
  assert.equal(row.copy_close.toFixed(5), '1.09797'); assert.equal(row.exit_slip_pips, 0.3);
});
test('paper: refused without a paper bridge; a bridge that is not a paper account is disconnected', () => {
  const r = rig({ settings: { ...SETTINGS, mode: 'paper' } });
  r.q(1.09998, 1.1);
  r.c.onIntent(openEv({ u: U(9), te: r.now() }));
  assert.equal(r.c.rows.has(`${U(1)}:paper`), false);  // no bridge: shadow only
  let closed = null; const ws = { readyState: 1, send() {}, close(code) { closed = code; } };
  assert.equal(r.c.attachBridge(ws, { paper: true, account: 'U1234567' }), false);
  assert.equal(closed, 4403);
  const sent = []; const ok = { readyState: 1, send: (m) => sent.push(JSON.parse(m)), close() {} };
  assert.equal(r.c.attachBridge(ok, { paper: true, account: 'DU1234567' }), true);
  r.c.onIntent(openEv({ id: U(7), u: U(9), te: r.now() }));
  const entry = sent.find((m) => m.t === 'entry');
  assert.equal(entry.id, U(7)); assert.equal(entry.units, 100000); assert.equal(entry.timeout_ms, 1500); assert.equal(entry.limit.toFixed(5), '1.10003');
  r.c.onIntent(openEv({ id: U(8), u: U(2), te: r.now() }));            // not qualified: shadow only
  assert.equal(sent.filter((m) => m.t === 'entry').length, 1);
  r.c.onBridge({ t: 'entry_filled', id: U(7), px: 1.10001, qty: 100000, submit_ts: 1, ack_ts: 2, fill_ts: 3 });
  assert.equal(r.c.rows.get(`${U(7)}:paper`).entry_status, 'filled');
});
test('the public health summary never shows the broker account number', () => {
  const r = rig({ settings: { ...SETTINGS, mode: 'paper' } });
  r.c.attachBridge({ readyState: 1, send() {}, close() {} }, { paper: true, account: 'DU7654321' });
  assert.doesNotMatch(JSON.stringify(r.c.summary()), /DU7654321/);
});
test('news calendar: only high impact, by currency, within the window', () => {
  const ev = parseCalendar([{ title: 'CPI', country: 'USD', date: '2026-11-26T13:30:00-05:00', impact: 'High' }, { title: 'Speech', country: 'EUR', date: '2026-11-26T13:30:00-05:00', impact: 'Low' }]);
  assert.equal(ev.length, 1);
  assert.equal(blackout(ev, ['EUR', 'USD'], ev[0].at - 100_000, 120)?.title, 'CPI');
  assert.equal(blackout(ev, ['EUR', 'USD'], ev[0].at - 130_000, 120), null);
  assert.equal(blackout(ev, ['GBP', 'JPY'], ev[0].at, 120), null);
});

test('engine: every trade event goes to the hub copier without waiting, Infinity accounts only', () => {
  const e = read('supabase/functions/trading-engine/index.ts');
  for (const k of ['open', 'pending', 'pending_cancel', 'modify', 'close', 'partial']) assert.match(e, new RegExp(`copyEmit\\([^;]*k: "${k}"`), k);
  assert.doesNotMatch(e, /await copyEmit/);
  assert.match(e, /function copyEmit\([^)]*\) \{\n  if \(!inBrainScope\(acct\)\) return;/);
  assert.match(e, /\.catch\(\(\) => \{ \/\* the copier is never allowed to affect an order \*\/ \}\)/);
});
test('database: live mode is impossible; the hub reads and writes only through secret-checked functions', () => {
  const m = read('supabase/migrations/20261126120000_copier_v2_ibkr.sql');
  assert.match(m, /mode text not null default 'shadow' check \(mode in \('off', 'shadow', 'paper'\)\)/);
  assert.match(m, /if not public\.hub_check\(p_secret\) then raise exception 'not authorised'/);
  assert.match(m, /t\.avg_trader_pips >= s\.min_edge_multiple \* t\.avg_cost_pips/);
  assert.match(m, /t\.copy_pip_lots >= s\.min_capture \* t\.trader_pip_lots/);
});
test('bridge: paper accounts only, entries are limit orders that are cancelled after the timeout, exits rest as an OCA pair', () => {
  const b = read('bridge/ibkr_copier.py');
  assert.match(b, /a\.upper\(\)\.startswith\(\("DU", "DF"\)\)/);
  assert.match(b, /order = LimitOrder\("BUY" if side == "buy" else "SELL", units, px, tif="DAY"/);
  assert.match(b, /self\.ib\.cancelOrder\(c\.entry\.order\)      # the rest is not chased/);
  assert.match(b, /ocaGroup=group, ocaType=1/);
  const entryFn = b.slice(b.indexOf('async def entry'), b.indexOf('async def rest'));
  assert.doesNotMatch(entryFn, /MarketOrder/);
});
