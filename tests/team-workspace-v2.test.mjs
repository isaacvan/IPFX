// New team workspace (/workspace/): shared shell + Books + Overview.
// Books only removes typing; every action must be one the server already supports and validates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('Books calls only ongoing-copy actions the server handles, with the fields it requires', () => {
  const books = read('assets/js/ws-books.js');
  const server = read('supabase/functions/_shared/ongoing-copy-controls.ts');
  const used = [...books.matchAll(/T\.ladder\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(used.length >= 7, 'found the ladder actions');
  for (const a of used.filter((x) => x.startsWith('ongoing_copy_'))) assert.ok(server.includes(`'${a}'`), `server handles ${a}`);
  assert.ok(used.includes('capacity_set'), 'broker limits are saved through capacity_set');
  // Required by ongoing_copy_connect: lots (0,1], risk (0,100], explicit ownership confirm, reason >= 5 chars.
  assert.match(books, /ongoing_copy_connect', \{ id: Number\(x\.id\), lots: Number\(x\.lots\), risk_usd: Number\(x\.risk\), confirm_owned_and_permitted: true, reason: '[^']{5,}'/);
  assert.match(books, /max: 1, step: 0\.01/); assert.match(books, /max: 100, step: 1/);
  // Turning execution ON is always an explicit confirmation; OFF never needs one (safe direction).
  assert.match(books, /ongoing_copy_on', \{ id: fresh\.id, version: fresh\.version, confirm_funded_execution: true \}/);
  assert.match(books, /ongoing_copy_off', \{ id: c\.id, version: c\.version \}/);
  assert.match(books, /if \(!c\.capacity_configured && !\(await editLimits\(c\)\)\) return;/, 'limits are required before execution can turn on');
  // A <-> B is one click each way.
  assert.match(books, /ongoing_copy_start_trader', \{ id: c\.id, person_id: personId, version: c\.version, reason: '[^']{5,}', confirm_funded_execution: true \}/);
  assert.match(books, /ongoing_copy_select', \{ id: s\.connection_id, person_id: s\.person_id, enabled: false, reason: '[^']{5,}' \}/);
});

test('the shell signs in through team-login and calls only the existing owner functions', () => {
  const shell = read('assets/js/team-shell.js');
  assert.match(shell, /location\.replace\('\/team-login\.html\?next='/);
  for (const fn of ['admin-console', 'ladder-admin', 'team-book-connect', 'team-population']) assert.ok(shell.includes(fn), fn);
  assert.doesNotMatch(shell, /tradelocker\.com|api\.e8|metaapi/i, 'no direct broker calls from the browser');
  assert.match(shell, /f\.type === 'password' \? ' autocomplete="new-password"'/, 'passwords are never autofilled into the sheet');
});

test('team-login returns you to the workspace page you asked for, and nowhere outside the allowlist', () => {
  const page = read('team-login.html');
  const src = page.match(/const safeNext=(\/\^[\s\S]*?\$\/)\.test\(requestedNext\)/)[1];
  const re = new Function('return ' + src)();
  for (const ok of ['/workspace/', '/workspace/books.html', '/workspace/index.html', '/workspace/queues.html', '/workspace/traders.html', '/team-feedback.html', '/team-a-book.html']) assert.ok(re.test(ok), ok);
  for (const bad of ['//evil.com', 'https://evil.com/workspace/', '/workspace/../admin.html', '/workspace/a/b.html', '/workspace/Books.html', '/workspacebooks.html', '/workspace/x.js']) assert.ok(!re.test(bad), bad);
});

test('workspace pages load the shared shell and stay out of search engines', () => {
  for (const p of ['workspace/index.html', 'workspace/books.html', 'workspace/queues.html', 'workspace/traders.html']) {
    const h = read(p);
    assert.match(h, /noindex,nofollow,noarchive/);
    assert.match(h, /\/assets\/css\/team-os\.css/);
    assert.match(h, /\/assets\/js\/team-shell\.js/);
    assert.match(h, /supabase-js@2\.57\.4/);
  }
  assert.ok(!fs.existsSync(new URL('../workspace/__mock', import.meta.url)), 'test harness is not shipped');
});

test('Queues sends the same admin-console actions and fields as the Operations page', () => {
  const q = read('assets/js/ws-queues.js'), server = read('supabase/functions/admin-console/index.ts');
  const used = [...new Set([...q.matchAll(/T\.admin\('([a-z_]+)'/g)].map((m) => m[1]))];
  for (const a of used) assert.ok(server.includes(`action === "${a}"`), `admin-console handles ${a}`);
  for (const a of ['application_queue', 'application_decide', 'kyc_queue', 'set_kyc_status', 'kyc_document_url', 'kyc_identity_reveal', 'payout_approve', 'payout_mark_paid', 'payout_void', 'feedback_list', 'feedback_update', 'trade_safety_review', 'trade_safety_mark']) assert.ok(used.includes(a), 'uses ' + a);
  assert.match(q, /application_decide', \{ application_id: id, status: 'approved' \}/);
  assert.match(q, /payout_mark_paid', \{ payout_id: id, external_reference: String\(v\.ref\)\.trim\(\) \}/);
  assert.match(q, /payout_void', \{ payout_id: id, reason: String\(v\.reason\)\.trim\(\) \}/);
  assert.match(q, /set_kyc_status', \{ user_id: user, status: 'rejected', note: String\(v\.note\)\.trim\(\) \}/);
  assert.match(q, /trade_safety_mark', \{ flag_id: id, status: b\.dataset\.st \}/);
  // Identity documents: the tab opens first (popup blockers), then the one-time link; no link is prefetched.
  assert.match(q, /window\.open\('about:blank', '_blank'\)/);
  assert.doesNotMatch(q, /kyc_document_url[^;]*Promise\.all/);
  assert.match(read('assets/js/team-shell.js'), /id: 'queues', label: 'Queues', href: '\/workspace\/queues\.html'/);
});

test('Traders sends only actions the owner functions handle, with the fields they require', () => {
  const t = read('assets/js/ws-traders.js'), admin = read('supabase/functions/admin-console/index.ts'), copy = read('supabase/functions/_shared/ongoing-copy-controls.ts');
  for (const a of new Set([...t.matchAll(/T\.admin\('([a-z_]+)'/g)].map((m) => m[1]))) assert.ok(admin.includes(`action === "${a}"`), `admin-console handles ${a}`);
  for (const a of new Set([...t.matchAll(/T\.ladder\('([a-z_]+)'/g)].map((m) => m[1]))) assert.ok(copy.includes(`action==='${a}'`) || a === 'ongoing_copy_status', `ladder-admin handles ${a}`);
  assert.match(t, /trader_detail', \{ user_id: t\.user_id \}/);
  assert.match(t, /set_investigation_hold', \{ account_id: t\.account_id, hold: on, note: x\.note \|\| null \}/);
  assert.match(t, /ongoing_copy_start_trader', \{ id: conn\.id, person_id: f\.person_id, version: conn\.version, reason: '[^']{5,}', confirm_funded_execution: true \}/);
  assert.match(t, /ongoing_copy_select', \{ id: s\.connection_id, person_id: s\.person_id, enabled: false, reason: '[^']{5,}' \}/);
  assert.match(read('assets/js/team-shell.js'), /id: 'traders', label: 'Traders', href: '\/workspace\/traders\.html'/);
  assert.match(read('workspace/traders.html'), /noindex,nofollow,noarchive/);
});

test('confirm sheets ignore a second submit while the first is still running', () => {
  assert.match(read('assets/js/team-shell.js'), /if \(form\.dataset\.busy\) return; form\.dataset\.busy = '1'/);
});
