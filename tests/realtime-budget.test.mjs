// Supabase bills realtime per message and recipient: push only watched symbols, throttled; poll slower while pushes arrive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('quote pump pushes only symbols someone has open, at most twice a second', () => {
  const e = read('supabase/functions/trading-engine/index.ts');
  assert.match(e, /const PUSH_MIN_GAP_MS = 500;/);
  assert.match(e, /qs = qs\.filter\(\(q\) => rtWatched\.has\(q\.symbol\) && now - \(lastPushAt\.get\(q\.symbol\) \?\? 0\) >= PUSH_MIN_GAP_MS\);/);
  assert.match(e, /\n\s*refreshWatched\(db\)\.catch\(\(\) => \{\}\);/, 'refreshed in the background: prices never wait on the database');
  assert.match(e, /if \(symbol\) noteWatched\(db, symbol, body\.rt !== false\);/);
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
  assert.match(page, /const every=acctPending\?0:\(acctChanOk\|\|hubPush\)\?30000:4000;/);
  assert.match(page, /if\(pushing&&!exposed\)return since>=15000;/);
  assert.match(page, /if\(pushing\)return since>=2250;/, 'traders with positions keep the fast risk check');
  assert.doesNotMatch(page, /engineCall\(\{action:'state'\}\);\},4000\)/, 'the fixed 4-second state poll is gone');
});

test('Realtime price broadcasts only go out for symbols a Realtime-route page is watching (hub pages ignore them)', () => {
  const e = read('supabase/functions/trading-engine/index.ts');
  const t = read('trading.html');
  const sql = read('supabase/migrations/20261018230000_quote_watch_realtime_route.sql');
  assert.match(sql, /alter table public\.quote_watch add column if not exists rt_seen timestamptz;/);
  // only an explicit rt:false (page is on the hub) skips the Realtime stamp; old pages that send nothing keep broadcasts on
  assert.match(e, /body\.rt !== false/);
  assert.match(e, /rtWatched = new Set/);
  assert.match(e, /upsert\(\{ symbol, last_seen: stamp, rt_seen: stamp \}\)/);
  assert.match(e, /upsert\(\{ symbol, last_seen: stamp \}\)/, 'hub-only pages still mark the symbol watched for the hub');
  assert.match(t, /enforce_risk:true,rt:!hubLive\(\)/);
  // the hub still gets every watched symbol
  assert.match(e, /for \(const q of qs\) hubPending\.set\(q\.symbol, q\);/, 'the hub gets every price change (it keeps the chart tick history)');
});

test('noteWatched stamps the Realtime route only for Realtime pages', () => {
  const e = read('supabase/functions/trading-engine/index.ts');
  const a = e.indexOf('const watchWrittenAt'), b = e.indexOf('async function broadcastQuotes');
  const calls = [];
  const fn = new Function('emailLater', 'db', `${e.slice(a, b).replace(/: Db|: string|: boolean|: void|<string, number>/g, '')}
return noteWatched;`);
  const db = { from: () => ({ upsert: (row) => { calls.push(row); return Promise.resolve({}); } }) };
  const note = fn((p) => p, db);
  note(db, 'XAUUSD', false);          // hub page: stamp watched only
  assert.equal(calls.length, 1); assert.equal('rt_seen' in calls[0], false);
  note(db, 'EURUSD', true);           // Realtime page: stamp both
  assert.equal(calls.length, 2); assert.ok(calls[1].rt_seen);
  note(db, 'EURUSD', true);           // throttled
  assert.equal(calls.length, 2);
});
