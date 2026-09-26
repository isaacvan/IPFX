// IPFX challenge rules as the trading engine enforces them, for testing strategies against the
// real challenge requirements.
//
// Sources (keep in step; tests/strategy-engine-rules.test.mjs checks them against the SQL):
//   Infinity S1-S4 targets, limits, risk, caps .. supabase/migrations/20260920173000_infinity_only_october_launch.sql
//   Infinity v3 qualification gates ............ same migration (challenge_qualification_versions)
//   Traditional and Futures presets ............. challenge-recalibration.sql
//   Traditional and Futures per-trade risk ...... supabase/migrations/20260920100000_phase_specific_risk_caps.sql
//   Engine constants ............................ supabase/functions/trading-engine/index.ts
// Traditional and Futures are paused for the October launch (Infinity only); they are kept so
// strategies can be checked against them when those programmes reopen.

export const ENGINE = Object.freeze({
  // effective risk = min(base, 20% of the drawdown buffer, 25% of today's loss buffer)
  drawdownBufferRiskFraction: 0.20,
  dailyBufferRiskFraction: 0.25,
  // Terms 8.1: profit from trades closed under 60s does not count toward the target
  minHoldSeconds: 60,
  maxOpenPositions: 20,
  // open risk plus the new order's risk may not exceed 3x the current per-trade limit
  maxTotalRiskMultiple: 3,
  // account_progress: a day is profitable when its closed P&L exceeds 0.25% of the starting balance
  profitableDayFraction: 0.0025,
});

const infinityQual = (minElapsedDays, minTradingDays, minSessions, maxBestDayShare) =>
  Object.freeze({ minElapsedDays, minTradingDays, minSessions, maxBestDayShare, minDailyNetFraction: 0.001, sessionFlatGapMinutes: 60 });

function preset(p) { return Object.freeze({ dailyProfitCapPct: null, minProfitableDaysPct: null, qualification: null, requireStop: true, ...p }); }

export const PRESETS = Object.freeze({
  infinity_s1: preset({ programme: "infinity", stage: 1, name: "Infinity Stage 1", balance: 1000, targetPct: 8, ddPct: 5, ddMode: "trailing_intraday",
    dailyLossPct: 2.5, riskPct: 0.50, dailyProfitCapPct: 1.5, minTradingDays: 10, minTrades: 30, qualification: infinityQual(14, 10, 30, 0.35), next: "infinity_s2" }),
  infinity_s2: preset({ programme: "infinity", stage: 2, name: "Infinity Stage 2", balance: 5000, targetPct: 6, ddPct: 4, ddMode: "trailing_intraday",
    dailyLossPct: 2, riskPct: 0.35, dailyProfitCapPct: 1.25, minTradingDays: 15, minTrades: 60, minProfitableDaysPct: 55, qualification: infinityQual(21, 15, 60, 0.25), next: "infinity_s3" }),
  infinity_s3: preset({ programme: "infinity", stage: 3, name: "Infinity Stage 3", balance: 10000, targetPct: 7, ddPct: 4, ddMode: "trailing_intraday",
    dailyLossPct: 2, riskPct: 0.35, dailyProfitCapPct: 1.25, minTradingDays: 10, minTrades: 40, minProfitableDaysPct: 50, qualification: infinityQual(14, 10, 40, 0.30), next: "infinity_s4" }),
  // Stage 4 is the professional (funded) stage: no target, it is about surviving and getting paid.
  infinity_s4: preset({ programme: "infinity", stage: 4, name: "Infinity Stage 4", balance: 25000, targetPct: 0, ddPct: 4, ddMode: "trailing_eod",
    dailyLossPct: 2, riskPct: 0.25, minTradingDays: 0, minTrades: 0, next: null }),
});

// Traditional: identical rules at every size, so one set per phase with the size as a parameter.
const TRAD = { 1: { targetPct: 8, riskPct: 0.75 }, 2: { targetPct: 5, riskPct: 0.50 }, 3: { targetPct: 4, riskPct: 0.40 } };
const FUT = { 1: { targetPct: 6, riskPct: 0.50 }, 2: { targetPct: 4, riskPct: 0.40 } };
export function traditional(balance, phase) {
  return preset({ programme: "traditional", stage: phase, name: `Traditional ${balance / 1000}K Phase ${phase}`, balance, ...TRAD[phase],
    ddPct: 6, ddMode: "static", dailyLossPct: 3, minTradingDays: 5, minTrades: 15, next: phase < 3 ? phase + 1 : null });
}
export function futures(balance, phase) {
  return preset({ programme: "futures", stage: phase, name: `Futures ${balance / 1000}K Phase ${phase}`, balance, ...FUT[phase],
    ddPct: 4, ddMode: "trailing_eod", dailyLossPct: 2, minTradingDays: 6, minTrades: 30, next: phase < 2 ? phase + 1 : null });
}

// IPFX's quoted spreads (full spread, price units), from INSTRUMENTS in trading-engine/index.ts.
// The engine synthesises these on its testing feed, so they are what a trader pays today.
export const SPREADS = Object.freeze({
  EURUSD: 0.0002, GBPUSD: 0.0003, USDJPY: 0.03, AUDUSD: 0.0003, USDCAD: 0.0003, USDCHF: 0.0004, NZDUSD: 0.0004,
  GBPJPY: 0.05, EURJPY: 0.04, EURGBP: 0.0003, EURCAD: 0.0005, AUDCAD: 0.0006,
  XAUUSD: 0.30, XAGUSD: 0.05, XPTUSD: 0.80, XPDUSD: 1.20,
  SPXUSD: 0.5, NSXUSD: 1.5, DJI: 2.0, UK100: 1.0, GER40: 1.5, FRA40: 1.5, JPN225: 8.0, US2000: 0.8,
  BTCUSD: 25, ETHUSD: 2.5, LTCUSD: 0.5, ADAUSD: 0.003, SOLUSD: 0.15, DOTUSD: 0.02,
});
