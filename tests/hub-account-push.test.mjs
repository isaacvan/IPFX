// Big Build step 3: the hub nudges a trader's open pages when their account changes, so pages stop asking Supabase on a timer.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import { spawn } from 'node:child_process'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const page = read('trading.html'), hub = read('hub/server.mjs'), sql = read('supabase/migrations/20261024120000_account_push_user_id.sql');

test('database: the hub event now carries the owner (user_id) too, built on the live function with a drift guard', () => {
  assert.match(sql, /md5\(pg_get_functiondef\('public\.notify_account_change\(\)'::regprocedure\)\) <> '6657c3aa773c08709d0affdad72223b7'/);
  assert.match(sql, /jsonb_build_object\('account_id', acc, 'user_id', uid, 't', tg_table_name\)/);
  assert.match(sql, /perform realtime\.send\(/, 'the Realtime broadcast stays as the fallback');
  assert.match(sql, /exception when others then\s+return null;/, 'a failed signal never blocks the write');
});

test('page: a hub nudge refreshes the account; Realtime is only opened when the hub cannot push', () => {
  assert.match(page, /else if\(m\.t==='acct'\)\{onAccountChanged\(\);\}/);
  assert.match(page, /hubAcctPush=hubOk&&m\.acct===true;/);
  assert.match(page, /const hubPush=hubLive\(\)&&hubAcctPush;\n\s*if\(!acctChan&&!hubPush\)ensureAccountStream\(\);\n\s*const every=acctPending\?0:\(acctChanOk\|\|hubPush\)\?30000:4000;/);
  assert.match(page, /ws\.onclose=\(\)=>\{hubOk=false;hubRisk=false;hubAcctPush=false;/);
});

test('hub: nudges only the owner, coalesces bursts, cleans up closed sockets', () => {
  assert.match(hub, /if \(typeof body\.user_id === 'string' && \/\^\[0-9a-f-\]\{36\}\$\/i\.test\(body\.user_id\)\) pushAccount\(body\.user_id\);/);
  assert.match(hub, /socketsByUid\.get\(u\) \?\? \[\]/);
  assert.match(hub, /acct: true \}\)\);/);
  assert.match(hub, /if \(ws\.uid\) \{ const set = socketsByUid\.get\(ws\.uid\)/);
});

function post(port, urlPath, secret, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port, host: '127.0.0.1', path: urlPath, method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-secret': secret } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject); r.end(JSON.stringify(body));
  });
}

test('end to end: a real hub and two traders; an account event reaches only its owner (on every open page), once per burst', async (t) => {
  const require = createRequire(import.meta.url);
  const { default: WebSocket } = await import(pathToFileURL(require.resolve('ws', { paths: [path.resolve('hub')] })).href);
  const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
  // a stand-in for Supabase's /auth/v1/user: the token's "sub" is the user id
  const auth = http.createServer((req, res) => {
    if (!req.url.startsWith('/auth/v1/user')) { res.writeHead(404); return res.end('{}'); }   // the hub's other start-up calls
    const tok = String(req.headers.authorization || '').replace('Bearer ', ''), sub = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).sub;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: sub }));
  });
  await new Promise((r) => auth.listen(0, '127.0.0.1', r)); t.after(() => auth.close());
  const token = (sub) => `h.${Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signaturesignature`;
  const secret = 'x'.repeat(40), port = 18400 + Math.floor(Math.random() * 400), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubtest-'));
  const proc = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve('hub'), env: { ...process.env, PORT: String(port), SUPABASE_URL: `http://127.0.0.1:${auth.address().port}`, SUPABASE_ANON_KEY: 'anon', HUB_SECRET: secret, STATE_DIRECTORY: dir }, stdio: 'ignore' });
  t.after(() => proc.kill());
  for (let i = 0; i < 50; i++) { try { await post(port, '/event', secret, {}); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const open = (uid) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`), got = [];
    ws.on('message', (d) => got.push(JSON.parse(d))); ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', token: token(uid) }))); ws.on('error', reject);
    const poll = setInterval(() => { if (got.some((m) => m.t === 'auth')) { clearInterval(poll); resolve({ ws, got }); } }, 20);
  });
  const [a1, a2, b] = [await open(A), await open(A), await open(B)];
  assert.equal(a1.got.find((m) => m.t === 'auth').acct, true, 'the hub announces that it can push account changes');
  const count = (c) => c.got.filter((m) => m.t === 'acct').length;
  await Promise.all([1, 2, 3, 4, 5].map(() => post(port, '/event', secret, { account_id: A, user_id: A, t: 'trades' })));   // a burst
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual([count(a1), count(a2), count(b)], [1, 1, 0], 'both of A\'s pages get one nudge for the burst; B gets none');
  assert.equal(await post(port, '/event', secret, { account_id: A, user_id: 'not-a-uuid', t: 'trades' }), 200);
  assert.equal(await post(port, '/event', 'wrong-secret'.padEnd(40, 'y'), { account_id: A, user_id: A }), 401, 'events need the hub secret');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual([count(a1), count(a2), count(b)], [1, 1, 0], 'a malformed id or a wrong secret delivers nothing');
  a1.ws.close(); await new Promise((r) => setTimeout(r, 200));
  await post(port, '/event', secret, { account_id: A, user_id: A, t: 'accounts' }); await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual([count(a2), count(b)], [2, 0], 'a closed page is dropped; the other page still gets nudged');
  a2.ws.close(); b.ws.close();
});
