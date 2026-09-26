// Volume borrowed from CME currency futures for spot forex: bucket alignment and merging.
// (Imports the pure TypeScript module directly; Node strips the types.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeVolume, volumeKey, VOLUME_PROXY } from '../supabase/functions/chart-candles/volume-merge.ts';

const bar = (t, v = 0) => ({ t, o: 1, h: 1, l: 1, c: 1, v });
const H = 3600, D = 86400;
const T = Date.UTC(2026, 7, 26, 0, 0) / 1000; // 26 Aug 2026 00:00 UTC

test('intraday bars pair up by their exact UTC bucket', () => {
  const spot = [bar(T), bar(T + H), bar(T + 2 * H)];
  const fut = [bar(T, 10), bar(T + 2 * H, 30)];
  assert.equal(mergeVolume(spot, fut, H), 2);
  assert.deepEqual(spot.map((b) => b.v), [10, 0, 30]);
});

test('a bucket with no futures volume stays at zero, and an empty futures series changes nothing', () => {
  const spot = [bar(T), bar(T + H)];
  assert.equal(mergeVolume(spot, [], H), 0);
  assert.deepEqual(spot.map((b) => b.v), [0, 0]);
  assert.equal(mergeVolume(spot, [bar(T, 0)], H), 0, 'zero futures volume does not count as a match');
});

test('daily: a spot bar opening at the 22:00 UTC rollover pairs with the futures bar of that trade date', () => {
  // spot daily stamp: 23:00 UTC on 24 Aug (FX day starting that evening); futures stamp for 24 Aug: 04:00 UTC
  const spotStamp = Date.UTC(2026, 7, 24, 23, 0) / 1000, futStamp = Date.UTC(2026, 7, 24, 4, 0) / 1000;
  assert.equal(volumeKey(spotStamp, D, false), volumeKey(futStamp, D, true));
  const spot = [bar(spotStamp), bar(spotStamp + D)], fut = [bar(futStamp, 500), bar(futStamp + D, 700)];
  assert.equal(mergeVolume(spot, fut, D), 2);
  assert.deepEqual(spot.map((b) => b.v), [500, 700]);
});

test('daily keys are distinct across days (no bar borrows a neighbour)', () => {
  const keys = [0, 1, 2, 3].map((i) => volumeKey(Date.UTC(2026, 7, 24 + i, 23, 0) / 1000, D, false));
  assert.equal(new Set(keys).size, 4);
});

test('weekly: spot stamped a couple of hours before the week pairs with the futures week', () => {
  const W = 7 * D, weekStart = Math.floor(T / W) * W;
  assert.equal(volumeKey(weekStart - 3600, W, false), volumeKey(weekStart + 4 * H, W, true));
  const spot = [bar(weekStart - 3600)], fut = [bar(weekStart + 4 * H, 9000)];
  assert.equal(mergeVolume(spot, fut, W), 1);
  assert.equal(spot[0].v, 9000);
});

test('futures bars sharing a bucket are summed', () => {
  const spot = [bar(T)];
  mergeVolume(spot, [bar(T, 5), bar(T, 7)], H);
  assert.equal(spot[0].v, 12);
});

test('every majors pair maps to a futures code and a description', () => {
  for (const sym of ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURGBP', 'EURJPY']) {
    const [code, label] = VOLUME_PROXY[sym];
    assert.match(code, /^[0-9A-Z]{2}=F$/);
    assert.ok(label.startsWith('CME '));
  }
});
