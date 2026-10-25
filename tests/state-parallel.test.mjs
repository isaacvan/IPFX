// Faster account refresh: the independent reads in the state payload run together, the alerts run beside the payload, and nothing writes.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
const e = fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts', import.meta.url), 'utf8');
const body = e.slice(e.indexOf('async function statePayload'), e.indexOf('const err = (msg: string, code = 400)'));

test('statePayload fetches its independent reads in one Promise.all and awaits nothing else on the way', () => {
  assert.match(body, /const \[eventsRes, gate, promotion, freshRestart, slDeadline\] = await Promise\.all\(\[/);
  const after = body.slice(body.indexOf('const start = Number(acct.starting_balance)'));
  assert.doesNotMatch(after, /await /, 'no sequential database call is left after the parallel block');
  assert.match(body, /stop_loss_deadline_seconds: slDeadline,/);
  assert.match(body, /for \(const e of eventsRes\.data \?\? \[\]\) \{\n\s*if \(e\.trade_id\) orderIdByTrade\[e\.trade_id\] = String\(e\.id\);/);
});

test('the helpers that now run side by side only read: passGate, promotionNotice, slDeadlineSeconds', () => {
  for (const name of ['passGate', 'promotionNotice', 'slDeadlineSeconds']) {
    const a = e.indexOf(`async function ${name}`), fn = e.slice(a, e.indexOf('\n}\n', a));
    assert.doesNotMatch(fn, /\.(update|insert|upsert|delete)\(/, name);
  }
});

test('state action: alerts are fetched beside the account payload and can never fail the request', () => {
  const a = e.indexOf('if (action === "state") {'), act = e.slice(a, e.indexOf('// ---- payouts: KYC status', a));
  assert.match(act, /const \[payload, alerts\] = await Promise\.all\(\[statePayload\(db, acct as Acct, state\.open, state\.equity, state\.floating\), alertsP\]\);/);
  assert.match(act, /catch \(_\) \{ return \[\]; \/\* alerts are best-effort; never block state \*\/ \}/);
});

test('trading page: Stripe is fetched on demand, the logo and favicons are small files, and the hub and database hosts are warmed up', () => {
  const page = fs.readFileSync(new URL('../trading.html', import.meta.url), 'utf8');
  assert.equal((page.match(/js\.stripe\.com/g) || []).length, 1, 'only the on-demand loader mentions Stripe');
  assert.doesNotMatch(page, /<script src="https:\/\/js\.stripe\.com/);
  assert.match(page, /await ensureStripe\(\);\n\s*if\(typeof window\.Stripe!=='function'\)throw/);
  assert.doesNotMatch(page, /desktop\/build\/icon\.png/, 'the 259 KB original is no longer loaded by the page');
  for (const f of ['ipfx-logo-96.png', 'ipfx-markets-32.png', 'ipfx-markets-16.png']) {
    assert.ok(fs.statSync(new URL('../assets/images/' + f, import.meta.url)).size < 12_000, f);
    assert.ok(page.includes('/assets/images/' + f), f);
  }
  assert.match(page, /<link rel="preconnect" href="https:\/\/hub\.ipfxcapital\.com" crossorigin>/);
  assert.match(page, /<link rel="preconnect" href="https:\/\/agulweemteoeagscmppy\.supabase\.co" crossorigin>/);
});
