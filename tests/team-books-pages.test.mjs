import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const js = read('assets/js/team-books.js');
const a = read('team-a-book.html');
const b = read('team-b-book.html');
const login = read('team-login.html');

test('both Team book pages use the owner-only analytics endpoint and no browser broker order', () => {
  assert.match(js, /action: 'risk_analytics'/);
  assert.doesNotMatch(js, /tradelocker-connect|live-mirror|marketOrder|placeMarketOrder/);
  assert.match(a, /data-book="a"/);
  assert.match(b, /data-book="b"/);
  assert.match(login, /team-a-book\|team-b-book/);
});

test('A assignments require an explicit approved server route', () => {
  assert.match(js, /value\.approved !== true/);
  assert.match(js, /value\.state === 'A' \|\| value\.state === 'SPLIT'/);
  assert.match(a, /No.*orders|does not place orders/);
});

test('funded projection is withheld without exact 0.01-lot broker evidence', () => {
  assert.match(js, /Number\(day\.executed_lots\) === 0\.01/);
  assert.match(js, /finite\(day\.gross_price_pnl_usd\)/);
  assert.match(js, /Unavailable — fixed-size fills not verified/);
  assert.match(b, /0\.2 lots is position size, not a 0\.2% risk limit/);
});
