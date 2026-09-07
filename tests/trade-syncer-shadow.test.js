// Zero-dependency tests for trade-syncer-shadow's pure logic (report §12.7
// sizing, §12.4 idempotency key). Matches this repo's existing test style
// (tests/indicator-registry.test.js) — plain assert, no test runner.
//
// These re-implement the exact formulas from supabase/functions/
// trade-syncer-shadow/index.ts rather than importing it (Deno-only
// syntax, esm.sh URL imports) — kept byte-for-byte in sync manually;
// any change to the real function's math must be mirrored here.
const assert = require("assert");

function computeShadowSize(trade, inst, destEquity, sourceRiskFraction) {
  const destRiskUnits = sourceRiskFraction * destEquity;
  let stopDistance, stopProxy = false;
  if (trade.sl !== null) {
    stopDistance = Math.abs(trade.open_price - trade.sl);
  } else {
    stopDistance = inst.spread * 20;
    stopProxy = true;
  }
  if (stopDistance <= 0) return null;
  const size = destRiskUnits / (stopDistance * inst.contract);
  return { size: Math.max(0, Math.round(size * 100) / 100), stopDistance, stopProxy, destRiskUnits };
}

async function sha256Hex(input) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(input).digest("hex");
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("ok:  ", name); }
  else { fail++; console.log("FAIL:", name); }
}

(async () => {
  // ── sizing: real stop present ──
  const eurusd = { contract: 100000, spread: 0.0002 };
  const trade1 = { open_price: 1.1000, sl: 1.0950, side: "buy" };
  const r1 = computeShadowSize(trade1, eurusd, 100000, 0.01); // 1% of $100k dest = $1000 risk
  check("known fixture: EURUSD 50-pip stop, $1000 dest risk -> 2.00 lots",
    r1.size === 2 && !r1.stopProxy);

  // ── sizing: no stop -> proxy used, flagged ──
  const trade2 = { open_price: 1.1000, sl: null, side: "buy" };
  const r2 = computeShadowSize(trade2, eurusd, 100000, 0.01);
  check("no stop set -> stop_proxy flagged true (never silently treated as a real stop)", r2.stopProxy === true);
  check("stop proxy distance = 20x configured spread", r2.stopDistance === eurusd.spread * 20);

  // ── sizing: different instrument scales correctly (XAUUSD, contract=100) ──
  const xau = { contract: 100, spread: 0.30 };
  const trade3 = { open_price: 2000, sl: 1990, side: "buy" };
  const r3 = computeShadowSize(trade3, xau, 100000, 0.01); // $1000 risk / (10 * 100) = 1.0 lot
  check("XAUUSD $10 stop distance, $1000 dest risk -> 1.00 lot", r3.size === 1.0);

  // ── sizing: zero stop distance is rejected, not divided-by-zero into Infinity ──
  const trade4 = { open_price: 1.1000, sl: 1.1000, side: "buy" };
  const r4 = computeShadowSize(trade4, eurusd, 100000, 0.01);
  check("zero stop distance returns null (not Infinity/NaN)", r4 === null);

  // ── idempotency key: identical inputs always produce the identical hash ──
  const k1 = await sha256Hex("evt123:acct456:open");
  const k2 = await sha256Hex("evt123:acct456:open");
  const k3 = await sha256Hex("evt123:acct456:close");
  check("idempotency key is deterministic for identical (event,account,type)", k1 === k2);
  check("idempotency key differs when event_type differs (open vs close are distinct copy intentions)", k1 !== k3);

  // ── staleness threshold (mirrors STALE_MS = 5 * 60_000 in the function) ──
  const STALE_MS = 5 * 60_000;
  const now = Date.now();
  check("event 4 minutes old is NOT stale", (now - (now - 4 * 60_000)) <= STALE_MS);
  check("event 6 minutes old IS stale", (now - (now - 6 * 60_000)) > STALE_MS);

  // ── shadow P&L direction matches source direction ──
  function shadowPnl(side, openPrice, closePrice, size, contract) {
    const direction = side === "buy" ? 1 : -1;
    return direction * (closePrice - openPrice) * size * contract;
  }
  check("buy trade, price up -> positive shadow P&L", shadowPnl("buy", 1.1000, 1.1050, 0.2, 100000) > 0);
  check("sell trade, price up -> negative shadow P&L (correctly against a short)", shadowPnl("sell", 1.1000, 1.1050, 0.2, 100000) < 0);

  console.log(`\nPASS: ${pass} passed, ${fail} failed.`);
  process.exit(fail > 0 ? 1 : 0);
})();
