export type SimpleTraderCategory =
  | "scalper"
  | "news_event_trader"
  | "swing_trader"
  | "high_frequency_trader"
  | "unclassified";

export type RiskTrade = {
  id?: string;
  symbol: string;
  volume: number | string;
  opened_at: string;
  closed_at?: string | null;
  pnl?: number | string | null;
  status?: string;
};

export type MacroEvent = {
  id?: string | number;
  event_at: string;
  country?: string | null;
  currency?: string | null;
  importance: number;
  event_name?: string | null;
};

export type TraderStyleProfile = {
  category: SimpleTraderCategory;
  confidence: number;
  evidence: Record<string, unknown>;
};

const median = (values: number[]) => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const COUNTRY_CURRENCY: Record<string, string> = {
  "united states": "USD", "united kingdom": "GBP", "euro area": "EUR",
  japan: "JPY", switzerland: "CHF", canada: "CAD", australia: "AUD",
  "new zealand": "NZD", china: "CNY",
};

export function normalizedSymbolCurrencies(symbol: string): string[] {
  const clean = String(symbol || "").toUpperCase().replace(/[^A-Z]/g, "");
  const currencies = new Set<string>();
  for (const code of ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY"]) {
    if (clean.includes(code)) currencies.add(code);
  }
  if (/^(XAU|XAG|US30|NAS|USTEC|SPX|US500|DJI)/.test(clean)) currencies.add("USD");
  if (/^(DE|GER|DAX)/.test(clean)) currencies.add("EUR");
  if (/^(UK|FTSE)/.test(clean)) currencies.add("GBP");
  return [...currencies];
}

export function eventCurrency(event: MacroEvent): string | null {
  const direct = String(event.currency || "").toUpperCase().match(/[A-Z]{3}/)?.[0];
  return direct || COUNTRY_CURRENCY[String(event.country || "").toLowerCase()] || null;
}

export function matchingMacroEvent(
  trade: RiskTrade,
  events: MacroEvent[],
  windowMinutes = 30,
): MacroEvent | null {
  const opened = new Date(trade.opened_at).getTime();
  if (!Number.isFinite(opened)) return null;
  const currencies = normalizedSymbolCurrencies(trade.symbol);
  const windowMs = Math.max(1, windowMinutes) * 60_000;
  return events
    .filter((event) => event.importance >= 2 && currencies.includes(eventCurrency(event) || ""))
    .map((event) => ({ event, distance: Math.abs(opened - new Date(event.event_at).getTime()) }))
    .filter((match) => Number.isFinite(match.distance) && match.distance <= windowMs)
    .sort((a, b) => a.distance - b.distance)[0]?.event ?? null;
}

export function classifyTrader(tradesInput: RiskTrade[], events: MacroEvent[]): TraderStyleProfile {
  const trades = tradesInput.filter((t) => Number.isFinite(new Date(t.opened_at).getTime()));
  const closed = trades.filter((t) => t.closed_at && Number.isFinite(new Date(t.closed_at).getTime()));
  if (trades.length < 5) {
    return { category: "unclassified", confidence: 0.2, evidence: { trades: trades.length, minimum_trades: 5 } };
  }

  const newsMatches = trades.filter((trade) => matchingMacroEvent(trade, events, 30)).length;
  const newsRatio = newsMatches / trades.length;
  const days = new Set(trades.map((t) => new Date(t.opened_at).toISOString().slice(0, 10))).size || 1;
  const tradesPerDay = trades.length / days;
  const holdMinutes = closed.map((t) => Math.max(0, (new Date(t.closed_at!).getTime() - new Date(t.opened_at).getTime()) / 60_000));
  const medianHold = median(holdMinutes);

  let category: SimpleTraderCategory;
  let confidence = 0.55;
  if (newsMatches >= 3 && newsRatio >= 0.35) {
    category = "news_event_trader";
    confidence = Math.min(0.95, 0.55 + newsRatio * 0.4);
  } else if (tradesPerDay >= 30 || (tradesPerDay >= 15 && holdMinutes.length >= 5 && medianHold <= 2)) {
    category = "high_frequency_trader";
    confidence = Math.min(0.95, 0.55 + Math.min(tradesPerDay / 100, 0.4));
  } else if (holdMinutes.length >= 3 && medianHold <= 15) {
    category = "scalper";
    confidence = Math.min(0.9, 0.55 + Math.min(closed.length / 100, 0.35));
  } else if (holdMinutes.length >= 3 && medianHold >= 240) {
    category = "swing_trader";
    confidence = Math.min(0.9, 0.55 + Math.min(closed.length / 100, 0.35));
  } else {
    category = "unclassified";
    confidence = 0.35;
  }

  return {
    category,
    confidence: Math.round(confidence * 100) / 100,
    evidence: {
      trades: trades.length,
      closed_trades: closed.length,
      active_days: days,
      trades_per_active_day: Math.round(tradesPerDay * 100) / 100,
      median_hold_minutes: Math.round(medianHold * 100) / 100,
      news_window_minutes: 30,
      news_event_trades: newsMatches,
      news_event_ratio: Math.round(newsRatio * 1000) / 1000,
      classifier_version: "simple-v1",
    },
  };
}

export type MirrorRiskDecision = {
  action: "allow" | "reduce" | "skip";
  multiplier: number;
  reasons: string[];
  unusual_size_multiple: number | null;
};

export function decideMirrorRisk(input: {
  event: "open" | "close";
  mode: "observe" | "adaptive" | "blocked";
  trade: RiskTrade;
  recentTrades: RiskTrade[];
  openFlagReasons?: string[];
  category?: SimpleTraderCategory;
  nearHighImpactNews?: boolean;
  minMultiplier?: number;
  unusualSizeMultiple?: number;
  newsMultiplier?: number;
}): MirrorRiskDecision {
  if (input.event === "close") return { action: "allow", multiplier: 1, reasons: ["closing risk is never blocked"], unusual_size_multiple: null };
  if (input.mode === "blocked") return { action: "skip", multiplier: 0, reasons: ["owner policy blocks new mirrored exposure"], unusual_size_multiple: null };

  const reasons: string[] = [];
  let recommended = 1;
  const sameSymbolVolumes = input.recentTrades
    .filter((t) => t.symbol === input.trade.symbol && Number(t.volume) > 0)
    .slice(0, 30).map((t) => Number(t.volume));
  const baseline = median(sameSymbolVolumes);
  const multiple = baseline > 0 ? Number(input.trade.volume) / baseline : null;
  const unusualAt = Math.max(1.5, input.unusualSizeMultiple ?? 3);
  if (sameSymbolVolumes.length >= 10 && multiple !== null && multiple >= unusualAt) {
    recommended = Math.min(recommended, 1 / multiple);
    reasons.push(`size ${multiple.toFixed(2)}x the trader's recent ${input.trade.symbol} median`);
  }

  const severe = new Set(["ACCOUNT_STOP_RISK_LIMIT", "DRAWDOWN_SWING", "REQUIRED_STOP_MISSING", "CAP_HUGGING"]);
  const severeReasons = (input.openFlagReasons ?? []).filter((r) => severe.has(r));
  if (severeReasons.length) {
    recommended = 0;
    reasons.push(`severe trade-risk flag: ${severeReasons.join(", ")}`);
  }
  if (input.nearHighImpactNews) {
    const newsMultiplier = Math.max(0, Math.min(1, input.newsMultiplier ?? 0.25));
    recommended = Math.min(recommended, newsMultiplier);
    reasons.push("opened near a high-impact macro event");
  }

  if (!reasons.length) reasons.push("within observed sizing and event-risk controls");
  if (input.mode === "observe") return { action: "allow", multiplier: 1, reasons: ["observe mode", ...reasons], unusual_size_multiple: multiple };
  if (recommended <= 0) return { action: "skip", multiplier: 0, reasons, unusual_size_multiple: multiple };
  const min = Math.max(0.01, Math.min(1, input.minMultiplier ?? 0.1));
  const multiplier = Math.max(min, Math.min(1, recommended));
  return { action: multiplier < 0.999 ? "reduce" : "allow", multiplier, reasons, unusual_size_multiple: multiple };
}
