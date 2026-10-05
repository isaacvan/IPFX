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
  assert.match(t, /const pushing=\(rtQuoteChan\|\|hubLive\(\)\)&&Date\.now\(\)-lastPushedQuoteAt<3000;/);
  assert.match(t, /if\(pushing\)return since>=2250;/);
  assert.match(t, /lastPushedQuoteAt=Date\.now\(\);/);
  assert.match(t, /setInterval\(pollTicketPrice,750\);/);
});

test('account updates are pushed: private per-user signal from database triggers, 30s safety poll while connected', async () => {
  const { readFileSync: rf } = await import('node:fs');
  const sql = rf(new URL('../supabase/migrations/20261005110000_account_change_push.sql', import.meta.url), 'utf8');
  assert.match(sql, /using \(realtime\.topic\(\) = 'acct:' \|\| \(select auth\.uid\(\)\)::text and extension = 'broadcast'\)/);
  assert.doesNotMatch(sql, /for insert/, 'no client may send on account topics');
  assert.match(sql, /exception when others then\s+return null;/, 'a failed signal never blocks a trade write');
  for (const t of ['trades_push_upd', 'accounts_push_upd', 'price_alerts_push_upd']) assert.ok(sql.includes(t), t);
  assert.match(sql, /when \(old\.status is distinct from new\.status or old\.balance is distinct from new\.balance/, 'the risk sweep rewriting the row does not signal');
  const page = rf(new URL('../trading.html', import.meta.url), 'utf8');
  assert.match(page, /c\.channel\('acct:'\+uid,\{config:\{private:true\}\}\)/);
  assert.match(page, /const every=acctPending\?0:acctChanOk\?30000:4000;/);
  assert.match(page, /if\(pushing&&!exposed\)return since>=15000;/);
  assert.match(page, /if\(pushing\)return since>=2250;/, 'traders with positions keep the fast risk check');
  assert.doesNotMatch(page, /engineCall\(\{action:'state'\}\);\},4000\)/, 'the fixed 4-second state poll is gone');
});
