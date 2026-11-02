// Traders page (2 Nov 2026): a trader who restarted on Infinity v2 shows their NEW run by default; the old v1 run is kept, listed
// beside it with its own numbers, and its trades/equity/profile are never blended into the new run unless "All runs together" is chosen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fn = read('supabase/functions/admin-console/index.ts');
const js = read('assets/js/ws-traders.js');

test('admin overview: archived restart runs are returned per trader with their own stats; current rows carry rules_version', () => {
  assert.match(fn, /eq\("access_revoked_reason", "voluntary_infinity_v2_restart"\)/);
  assert.match(fn, /previous_runs: a\.challenge_type === "infinity" \? \(previousByUser\.get\(a\.user_id as string\) \?\? \[\]\) : \[\]/);
  assert.match(fn, /rules_version: a\.rules_version \?\? null,\s+started_at: a\.created_at,/);
  assert.match(fn, /realized_pnl: Math\.round\(\(Number\(r\.balance\) - Number\(r\.starting_balance\)\) \* 100\) \/ 100,/);
  assert.match(read('workspace/traders.html'), /ws-traders\.js\?v=20261102b/);
});

function boot(overview, detail) {
  const els = {}, handlers = {};
  const el = (id) => (els[id] ??= { id, innerHTML: '', value: '', addEventListener() {} });
  const T = {
    esc: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;'), usd: (v) => '$' + Number(v).toFixed(2), ukTime: (v) => String(v).slice(0, 10),
    admin: async (a) => (a === 'overview' ? overview : a === 'trader_detail' ? detail : { entries: [] }), ladder: async () => null,
    mount() {}, status() {}, toast() {}, sheet: async () => null,
  };
  const document = { getElementById: el, querySelector: () => null, hidden: false, addEventListener: (k, f) => { handlers[k] = f; } };
  const ctx = { window: { TeamOS: T }, document, setInterval() {}, console, Date, Number, Math, String, Array, Set, Object, JSON, Promise, Infinity, Map };
  vm.createContext(ctx); vm.runInContext(js, ctx);
  const click = (attrs) => handlers.click({ target: { closest: (sel) => { const m = sel.match(/^\[data-([a-z]+)\]$/); return m && attrs[m[1]] !== undefined ? { dataset: attrs } : null; } } });
  return { els, click, tick: () => new Promise((r) => setTimeout(r, 20)) };
}

const stats = (n, w) => ({ trades: n, win_rate: w, profit_factor: 1.4, max_drawdown_pct: 2.5, consistency_pct: 30 });
const trader = (extra) => ({ user_id: 'u1', account_id: 'NEW', full_name: 'Ada Trader', email: 'ada@example.com', status: 'active', phase: 'evaluation', challenge_type: 'infinity', stage: 1,
  starting_balance: 10000, balance: 10100, realized_pnl: 100, stats: stats(4, 50), detector: null, rules_version: 'infinity_v2', started_at: '2026-11-02T08:00:00Z', ...extra });
const old = { account_id: 'OLD', label: 'Infinity 10k', stage: 2, status: 'closed', rules_version: 'infinity_v1', started_at: '2026-10-01T08:00:00Z', ended_at: '2026-11-02T07:59:00Z',
  starting_balance: 10000, balance: 10900, realized_pnl: 900, stats: stats(120, 62) };
const tr = (id, account_id, pnl) => ({ id, account_id, symbol: id === 'o1' || id === 'o2' ? 'OLDSYM' : 'NEWSYM', side: 'buy', volume: 1, status: 'closed', pnl, opened_at: '2026-11-02T08:10:00Z', closed_at: '2026-11-02T08:20:00Z', audit: [] });
const detail = {
  trades: [tr('n1', 'NEW', 20), tr('n2', 'NEW', -10), tr('o1', 'OLD', 500), tr('o2', 'OLD', 400)],
  per_account_profile: [
    { account_id: 'NEW', label: 'Infinity 10k', status: 'active', profile: { trades_closed: 2, summary_text: 'NEW RUN PROFILE', win_rate: 50 }, readiness: null, stage_requirements: { title: 'Infinity v2 — Stage 1', items: [{ done: false, text: '2/80 counted trades' }], ready: false, v2: true } },
    { account_id: 'OLD', label: 'Infinity 10k', status: 'closed', profile: { trades_closed: 2, summary_text: 'OLD RUN PROFILE', win_rate: 100 }, readiness: null, stage_requirements: null },
  ],
  combined_profile: { trades_closed: 4, summary_text: 'COMBINED PROFILE', win_rate: 75 }, reject_events: [], identity: null, user_id: 'u1',
};

test('list: v2 chip, "old run kept" note, new filters and summary tiles', async () => {
  const b = boot({ is_admin: true, traders: [trader({ previous_runs: [old] }), trader({ user_id: 'u2', account_id: 'V1ONLY', email: 'bob@example.com', full_name: 'Bob', rules_version: 'infinity_v1', previous_runs: [] })] }, detail);
  await b.tick();
  const list = b.els.list.innerHTML;
  assert.match(list, /<th>Rules<\/th>/);
  assert.match(list, /restarted · 1 old run kept/);
  assert.equal((list.match(/restarted · /g) || []).length, 1, 'only the restarted trader carries the note');
  const f = b.els.filters.innerHTML;
  assert.match(f, /Infinity v2 · 1/); assert.match(f, /Infinity v1 · 1/); assert.match(f, /Restarted · 1/);
  assert.match(b.els.summary.innerHTML, /On Infinity v2/);
  // the list row shows the CURRENT run's numbers (P&L 100, 4 trades), not the old run's
  assert.match(list, /\$100\.00/); assert.doesNotMatch(list, /\$900\.00/);
  b.click({ filter: 'Restarted' });
  const filtered = b.els.list.innerHTML; assert.match(filtered, /Ada Trader/); assert.doesNotMatch(filtered, /Bob/);
});

test('drawer: current run by default (its trades/profile only); previous run on click; all runs together on request', async () => {
  const b = boot({ is_admin: true, traders: [trader({ previous_runs: [old] })] }, detail);
  await b.tick(); b.click({ open: 'NEW' }); await b.tick();
  let d = b.els.drawerSlot.innerHTML;
  assert.match(d, /Current run only/); assert.match(d, /Previous run/); assert.match(d, /All runs together/);
  assert.match(d, /NEWSYM/); assert.doesNotMatch(d, /OLDSYM/, 'old trades are not mixed into the current run');
  assert.match(d, /NEW RUN PROFILE/); assert.doesNotMatch(d, /OLD RUN PROFILE|COMBINED PROFILE/);
  assert.match(d, /2\/80 counted trades/, 'the v2 counted-trades box shows for the current run');
  assert.match(d, /\$900\.00/, 'the Runs table still lists the old run with its own P&L');
  b.click({ run: 'OLD' });
  d = b.els.drawerSlot.innerHTML;
  assert.match(d, /OLDSYM/); assert.doesNotMatch(d, /NEWSYM/); assert.match(d, /OLD RUN PROFILE/); assert.doesNotMatch(d, /2\/80 counted trades/);
  b.click({ run: 'all' });
  d = b.els.drawerSlot.innerHTML;
  assert.match(d, /OLDSYM/); assert.match(d, /NEWSYM/); assert.match(d, /COMBINED PROFILE/);
});

test('a trader who never restarted sees exactly the old combined view (no selector)', async () => {
  const b = boot({ is_admin: true, traders: [trader({ rules_version: 'infinity_v1', previous_runs: [] })] }, { ...detail, per_account_profile: [detail.per_account_profile[0]], trades: detail.trades.slice(0, 2) });
  await b.tick(); b.click({ open: 'NEW' }); await b.tick();
  const d = b.els.drawerSlot.innerHTML;
  assert.doesNotMatch(d, /Current run only/); assert.match(d, /NEWSYM/);
});

test('"Reached Stage 2" button lists traders on Stage 2 or later (funded included) and nobody still on Stage 1', async () => {
  const mk = (id, extra) => trader({ user_id: id, account_id: id, full_name: id, email: id + '@example.com', previous_runs: [], ...extra });
  const b = boot({ is_admin: true, traders: [mk('S1', { stage: 1 }), mk('S2', { stage: 2 }), mk('S3', { stage: 3 }), mk('FUND', { stage: 1, phase: 'funded' })] }, detail);
  await b.tick();
  assert.match(b.els.filters.innerHTML, /Reached Stage 2 · 3/);
  b.click({ filter: 'Reached Stage 2' });
  const l = b.els.list.innerHTML;
  assert.match(l, />S2</); assert.match(l, />S3</); assert.match(l, />FUND</); assert.doesNotMatch(l, />S1</);
});
