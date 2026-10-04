// Supabase bills realtime per message and recipient: push only watched symbols, throttled; poll slower while pushes arrive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('quote pump pushes only symbols someone has open, at most twice a second', () => {
  const e = read('supabase/functions/trading-engine/index.ts');
  assert.match(e, /const PUSH_MIN_GAP_MS = 500;/);
  assert.match(e, /qs = qs\.filter\(\(q\) => watched\.has\(q\.symbol\) && now - \(lastPushAt\.get\(q\.symbol\) \?\? 0\) >= PUSH_MIN_GAP_MS\);/);
  assert.match(e, /await refreshWatched\(db\)\.catch\(\(\) => \{\}\);/);
  assert.match(e, /if \(symbol\) noteWatched\(db, symbol\);/);
  assert.match(read('supabase/migrations/20261004090000_quote_watch.sql'), /create table if not exists public\.quote_watch/);
});

test('the ticket polls every 2.25s while live pushes arrive, 0.75s otherwise', () => {
  const t = read('trading.html');
  assert.match(t, /if\(rtQuoteChan&&Date\.now\(\)-lastPushedQuoteAt<3000\)return since>=2250;/);
  assert.match(t, /lastPushedQuoteAt=Date\.now\(\);/);
  assert.match(t, /setInterval\(pollTicketPrice,750\);/);
});
