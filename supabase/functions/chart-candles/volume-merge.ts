// Volume for spot instruments that report none.
//
// Spot forex is over-the-counter, so its candle history carries no volume (Yahoo returns 0). The CME
// currency futures are exchange-traded, trade nearly around the clock, and follow the spot rate
// closely, so their volume is the standard stand-in. We fetch the matching future for volume only;
// prices always come from the spot history. Pure functions, no imports, so they can be unit tested.

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

// spot symbol -> [Yahoo futures code, description shown to the trader]
export const VOLUME_PROXY: Record<string, [string, string]> = {
  EURUSD: ["6E=F", "CME Euro FX (6E) futures"],
  GBPUSD: ["6B=F", "CME British pound (6B) futures"],
  USDJPY: ["6J=F", "CME Japanese yen (6J) futures"],
  AUDUSD: ["6A=F", "CME Australian dollar (6A) futures"],
  USDCAD: ["6C=F", "CME Canadian dollar (6C) futures"],
  USDCHF: ["6S=F", "CME Swiss franc (6S) futures"],
  NZDUSD: ["6N=F", "CME New Zealand dollar (6N) futures"],
  EURGBP: ["RP=F", "CME Euro/British pound (RP) futures"],
  EURJPY: ["RY=F", "CME Euro/Japanese yen (RY) futures"],
};

// Which bucket a bar belongs to, so a spot bar and a futures bar for the same period share a key.
// Intraday: the same UTC time. Spot daily bars open at the 22:00 UTC FX rollover (stamped 22:00-23:00
// the evening before) while futures daily bars carry their trade date, so spot is shifted back 22h;
// weekly spot bars are stamped up to 2h before the week begins. Alignments confirmed against
// return correlation on a year of EUR/USD and GBP/USD (0.70 daily, 0.95 weekly vs ~0.1 unaligned).
export function volumeKey(t: number, seconds: number, isFutures: boolean): number {
  if (seconds < 86400) return t;
  if (seconds <= 86400) return Math.floor((isFutures ? t : t - 79200) / 86400);
  return Math.floor((isFutures ? t : t + 7200) / 604800);
}

// Copies futures volume onto the spot bars (in place). Returns how many spot bars got a volume.
export function mergeVolume(spot: Bar[], fut: Bar[], seconds: number): number {
  const byKey = new Map<number, number>();
  for (const f of fut) {
    const k = volumeKey(f.t, seconds, true);
    byKey.set(k, (byKey.get(k) ?? 0) + (f.v || 0));
  }
  let matched = 0;
  for (const s of spot) {
    const v = byKey.get(volumeKey(s.t, seconds, false));
    if (v !== undefined && v > 0) { s.v = v; matched++; }
  }
  return matched;
}
