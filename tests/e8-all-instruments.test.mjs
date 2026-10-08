// E8 reference monitor samples every shared instrument, not just five (owner question 2026-10-08).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sql = read('supabase/migrations/20261008210000_e8_all_instruments.sql');
const worker = read('supabase/functions/e8-reference/index.ts');
const feed = read('supabase/functions/_shared/tradelocker-feed.ts');

// The instruments the E8 account offers (46, read from the live account) and the IPFX instruments (30, from live_quotes).
const E8 = ['XAGUSD.C','XAUUSD.C','NSDQ.C','NIKKEI.C','ASX.C','DOW.C','SP.C','DAX.C','EURUSD.C','NZDCAD.C','AUDJPY.C','CADCHF.C','AUDNZD.C','EURGBP.C','USDJPY.C','CHFJPY.C','GBPAUD.C','AUDUSD.C','NZDJPY.C','GBPNZD.C','AUDCHF.C','EURAUD.C','AUDCAD.C','GBPJPY.C','CADJPY.C','EURNZD.C','GBPUSD.C','EURCHF.C','EURCAD.C','EURJPY.C','NZDCHF.C','USDCAD.C','GBPCAD.C','NZDUSD.C','GBPCHF.C','USDCHF.C','BCHUSD.C','BNBUSD.C','LTCUSD.C','SOLUSD.C','XRPUSD.C','ADAUSD.C','BTCUSD.C','ETHUSD.C','WTI.C','BRENT.C'];
const IPFX = ['ADAUSD','AUDCAD','AUDUSD','BTCUSD','DJI','DOTUSD','ETHUSD','EURCAD','EURGBP','EURJPY','EURUSD','FRA40','GBPJPY','GBPUSD','GER40','JPN225','LTCUSD','NSXUSD','NZDUSD','SOLUSD','SPXUSD','UK100','US2000','USDCAD','USDCHF','USDJPY','XAGUSD','XAUUSD','XPDUSD','XPTUSD'];

// same matching rule as the worker: normalise, exact match first, otherwise the start of the name; it must be unique
const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const tl = Object.fromEntries([...feed.matchAll(/(\w+): "([\w]+)"/g)].map((m) => [m[1], m[2]]));
const aliases = Object.fromEntries([...worker.match(/const E8_ALIASES[^=]*= \{([^}]*)\}/)[1].matchAll(/(\w+): "(\w+)"/g)].map((m) => [m[1], m[2]]));
const matchE8 = (symbol) => {
  const target = norm(aliases[symbol] ?? tl[symbol] ?? symbol);
  const exact = E8.filter((n) => norm(n) === target);
  return exact.length ? exact : E8.filter((n) => norm(n).startsWith(target));
};

test('the main 5 stay every 10 seconds and 19 more are sampled every third run (30 seconds)', () => {
  assert.match(sql, /alter table public\.e8_monitor_profiles add column if not exists slow_symbols text\[\] not null default '\{\}';/);
  const list = sql.match(/set slow_symbols = array\[([^\]]*)\]/)[1].match(/'(\w+)'/g).map((x) => x.replace(/'/g, ''));
  assert.equal(list.length, 19);
  assert.equal(new Set(list).size, 19, 'no duplicates');
  for (const main of ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSD']) assert.ok(!list.includes(main), main + ' stays on the fast list only');
  assert.match(worker, /const slowDue=Math\.floor\(started\/10000\)%3===0;/);
  assert.match(worker, /const symbolsNow=\[\.\.\.\(p\.symbols as string\[\]\),\.\.\.\(slowDue\?\(\(p\.slow_symbols\?\?\[\]\) as string\[\]\):\[\]\)\];/);
  assert.match(worker, /\.in\('symbol',symbolsNow\)/);
  assert.match(worker, /for\(const symbol of symbolsNow\)\{/);
  assert.doesNotMatch(worker, /for\(const symbol of p\.symbols as string\[\]\)/, 'the old fixed list loop is gone');
});

test('every sampled instrument matches exactly one E8 instrument; instruments E8 does not offer are the only ones left out', () => {
  const sampled = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSD', ...sql.match(/set slow_symbols = array\[([^\]]*)\]/)[1].match(/'(\w+)'/g).map((x) => x.replace(/'/g, ''))];
  assert.equal(sampled.length, 24);
  for (const s of sampled) assert.equal(matchE8(s).length, 1, `${s} -> ${JSON.stringify(matchE8(s))}`);
  const left = IPFX.filter((s) => !sampled.includes(s));
  assert.deepEqual(left.sort(), ['DOTUSD', 'FRA40', 'UK100', 'US2000', 'XPDUSD', 'XPTUSD']);
  for (const s of left) assert.equal(matchE8(s).length, 0, `${s} really is not offered by E8`);
  assert.deepEqual(['DJI', 'GER40', 'JPN225', 'NSXUSD', 'SPXUSD'].map((s) => matchE8(s)[0]), ['DOW.C', 'DAX.C', 'NIKKEI.C', 'NSDQ.C', 'SP.C']);
});

test('data volume stays bounded: cost_samples kept 21 days; the worker still has its time and rate-limit guards', () => {
  assert.match(sql, /cron\.schedule\('ipfx-cost-samples-purge', '33 3 \* \* \*', \$c\$delete from public\.cost_samples where sampled_at < now\(\) - interval '21 days'\$c\$\)/);
  assert.match(worker, /if\(Date\.now\(\)-started>24000\)\{status='PARTIAL_COVERAGE';break;\}/);
  assert.match(worker, /applicableRules\(rules,'QUOTES'\)/);
});

test('the E8 account stays read-only: no order function was added to the worker', () => {
  assert.doesNotMatch(worker, /placeMarketOrder|closePosition|method:\s*['"](POST|PUT|DELETE)['"]/);
  assert.match(worker, /from "\.\.\/_shared\/tradelocker-read\.ts"/, 'only the read-only client is imported');
  assert.doesNotMatch(worker, /from "\.\.\/_shared\/tradelocker\.ts"/, 'the order-placing client is never imported');
});
