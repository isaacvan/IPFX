// Bitcoin is on the watchlist (price + chart) but can never be ordered: page guards on top of the engine and database rules.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const page = read('trading.html'), guided = read('assets/js/markets-guided.js'), engine = read('supabase/functions/trading-engine/index.ts');
const migration = read('supabase/migrations/20261008223000_disable_ipfx_crypto.sql');

test('Bitcoin appears under a Crypto tab on the watchlist, with no placeholder price', () => {
  assert.match(page, /data-cat="crypto" onclick="setWlCat\('crypto',this\)">Crypto</);
  assert.match(page, /crypto:\[\n\s*\{sym:'CRYPTO:BTCUSD',name:'Bitcoin',base:0,d:2,sp:25\},\n\s*\],/);
  assert.match(page, /BTCUSD:2,ETHUSD:2/, 'price digits already known');
});

function gate() {
  const a = page.indexOf('const VIEW_ONLY_SYMBOLS'), b = page.indexOf('async function engineCall');
  const ctx = { activeSym: 'EURUSD', execSymbol: (r) => String(r || '').toUpperCase().replace(/^[A-Z]+:/, '').replace(/[^A-Z0-9]/g, ''), Set };
  vm.createContext(ctx); vm.runInContext(page.slice(a, b) + '\nglobalThis.v = viewOnlyReason;', ctx); return ctx.v;
}
test('only Bitcoin is view-only; every other instrument is unaffected', () => {
  const v = gate();
  for (const s of ['BTCUSD', 'CRYPTO:BTCUSD', 'btcusd', 'OANDA:BTCUSD']) assert.match(v(s), /Bitcoin is view-only/, s);
  for (const s of ['EURUSD', 'OANDA:XAUUSD', 'FOREXCOM:NSXUSD', 'CME:ES', 'ETHUSD']) assert.equal(v(s), null, s);
});

test('every order path stops at the page: market ticket, quick ticket and keyboard shortcuts (placeOrder), and any open/pending call (engineCall)', () => {
  assert.match(page, /async function placeOrder\(side\)\{\n\s*\{const why=typeof viewOnlyReason==='function'\?viewOnlyReason\(activeSym\):null;if\(why\)\{engineMsg\(why\);return;\}\}/);
  assert.match(page, /async function engineCall\(body\)\{\n\s*if\(\['open','place_pending'\]\.includes\(body\.action\)\)\{\n\s*const why=typeof viewOnlyReason==='function'\?viewOnlyReason\(body\.symbol\):null;\n\s*if\(why\)\{engineMsg\(why\);return null;\}/);
  assert.match(page, /const stale=!feedFresh\(\)\|\|viewOnly;/, 'Buy and Sell look off');
});

test('the protected ticket lists view-only first so it is the reason shown, and does not change the usual summary line', () => {
  assert.match(guided, /if \(viewOnly\) out\.unshift\(\{ ok: false, text: 'View-only instrument', why: viewOnly \}\);/);
});

test('the server still refuses crypto: engine gate on open and pending orders, and a database rule on every new trade', () => {
  assert.match(engine, /if \(INSTRUMENTS\[symKey\]\?\.cls === "crypto"\) return "Crypto trading is not available on IPFX Markets\.";/);
  assert.match(engine, /INSTRUMENTS\[String\(o\.symbol\)\]\?\.cls === "crypto"/);
  assert.equal((engine.match(/instrumentGate\(acct as Acct, symbol\)/g) || []).length, 2, 'market and pending order paths');
  assert.match(migration, /create trigger ipfx_no_crypto_trade before insert on public\.trades/);
});
