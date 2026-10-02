// Hedge-first ("STP") execution for copied (A-book) trades. Pure functions, no I/O.
//
// The trader's fill on a copied trade is never better than the hedge's real broker fill:
// the engine places the hedge first, inside the execution delay every order already has,
// then fills the trader at the WORSE of the IPFX execution price and the broker's fill.
// Per unit traded, the hedge therefore earns at least what the trader earns, on every
// open and every close: no feed gap, lag or slippage between the two can leak profit.

type Px = number | null | undefined;
const ok = (v: Px): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

// takingAsk = buying (opening a buy, closing a sell): the worse price is the higher one.
export function worseFill(takingAsk: boolean, ...prices: Px[]): number | null {
  const xs = prices.filter(ok);
  if (!xs.length) return null;
  return takingAsk ? Math.max(...xs) : Math.min(...xs);
}

// The broker leg carries no take-profit and only a wide "disaster" stop. IPFX alone decides
// when a copied trade closes, so the hedge can never be closed by a broker trigger while the
// trader's position stays open. The disaster stop only protects the hedge if IPFX is down.
export function disasterStop(side: "buy" | "sell", entry: Px, sl: Px, multiple = 3): number | null {
  if (!ok(entry) || !ok(sl)) return null;
  const dist = Math.abs(entry - sl);
  if (!(dist > 0)) return null;
  const stop = side === "buy" ? entry - dist * multiple : entry + dist * multiple;
  return stop > 0 ? stop : null;
}

// What to do when a hedge close is already claimed by another request (two tabs, the state
// poll and the sweep racing the same stop). Use the broker's price once it exists; wait while
// the other request is in flight; after staleMs give up on the hedge price so a crashed
// request can never leave the trader's position stuck open.
export type ExistingClaim = { status?: string | null; fill_price?: Px; created_at?: string | null };
export function closeClaimAction(row: ExistingClaim | null | undefined, nowMs: number, staleMs = 15_000):
  "use_price" | "busy" | "proceed_unhedged" {
  if (!row) return "proceed_unhedged";
  if (ok(row.fill_price)) return "use_price";
  const age = nowMs - Date.parse(String(row.created_at ?? ""));
  if (row.status === "sent" && Number.isFinite(age) && age < staleMs) return "busy";
  return "proceed_unhedged";
}

// Hedge per-unit P&L minus trader per-unit P&L, in price units. >= 0 means every tick the
// trader made was captured by the hedge (anything above 0 is extra spread kept by IPFX).
export function capturePerUnit(side: "buy" | "sell", traderOpen: number, traderClose: number, hedgeOpen: number, hedgeClose: number): number {
  const dir = side === "buy" ? 1 : -1;
  return dir * ((hedgeClose - hedgeOpen) - (traderClose - traderOpen));
}
