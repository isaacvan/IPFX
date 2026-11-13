// Infinity automatic stop (13 Nov 2026): a trade still without a stop after 30 seconds gets one at the furthest
// distance its risk limit allows, instead of being closed with a stop-loss strike. Runs the real migrations in PGlite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { v2db, uid } from './helpers/infinity-v2-db.mjs';
const opts = { skip: !process.env.DEMO_TEST_DEPS };
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
async function open(db, a, { side = 'buy', volume = .01, price = 1.1, sl = null, at = ago(45) } = {}) {
  return (await db.query(`insert into trades(account_id,user_id,symbol,side,volume,open_price,sl,opened_at,execution_rules_version) values($1,$2,'EURUSD',$3,$4,$5,$6,$7,'infinity_v2') returning *`, [a.id, uid, side, volume, price, sl, at])).rows[0];
}
const auto = async (db, t) => (await db.query('select infinity_v2_auto_stop($1,5) r', [t.id])).rows[0].r;
const row = async (db, t) => (await db.query('select sl,initial_sl,initial_risk_usd,status from trades where id=$1', [t.id])).rows[0];

test('a trade without a stop after 30 seconds gets the furthest stop its risk limit allows', opts, async () => {
  const { db, account } = await v2db(); try {
    const a = await account();
    const t = await open(db, a, { volume: .01 });
    const r = await auto(db, t);
    assert.equal(r.ok, true, JSON.stringify(r));
    const x = await row(db, t);
    assert.equal(Number(x.sl), 1.095, '$5 limit at 0.01 lots = 50 pips below the entry');
    assert.equal(Number(x.initial_sl), 1.095);
    assert.ok(Number(x.initial_risk_usd) <= 5 && Number(x.initial_risk_usd) > 4.99, 'risk recorded at the limit, never above');
    const s = await open(db, a, { side: 'sell', volume: .01, price: 1.1 });
    assert.equal((await auto(db, s)).ok, true, 'a separate counted trade (other side) gets its own full limit');
    assert.equal(Number((await row(db, s)).sl), 1.105);
  } finally { await db.close(); }
});

test('a sell gets its stop above the entry, and the risk limit tightens near the loss floors', opts, async () => {
  const { db, account } = await v2db(); try {
    const a = await account();
    // $10 of the $25 daily room already lost today: room x 0.25 = $3.75, below the $5 per-trade limit.
    await db.query('update trading_accounts set balance=990, day_start_equity=1000 where id=$1', [a.id]);
    const t = await open(db, a, { side: 'sell', volume: .01, price: 1.1 });
    const r = await auto(db, t);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(Number(r.limit) <= 3.75 && Number(r.limit) > 3.5, 'tightened from $5 by the daily room (open trade costs included)');
    assert.ok(Number((await row(db, t)).sl) > 1.1 && Number(r.risk_usd) <= 3.75);
  } finally { await db.close(); }
});

test('no valid stop: nothing is written, and the trader still cannot add an opening stop after the window', opts, async () => {
  const { db, account } = await v2db(); try {
    const a = await account();
    const big = await open(db, a, { volume: .5 });   // $5 limit at 0.5 lots = 1 pip, inside the 8-spread minimum
    const r = await auto(db, big);
    assert.equal(r.ok, false); assert.equal(r.reason, 'NO_VALID_STOP');
    assert.equal((await row(db, big)).sl, null);
    const late = await open(db, a, { side: 'sell', volume: .01 });
    await assert.rejects(db.query('update trades set sl=1.103 where id=$1', [late.id]), /OPENING_STOP_TOO_LATE/, 'only the automatic stop may set a late opening stop');
  } finally { await db.close(); }
});

test('closing a trade for having no stop no longer records a strike or ends the run', opts, async () => {
  const { db, account } = await v2db(); try {
    const a = await account();
    for (const h of [3, 2, 1]) {
      const t = await open(db, a, { volume: .01, at: ago(h * 3600) });   // separate counted trades
      await db.query("update trades set status='closed',pnl=-1,closed_at=clock_timestamp(),close_reason='no_stop_loss' where id=$1", [t.id]);
    }
    const acc = (await db.query('select status,sl_strikes from trading_accounts where id=$1', [a.id])).rows[0];
    assert.deepEqual([acc.status, Number(acc.sl_strikes)], ['active', 0]);
    assert.equal(Number((await db.query('select count(*) n from sl_strikes')).rows[0].n), 0);
  } finally { await db.close(); }
});

test('the engine attaches the automatic stop instead of closing with a strike', () => {
  const src = fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('// Infinity only: a trade still without a stop loss after the deadline gets one automatically'), src.indexOf('if (t.side === "buy") {', src.indexOf('// Infinity only: a trade still without a stop loss after the deadline gets one automatically')));
  assert.match(block, /const auto = await attachAutomaticStop\(db, acct, t, q\);/);
  assert.ok(block.indexOf('attachAutomaticStop') < block.indexOf('closeTrade'), 'the stop is tried first; closing is only the fallback');
  assert.doesNotMatch(block, /fn_record_sl_strike|strikeOut\s*=\s*true/);
  assert.match(src, /db\.rpc\("infinity_v2_auto_stop", \{ p_trade: t\.id, p_digits: inst\.digits \}\)/);
  const mig = fs.readFileSync(new URL('../supabase/migrations/20261113150000_infinity_automatic_stop.sql', import.meta.url), 'utf8');
  assert.match(mig, /access_revoked_reason = 'challenge_rule_breach:stop_loss_rule'/, 'free restart for runs ended by the old rule');
  assert.match(mig, /'infinity_stop_rule_restart'/);
  assert.match(fs.readFileSync(new URL('../supabase/functions/email-outbox/index.ts', import.meta.url), 'utf8'), /"infinity_stop_rule_restart"/);
});
