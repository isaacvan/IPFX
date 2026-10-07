// Infinity stop-loss rule: no stop loss after 30s = closed, profit removed, warning; 3 warnings end the run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const eng = read('supabase/functions/trading-engine/index.ts');
const sql = read('supabase/migrations/20261005140000_infinity_sl_strikes.sql');

test('the 30-second rule applies to Infinity accounts only, and is switched on', () => {
  assert.match(eng, /const slDeadline = sl === null && acct\.challenge_type === "infinity" \? await slDeadlineSeconds\(db\) : null;/);
  assert.match(sql, /update public\.ab_settings set sl_deadline_seconds = 30/);
  assert.match(read('hub/risk.mjs'), /this\.accounts\.get\(t\.account_id\)\?\.challenge_type === 'infinity'/);
});

test('a warned trade keeps its loss but never its profit', () => {
  assert.match(eng, /const strip = reason === "no_stop_loss" && acct\.challenge_type === "infinity" && rawPnl > 0;\s+const pnl = strip \? 0 : rawPnl;/);
  assert.match(eng, /p_stripped_profit: strip \? round2\(rawPnl\) : null/);
  assert.match(eng, /acct\.balance = Number\(committed\.balance\);/);
});

test('every warned trade is one warning (never twice); the third ends the run like a breach', () => {
  assert.match(sql, /if exists \(select 1 from public\.sl_strikes where trade_id = p_trade\) then return a\.sl_strikes; end if;/);
  assert.match(sql, /trade_id uuid not null unique/);
  assert.match(eng, /const SL_STRIKES_MAX = 3;/);
  assert.match(eng, /if \(Number\(strikes\) >= SL_STRIKES_MAX && acct\.status === "active"\) strikeOut = true;/);
  assert.match(eng, /p_reason: "stop_loss_rule"/);
  assert.match(sql, /p_reason not in \('max_drawdown','daily_loss','stop_loss_rule'\)/);
  assert.match(sql, /check \(reason = any \(array\['max_drawdown', 'daily_loss', 'stop_loss_rule'\]\)\)/);
});

test('warned trades never count towards progress or qualification', () => {
  assert.match(sql, /AND t\.close_reason IS DISTINCT FROM 'no_stop_loss'::text/);
  assert.match(sql, /ELSE t\.close_reason IS DISTINCT FROM 'no_stop_loss'::text/);
  assert.match(sql, /and close_reason is distinct from 'no_stop_loss'/);
});

test('traders see each warning and why their run ended', () => {
  const page = read('trading.html');
  assert.match(page, /Stop-loss warning \$\{n\} of \$\{max\}/);
  assert.match(page, /breach\.reason==='stop_loss_rule'\?'3 stop-loss warnings/);
  assert.match(read('dashboard.html'), /stop_loss_rule:'3 stop-loss warnings/);
  assert.match(eng, /sl_strikes: Number\(\(acct as any\)\.sl_strikes \?\? 0\), sl_strikes_max: SL_STRIKES_MAX,/);
});
