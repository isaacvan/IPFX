// 30 Oct 2026 outage: rates.fxcm.com served an expired certificate, every FXCM read threw, and the throw also discarded the TradeLocker
// prices of the same pump tick, so no instrument had a price for ~4.5h. FXCM reads now fall back to the hub relay, and an FXCM
// failure can no longer stop the other price sources.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const e = fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts', import.meta.url), 'utf8');
const relay = fs.readFileSync(new URL('../hub/fxcm-relay.mjs', import.meta.url), 'utf8');
const hub = fs.readFileSync(new URL('../hub/server.mjs', import.meta.url), 'utf8');

const a = e.indexOf('let fxcmDirectDownUntil'), b = e.indexOf('async function fetchFxcmRaw');
const js = e.slice(a, b).replace('(timeoutMs: number): Promise<string | null>', '(timeoutMs)');
function load(fetchImpl, env = { HUB_INGEST_URL: 'https://hub.example.com/ingest', HUB_SECRET: 's'.repeat(40) }) {
  const calls = [];
  const ctx = { Date, URL, AbortSignal, Deno: { env: { get: (k) => env[k] } }, fetch: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); } };
  vm.createContext(ctx); vm.runInContext(js + '\nglobalThis.api = { fetchFxcmXml };', ctx);
  return { fetchFxcmXml: ctx.api.fetchFxcmXml, calls };
}
const ok = (body) => ({ ok: true, text: async () => body, body: { cancel: async () => {} } });

test('every FXCM read goes through one helper', () => {
  assert.equal(e.match(/fetch\("https:\/\/rates\.fxcm\.com/g).length, 1, 'only fetchFxcmXml calls FXCM directly');
  assert.match(e.slice(e.indexOf('async function pumpFxcmOnce'), e.indexOf('async function pumpFxcmOnce') + 400), /fetchFxcmXml\(2000\)/);
  assert.match(e.slice(e.indexOf('async function fetchFxcmRaw'), e.indexOf('async function fetchFxcmRaw') + 400), /fetchFxcmXml\(3000\)/);
});

test('direct FXCM read wins when it works; the hub is not called', async () => {
  const { fetchFxcmXml, calls } = load(async () => ok('<Rates>direct</Rates>'));
  assert.equal(await fetchFxcmXml(2000), '<Rates>direct</Rates>');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/rates\.fxcm\.com\/RatesXML/);
});

test('certificate failure falls back to the hub relay with the hub secret, then skips the direct read for a minute', async () => {
  const { fetchFxcmXml, calls } = load(async (url) => {
    if (url.startsWith('https://rates.fxcm.com')) throw new TypeError('invalid peer certificate: Expired');
    return ok('<Rates>relay</Rates>');
  });
  assert.equal(await fetchFxcmXml(2000), '<Rates>relay</Rates>');
  assert.equal(calls[1].url, 'https://hub.example.com/fxcm-rates');
  assert.equal(calls[1].init.headers['x-hub-secret'], 's'.repeat(40));
  assert.equal(await fetchFxcmXml(2000), '<Rates>relay</Rates>');
  assert.equal(calls.length, 3, 'second read goes straight to the relay');
});

test('no hub configured or relay down: the read returns null instead of throwing', async () => {
  const fail = async () => { throw new Error('down'); };
  assert.equal(await load(fail, {}).fetchFxcmXml(2000), null);
  assert.equal(await load(fail).fetchFxcmXml(2000), null);
});

test('an FXCM failure never discards the TradeLocker / cTrader prices of the same tick', () => {
  assert.match(e, /const fx = fxDue \? await pumpFxcmOnce\(prev\)\.catch\(\(\) => \(\{ rows: \[\] as Record<string, unknown>\[\], changed: \[\] as Quote\[\] \}\)\)/);
});

test('hub relay: secret required, and only an expired certificate is tolerated', () => {
  const route = hub.slice(hub.indexOf("req.url === '/fxcm-rates'"), hub.indexOf("req.url === '/fxcm-rates'") + 300);
  assert.match(route, /if \(!secretOk\(req\.headers\['x-hub-secret'\]\)\) return send\(res, 401/);
  assert.match(relay, /if \(why && why !== 'CERT_HAS_EXPIRED'\) return fail\('tls ' \+ why\)/, 'unknown issuer / self-signed are refused');
  assert.match(relay, /tls\.checkServerIdentity\(HOST, cert\)/, 'certificate must match rates.fxcm.com');
  assert.match(relay, /MAX_EXPIRED_DAYS = (\d+)/);
  assert.ok(Number(/MAX_EXPIRED_DAYS = (\d+)/.exec(relay)[1]) <= 30, 'an expired certificate is accepted for a limited time only');
  assert.match(relay, /const HOST = 'rates\.fxcm\.com'/);
});
