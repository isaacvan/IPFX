// Feedback inbox is reachable from the team workspace and reads via the admin-console feedback actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('team-feedback.html exists, loads its script, and shows the inbox table', () => {
  const h = read('team-feedback.html');
  assert.match(h, /IPFX Team · Feedback/);
  assert.match(h, /assets\/js\/team-feedback\.js/);
  assert.match(h, /id="fbRows"/);
  assert.match(h, /aria-current="page">Feedback/);
});

test('team-feedback.js calls the admin-console feedback actions with the session token', () => {
  const j = read('assets/js/team-feedback.js');
  assert.match(j, /functions\/v1\/admin-console/);
  assert.match(j, /feedback_list/);
  assert.match(j, /feedback_update/);
  assert.match(j, /Authorization: 'Bearer ' \+ session\.access_token/);
  assert.match(j, /is_admin === false/, 'handles non-admin access');
});

test('every team page links to the Feedback page', () => {
  for (const f of ['team-brain.html', 'trader-analytics.html', 'team-b-book.html', 'team-a-book.html', 'team-treasury.html', 'team-e8-monitor.html']) {
    assert.match(read(f), /href="team-feedback\.html"/, f + ' links to Feedback');
  }
});
