// Disk IO budget (9 Nov 2026): the E8 simulator spilled temp files every 10 s, and a breached v2 account could not close
// its trade (the v2 guard refused the close-request mark), so the engine and hub retried every few seconds for 15 hours.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
const mig = (f) => fs.readFileSync(new URL('../supabase/migrations/' + f, import.meta.url), 'utf8');

test('e8_sim_tick finds waiting events first and does nothing heavy when none are waiting', () => {
  const s = mig('20261109160000_e8_sim_tick_cheap_when_idle.sql');
  assert.match(s, /select array_agg\(v\.id order by v\.id\) into pending_ids/);
  assert.match(s, /if pending_ids is not null then/);
  assert.match(s, /where v\.id = any\(pending_ids\)/);
  assert.match(s, /insert into public\.ab_heartbeats\(worker,ok,at,detail\) values\('e8-simulator'/, 'heartbeat still written every tick');
});

test('v2 guard: bookkeeping updates (close request) pass on a frozen account; level and size edits are still refused', () => {
  const s = mig('20261109170000_v2_guard_allows_close_on_frozen.sql');
  const same = s.indexOf("if tg_op='UPDATE' and new.sl is not distinct from old.sl and new.volume<=old.volume");
  const frozen = s.indexOf("if a.status<>'active' or a.access_revoked_at is not null then raise exception 'ACCOUNT_FROZEN'");
  assert.ok(same > 0 && frozen > same, 'the unchanged-levels return comes before the frozen check');
  assert.match(s, /if new\.status<>'open' then return new;end if;/);
  assert.match(s, /if tg_op='UPDATE' and new\.volume>old\.volume then raise exception 'POSITION_VOLUME_CANNOT_INCREASE'/);
});
