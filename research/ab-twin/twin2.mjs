// A/B-book digital twin: runs the PRODUCTION decision code (classifier, allocator, ladder controller, treasury
// forecaster) against a simulated trader population and market, with funded prop accounts trading the
// copied signals under E8-style rules. Used to stress-test the system and compare variants.
// node research/ab-twin/twin.mjs <scenario> [seeds]
import { decide, POLICY_V1 } from '../../supabase/functions/_shared/ab-classifier.ts';
import { fundedRiskUsd, sizeMultiplier } from '../../supabase/functions/_shared/ab-allocator.ts';
import { ladderDecision } from '../../supabase/functions/_shared/ladder.ts';

const DAY = 86_400_000, T0 = Date.parse('2026-10-09T08:00:00Z');
const WIN = 1.2;
const STAGES = { 1: [1000, .04, .05, .025, .005, .014, 10, 30, 0], 2: [5000, .05, .04, .02, .0035, .0125, 15, 60, .40], 3: [10000, .06, .04, .02, .0035, .0125, 10, 40, 0] };

export const SCENARIOS = {
  base:        { label: 'Skill persists, standard costs' },
  fades:       { label: 'Skill fades (monthly regression to the mean)', drift: true },
  lowcost:     { label: 'Low-cost venue (0.03R round trip)', cB: 0.03 },
  fades_low:   { label: 'Skill fades + low-cost venue', drift: true, cB: 0.03 },
  volume3x:    { label: '3x sign-ups', volume: 3 },
  gamers:      { label: '5% duplicate-account gamers farming the 2.75% rule', gamers: 0.05 },
  herd:        { label: '20% herd traders following one signal service', herd: 0.20 },
  shocks:      { label: 'Frequent news shocks (3x gap days)', shockP: 0.09 },
  latency:     { label: '3% latency-arbitrage traders (edge on IPFX, not copyable)', latency: 0.03 },
  thin_quotes: { label: '40% of trades without saved quotes (replay gaps)', quoteGap: 0.4 },
};

function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function simulate(scName, seed = 1, opts = {}) {
  const sc = { cIpfx: 0.10, cB: 0.08, drift: false, volume: 1, gamers: 0, herd: 0, shockP: 0.03, latency: 0, quoteGap: 0, months: 6, ...SCENARIOS[scName], ...opts };
  const policy = { ...POLICY_V1, stage2AutoTarget: 'AB_LIVE', ...(sc.policy ?? {}) };
  const r = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
  const DAYS = 21 * sc.months;
  const traders = [];
  const addTrader = (joinDay, kind = 'normal', mu = null, pairWith = null) => {
    const g = r();
    let m = mu ?? (g < 0.85 ? -0.15 + 0.10 * gauss() : g < 0.98 ? -0.02 + 0.05 * gauss() : 0.10 + 0.06 * gauss());
    traders.push({ id: traders.length, joinDay, kind, mu: Math.max(-0.8, Math.min(0.6, m)), mu0: m, stage: 0, startDay: joinDay,
      bal: 0, peak: 0, sod: 0, nTr: 0, nDays: 0, pDays: 0, points: [], state: 'BB_DEMO', since: T0 + joinDay * DAY, lastAbExit: null,
      pairWith, graduated: false, stagesPassed: 0, s275: false });
  };
  for (let m = 0; m < sc.months; m++) {
    const n = Math.round(610 * Math.pow(1.15, m) * sc.volume);
    for (let k = 0; k < n; k++) {
      const day = m * 21 + Math.floor(r() * 21);
      const u = r();
      if (u < sc.gamers) { // two accounts of one person trading opposite sides: one of them "wins" by construction
        addTrader(day, 'gamerA', 0.0); addTrader(day, 'gamerB', 0.0, traders.length - 1); traders[traders.length - 2].pairWith = traders.length - 1;
      } else if (u < sc.gamers + sc.herd) addTrader(day, 'herd', 0.0);
      else if (u < sc.gamers + sc.herd + sc.latency) addTrader(day, 'latency', 0.15);
      else addTrader(day);
    }
  }
  // funded prop accounts (ladder)
  const accounts = []; let feesPaid = 0, payoutsReceived = 0, cash = 0, minCash = 0;
  const FEE = 300, SIZE = 50_000;
  const newAccount = (day, group) => { accounts.push({ day, group, bal: SIZE, floor: SIZE - 3000, phase: 'eval', alive: true, lastPo: null, firstDone: false }); feesPaid += FEE; cash -= FEE; };
  const ladderSettings = { seed: 1500, reinvest: 0.5, fee: FEE, maxActive: 30, minTrades: 200, breakEvenR: 0.03 };
  const GROUPS = sc.groups ?? 3;
  let graduates = 0, sponsorCost = 0, decisionsLog = { bbLive: 0, abLive: 0, suspended: 0, gamerPromoted: 0, latencyPromoted: 0, herdPromoted: 0 };
  const evidenceWindow = [];
  let herdSignal = 0; let bBal = 0, bookBPnl = 0;
  for (let d = 0; d < DAYS; d++) {
    const now = T0 + d * DAY + 23 * 3_600_000;
    if (sc.drift && d % 21 === 0 && d > 0) for (const t of traders) if (t.kind === 'normal') t.mu = Math.max(-0.8, Math.min(0.6, 0.85 * t.mu - 0.15 * 0.13 + 0.03 * gauss()));
    const shock = r() < sc.shockP;
    herdSignal = r() < 0.5 ? 1 : -1;
    const copiedToday = [];   // { r (copy R per unit), weight, person }
    const reversedToday = [];
    for (const t of traders) {
      if (t.graduated) continue;
      if (t.stage === 0 && t.startDay === d) { t.stage = 1; t.bal = 0; t.peak = 0; t.nTr = 0; t.nDays = 0; t.pDays = 0; }
      if (t.stage === 0 || d < t.startDay || r() > 0.7) continue;
      const [b0, tgt, dd, dl, rk, cap, mind, mint, mpd] = STAGES[t.stage];
      const R = b0 * rk; const T = tgt * b0 / R, D = dd * b0 / R, L = dl * b0 / R, C = cap * b0 / R;
      t.sod = t.bal; let traded = false;
      for (let k = 0; k < 3; k++) {
        if (t.bal - t.sod >= C) break;
        let o;
        // gamerB holds the opposite position to its partner: its raw result is the partner's raw result negated
        // (a win of +1.2R against a loss of -1R is approximated symmetrically), then its own slippage applies.
        if (t.kind === 'gamerB') { const ra = traders[t.pairWith].lastRaw ?? (r() < 0.5 ? WIN : -1); o = -ra - 2 * sc.cIpfx; }  // opposite gross, and it pays its own costs too
        else if (t.kind === 'herd') o = (herdSignal > 0 ? (r() < 0.47 ? WIN : -1) : (r() < 0.43 ? WIN : -1));
        else { const p = (1 + t.mu) / (1 + WIN); o = (r() < p && (!shock || t.kind === 'gamerA')) ? WIN : -1; }
        t.lastRaw = o;
        if (o < 0 && r() < (shock ? 0.12 : 0.03)) o *= 1.5;
        t.bal += o; t.nTr++; traded = true; t.peak = Math.max(t.peak, t.bal);
        // ledger replay: latency traders' edge is not copyable (the broker price has already moved)
        const lag = t.kind === 'latency' ? 0.20 : 0;
        if (r() >= sc.quoteGap) t.points.push({ closedAt: T0 + d * DAY + k * 3_600_000, sameR: o + sc.cIpfx - sc.cB - lag, reverseR: -o - sc.cIpfx - sc.cB + lag, holdSeconds: t.kind === 'latency' ? 90 : 600, traderR: o });
        if (t.state === 'BB_LIVE') reversedToday.push({ r: -o - sc.cIpfx - sc.cB + lag, t });
        if (t.state === 'AB_LIVE') copiedToday.push({ r: o + sc.cIpfx - sc.cB - lag, person: t.id, progress: t.stagesPassed >= 2 ? 'STAGE3_COMPLETE' : t.stagesPassed >= 1 && t.stage >= 3 ? 'STAGE2_PASSED' : 'EARLY', t });
        if (t.bal <= t.peak - D || t.bal <= t.sod - L) { t.stage = 0; t.startDay = r() < 0.5 ? (Math.floor(d / 21) + 1) * 21 : 1e9; break; }
      }
      if (t.stage === 0) continue;
      if (traded) { t.nDays++; if (t.bal - t.sod > 0.0025 * b0 / R) t.pDays++; }
      if (t.stage === 2 && t.bal >= 0.0275 * b0 / R && !t.s275) t.s275 = true;
      if (t.bal >= T && t.nDays >= mind && t.nTr >= mint && t.pDays >= mpd * Math.max(1, t.nDays)) {
        t.stagesPassed++;
        if (t.stage === 3) { t.graduated = true; graduates++; sponsorCost += 350; cash -= 350; continue; }
        t.stage++; t.bal = 0; t.peak = 0; t.nTr = 0; t.nDays = 0; t.pDays = 0;
      }
    }
    // classifier (production decide), only for traders with something new
    for (const t of traders) {
      if (t.graduated || t.points.length === 0) continue;
      if (t.points[t.points.length - 1].closedAt < T0 + d * DAY) continue;
      const stage2Pct = t.stage === 2 ? (t.bal * STAGES[2][4] * STAGES[2][0]) / STAGES[2][0] * 100 : null;
      const dec = decide({ state: t.state, stateSince: t.since, lastAbExitAt: t.lastAbExit, now, points: t.points,
        suspend: null, stage2ProfitPct: stage2Pct }, policy);
      if (dec) {
        if ((t.state === 'AB_DEMO' || t.state === 'AB_LIVE') && dec.to.startsWith('BB')) t.lastAbExit = now;
        t.state = dec.to; t.since = now;
        if (dec.to === 'AB_LIVE') { decisionsLog.abLive++; if (t.kind.startsWith('gamer')) decisionsLog.gamerPromoted++; if (t.kind === 'latency') decisionsLog.latencyPromoted++; if (t.kind === 'herd') decisionsLog.herdPromoted++; }
        if (dec.to === 'BB_LIVE') decisionsLog.bbLive++;
      }
    }
    // ladder: monthly purchase decision from pooled evidence (production ladderDecision)
    for (const c of copiedToday) evidenceWindow.push({ d, r: c.r });
    while (evidenceWindow.length && evidenceWindow[0].d < d - 21) evidenceWindow.shift();
    if (d % 5 === 0) {
      const byDay = new Map(); for (const e of evidenceWindow) byDay.set(e.d, (byDay.get(e.d) ?? 0) + e.r);
      const days = [...byDay.values()]; const dm = days.length ? days.reduce((a, b) => a + b, 0) / days.length : null;
      const dsd = days.length > 1 ? Math.sqrt(days.reduce((a, b) => a + (b - dm) ** 2, 0) / (days.length - 1)) : null;
      const mean = evidenceWindow.length ? evidenceWindow.reduce((a, e) => a + e.r, 0) / evidenceWindow.length : null;
      const active = accounts.filter((a) => a.alive).length;
      const dec = ladderDecision(ladderSettings, { trades: evidenceWindow.length, meanR: mean, days: days.length, dayMean: dm, daySd: dsd }, active, payoutsReceived, feesPaid);
      if (dec.action === 'buy') for (let k = 0; k < dec.accounts; k++) newAccount(d, accounts.length % GROUPS);
    }
    // funded accounts trade today's copied signals in their group (production fundedRiskUsd + cap logic)
    for (const a of accounts) {
      if (!a.alive || a.day > d) continue;
      const mine = copiedToday.filter((c) => c.person % GROUPS === a.group);
      a.sod = a.bal; let open = 0;
      for (const c of mine) {
        const dayPnl = a.bal - a.sod;
        if (dayPnl >= 1000 || -dayPnl >= 1000) break;
        const sizing = sizeMultiplier('a', c.t.points, c.t.since, 6, policy);
        const f = fundedRiskUsd('a', { accountSizeUsd: SIZE, dailyBudgetPct: sc.budgetPct ?? 2.5, perTradeMinPct: 0.1, perTradeMaxPct: 0.5 }, Math.max(4, mine.length), c.progress, sizing);
        const room = Math.min(a.bal - (a.sod - 1250), a.bal - a.floor, (1000 + dayPnl - open) / 2.5);
        const risk = Math.min(f.riskUsd, 250, room);
        if (risk < f.riskUsd * 0.2) continue;
        a.bal += risk * c.r;
        if (a.bal <= a.sod - 1250 || a.bal <= a.floor) { a.alive = false; break; }
      }
      if (!a.alive) continue;
      if (a.bal > a.sod + 1000) a.bal = a.sod + 1000;
      if (a.phase === 'eval' && a.bal - SIZE >= 3000) { a.phase = 'funded'; a.bal = SIZE; a.floor = SIZE - 3000; a.lastPo = SIZE; }
      else if (a.phase === 'funded') {
        const need = a.firstDone ? 500 : (sc.firstPo ?? 2000);
        if (a.bal - a.lastPo >= need && a.bal > SIZE) { const po = 0.8 * 0.5 * (a.bal - SIZE); payoutsReceived += po; cash += po; a.bal = SIZE + 0.5 * (a.bal - SIZE); a.lastPo = a.bal; if (!a.firstDone) { a.firstDone = true; a.floor = SIZE; } }
      }
    }
    // B-book: IPFX's own $50K account reversing B-book-live traders (real capital; daily stop and cap).
    if (sc.bookB) {
      const sod = bBal; let n = reversedToday.length;
      for (const c of reversedToday) {
        const dayPnl = bBal - sod;
        if (dayPnl >= 1000 || -dayPnl >= 1000) break;
        const sizing = sizeMultiplier('b', c.t.points, c.t.since, 3, policy);
        const f = fundedRiskUsd('b', { accountSizeUsd: 50000, dailyBudgetPct: sc.budgetPct ?? 2.5, perTradeMinPct: 0.1, perTradeMaxPct: 0.5 }, Math.max(4, n), 'EARLY', sizing);
        const risk = Math.min(f.riskUsd, 250, (1000 + dayPnl) / 2.5);
        if (risk <= 0) break;
        bBal += risk * c.r;
      }
      cash += bBal - sod; bookBPnl += bBal - sod;
    }
    minCash = Math.min(minCash, cash);
  }
  return { scenario: scName, seed, traders: traders.length, graduates, sponsorCost, accounts: accounts.length, accountsBreached: accounts.filter((a) => !a.alive).length,
    feesPaid, payoutsReceived, cash, minCash, bookBPnl, ...decisionsLog };
}

const sc = process.argv[2] || 'base', variant = JSON.parse(process.argv[3] || '{}'), seeds = Number(process.argv[4] || 8), tag = process.argv[5] || '';
const rows = []; for (let s = 1; s <= seeds; s++) rows.push(simulate(sc, 100 + s, variant));
const avg = (k) => rows.reduce((a, x) => a + x[k], 0) / rows.length;
const cashes = rows.map((x) => x.cash).sort((a, b) => a - b);
console.log(JSON.stringify({ tag, scenario: sc, variant, seeds, cash_mean: Math.round(avg('cash')), cash_p10: Math.round(cashes[Math.floor(seeds * 0.1)]), cash_worst: Math.round(cashes[0]),
  accounts: avg('accounts'), breached: avg('accountsBreached'), payouts: Math.round(avg('payoutsReceived')), fees: Math.round(avg('feesPaid')), abLive: avg('abLive'),
  gamerPromoted: avg('gamerPromoted'), latencyPromoted: avg('latencyPromoted'), bookB: Math.round(avg('bookBPnl')), bbLive: avg('bbLive'), P_negative: rows.filter((x) => x.cash < 0).length / seeds }));
