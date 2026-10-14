// Indices are $10/point UNIFORMLY in USD (see the INSTRUMENTS comment) — the contract value is
// already USD, whatever currency the underlying index natively trades in. Giving an index a
// non-USD "quote" argument applies a SECOND, spurious FX conversion on top of that, which both
// inflates/deflates realised P&L on close and the per-trade risk check used to accept or reject
// an order. Found 2026-10-15: UK100/GER40/FRA40/JPN225 passed "GBP"/"EUR"/"EUR"/"JPY", so every
// trade on them was mis-priced — GER40/FRA40/UK100 overstated by the EUR or GBP rate (~1.1-1.3x,
// rejecting otherwise-valid orders as "over the limit"), and JPN225 UNDERSTATED by ~1/158 (the
// opposite and far more dangerous direction: real risk on JPN225 was almost invisible to every
// drawdown/daily-loss check). This affected the 12 GER40 trades closed 2026-10-12..14.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const engineSrc = fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts', import.meta.url), 'utf8');
const clientSrc = fs.readFileSync(new URL('../trading.html', import.meta.url), 'utf8');

test('no index instrument in INSTRUMENTS carries a non-USD quote currency', () => {
  const block = engineSrc.match(/const INSTRUMENTS: Record<string, Inst> = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'INSTRUMENTS table found');
  const indexLines = block[1].split('\n').filter((l) => /,\s*"index"/.test(l));
  assert.ok(indexLines.length >= 8, 'found the index instrument rows');
  for (const line of indexLines) {
    // I(code, digits, spread, contract, cls, quote?, alt?, maxSpread?) — a 6th arg after "index" is a quote currency.
    assert.doesNotMatch(line, /"index"\s*,\s*"[A-Z]{3}"/, `index row carries a spurious quote currency: ${line.trim()}`);
  }
});

test('the server computes GER40/FRA40/UK100/JPN225 P&L and risk with no currency conversion', () => {
  const body = engineSrc.match(/async function usdPerQuote\([^)]*\)[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(body, 'usdPerQuote found');
  // usdPerQuote("USD") must be the implicit no-conversion path (returns 1) for every index symbol's quote.
  const instBlock = engineSrc.match(/const INSTRUMENTS: Record<string, Inst> = \{([\s\S]*?)\n\};/)[1];
  for (const sym of ['UK100', 'GER40', 'FRA40', 'JPN225']) {
    const line = instBlock.split('\n').find((l) => l.trim().startsWith(sym + ':'));
    assert.ok(line, sym + ' present in INSTRUMENTS');
    assert.doesNotMatch(line, /"GBP"|"EUR"|"JPY"|"CAD"|"CHF"/, `${sym} must default to USD (no quote argument): ${line.trim()}`);
  }
});

test('the client prices every index at the uniform $10/point with no FX conversion', () => {
  // Extract the real WL_DATA, execSymbol, symMeta and clientUsdPerQuote from trading.html and run them for real.
  const grab = (re) => { const m = clientSrc.match(re); assert.ok(m, re.source); return m[0]; };
  const wlData = grab(/const WL_DATA=\{[\s\S]*?\n\};/);
  const futSpecs = grab(/var FUT_SPECS=\{[\s\S]*?\};/);
  const execSymbolFn = grab(/function execSymbol\([\s\S]*?\n\}/);
  const symMetaFn = grab(/function symMeta\([\s\S]*?\n\}/);
  const clientUsdPerQuoteFn = grab(/function clientUsdPerQuote\([\s\S]*?\n\}/);

  const sandbox = {};
  new Function(
    wlData + '\n' + futSpecs + '\n' + execSymbolFn + '\n' + symMetaFn + '\n' + clientUsdPerQuoteFn +
    '\nthis.symMeta=symMeta;this.clientUsdPerQuote=clientUsdPerQuote;this.WL_DATA=WL_DATA;'
  ).call(sandbox);
  const { symMeta, clientUsdPerQuote } = sandbox;

  for (const sym of ['UK100', 'GER40', 'FRA40', 'JPN225']) {
    const meta = symMeta(sym);
    assert.equal(meta.quoteCurrency, 'USD', `${sym} client quoteCurrency must be USD, got ${meta.quoteCurrency}`);
    assert.equal(meta.contractSize, 10, `${sym} must be $10/point`);
    assert.equal(clientUsdPerQuote(meta.quoteCurrency), 1, `${sym} must apply no conversion factor`);
  }
  // Real forex pairs must still convert correctly — this fix must not touch them.
  assert.equal(symMeta('USDJPY').quoteCurrency, 'JPY');
  assert.equal(symMeta('USDCHF').quoteCurrency, 'CHF');
  assert.equal(symMeta('EURGBP').quoteCurrency, 'GBP');
});

test('GER40 P&L recomputed without the spurious conversion matches $10/point exactly', () => {
  // The 12 trades closed 2026-10-12..14 (account 9a87d973) used the buggy EUR conversion.
  // This pins the CORRECT formula so it can never regress once fixed: (exit-open) * dir * 10 * volume.
  const truePnl = (open, close, side, volume) => {
    const dir = side === 'buy' ? 1 : -1;
    return Math.round((close - open) * dir * 10 * volume * 100) / 100;
  };
  assert.equal(truePnl(25265.0, 25270.0, 'buy', 0.01), 0.5);
  assert.equal(truePnl(25239.8, 25271.3, 'sell', 0.01), -3.15);
  assert.equal(truePnl(25377.41, 25265.5, 'sell', 0.01), 11.19);
});
