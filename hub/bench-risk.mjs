// Position-watcher benchmark: 2,000 accounts x 3 positions over 30 symbols, plus 500 resting orders.
// Measures the CPU time to process one price batch (30 changed symbols), the pump's 250ms pace.
import { Risk } from './risk.mjs';

const SYMS = Array.from({ length: 30 }, (_, i) => 'SYM' + i);
const quotes = new Map();
const r = new Risk({ quotes, mode: 'shadow', log: () => {}, rpc: async () => null, engine: async () => ({ ok: true }) });
r.specs = Object.fromEntries(SYMS.map((s) => [s, { contract: 100000, quote: 'USD', digits: 5 }]));
const today = new Date().toISOString().slice(0, 10);
const accounts = [], trades = [], pending = [];
for (let a = 0; a < 2000; a++) {
  const id = `acc-${a}`;
  accounts.push({ id, status: 'active', balance: 100000, starting_balance: 100000, max_drawdown_pct: 10, daily_loss_pct: 5, day_start_equity: 100000, day_start_date: today, drawdown_mode: a % 3 ? 'static' : 'trailing_intraday', total_paid_out: 0, challenge_type: 'infinity' });
  for (let k = 0; k < 3; k++) trades.push({ id: `t-${a}-${k}`, account_id: id, symbol: SYMS[(a + k * 7) % 30], side: k % 2 ? 'buy' : 'sell', volume: 0.5, open_price: 1, sl: 0.9, tp: 1.1, trail_distance: k === 2 ? 0.002 : null, opened_at: new Date().toISOString() });
  if (a % 4 === 0) pending.push({ id: `p-${a}`, account_id: id, symbol: SYMS[a % 30], side: 'buy', order_type: 'limit', trigger_price: 0.95, expires_at: null });
}
r.apply({ accounts, trades, pending, sl_deadline_seconds: null }, null);

const rounds = 400, times = [];
for (let i = 0; i < rounds; i++) {
  const t0 = process.hrtime.bigint();
  for (const s of SYMS) { const m = 1 + (Math.random() - 0.5) * 0.004; const q = { s, b: m - 0.00005, a: m + 0.00005, m, at: Date.now() }; quotes.set(s, q); r.onQuote(q); }
  times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  r.queue.clear(); r.cooldown.clear();
}
times.sort((a, b) => a - b);
const pick = (p) => times[Math.floor(times.length * p)].toFixed(2);
console.log(JSON.stringify({ accounts: accounts.length, positions: trades.length, pendingOrders: pending.length, symbolsPerBatch: SYMS.length,
  msPerBatch: { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99) }, cpuShareAt4BatchesPerSec: (Number(pick(0.5)) * 4 / 10).toFixed(1) + '%' }));
