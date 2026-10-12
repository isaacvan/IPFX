// Every instrument's quote currency must have a branch in usdPerQuote(), or every
// order on that instrument is rejected with "No conversion rate". GER40/FRA40 are
// EUR-quoted and were silently untradeable until 2026-10-12.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts', import.meta.url), 'utf8');

test('usdPerQuote handles every quote currency used by INSTRUMENTS', () => {
  // Quote currencies declared on instruments: the `I(...)`/`F(...)` factories default to USD,
  // and a non-USD quote is passed as a "XXX" string argument.
  const quotes = new Set(['USD']);
  for (const m of src.matchAll(/\b(?:I|F)\([^)]*?,\s*"([A-Z]{3})"(?:\s*,\s*"[^"]*")?\s*\)/g)) quotes.add(m[1]);
  // Also catch any bare quote: "XXX" literals, in case the factory shape changes.
  for (const m of src.matchAll(/quote:\s*"([A-Z]{3})"/g)) quotes.add(m[1]);

  const body = src.match(/async function usdPerQuote\([^)]*\)[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(body, 'usdPerQuote function found');
  const handled = new Set(['USD']);
  for (const m of body[1].matchAll(/quote === "([A-Z]{3})"/g)) handled.add(m[1]);

  const missing = [...quotes].filter((q) => !handled.has(q));
  assert.deepEqual(missing, [], `quote currencies with no conversion branch: ${missing.join(', ')}`);
  assert.ok(handled.has('EUR'), 'EUR (GER40/FRA40) must be convertible');
});
