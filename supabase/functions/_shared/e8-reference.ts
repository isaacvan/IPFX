// Pure reference measurements. Quotes and model prices never assert an executed broker fill.
export type RateRule = { type: string; limit: number; windowMs: number };
export type ReferenceQuote = { bid: number; ask: number; receivedAt: number; startedAt: number; accountId: number; symbol: string };
export function finiteNumber(value: unknown): number | null {
  if (value == null || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
export function epochMs(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n != null) return n > 1e11 ? n : n > 1e9 ? n * 1000 : null;
  if (typeof value === "string") { const t = Date.parse(value); return Number.isFinite(t) ? t : null; }
  return null;
}
export function referenceRules(raw: unknown): RateRule[] {
  const root = raw as Record<string, unknown> | null;
  const cfg = (root?.d ?? root?.data ?? root) as Record<string, unknown> | null;
  const limits = cfg?.rateLimits;
  const rows = Array.isArray(limits) ? limits : limits && typeof limits === "object"
    ? Object.entries(limits).map(([type, value]) => ({ rateLimitType: type, ...(value as Record<string, unknown>) })) : [];
  const out: RateRule[] = [];
  for (const row of rows) {
    const x = row as Record<string, unknown>, limit = finiteNumber(x.limit), interval = finiteNumber(x.intervalNum);
    const unit = String(x.measure ?? x.intervalType ?? "").toUpperCase();
    const type = String(x.rateLimitType ?? x.type ?? "").toUpperCase();
    if (limit == null || interval == null || !Number.isInteger(limit) || limit < 1 || interval <= 0 || !type || !["SECONDS", "MINUTES"].includes(unit)) continue;
    out.push({ type, limit, windowMs: Math.ceil(interval * (unit === "SECONDS" ? 1000 : 60000)) });
  }
  return out;
}
export function applicableRules(rules: RateRule[], route: "QUOTES" | "ORDERS_HISTORY" | "CONFIG" | "REFRESH" | "INSTRUMENT_DETAILS"): RateRule[] {
  const common = rules.filter(r => ["GLOBAL", "ALL", "ALL_REQUESTS", "GENERAL", "TOTAL"].includes(r.type));
  const aliases = route === "ORDERS_HISTORY" ? [route, "GET_ORDERS_HISTORY", "ORDER_HISTORY", "HISTORICAL_ORDERS"] : route === "INSTRUMENT_DETAILS" ? [route, "GET_INSTRUMENT_DETAILS"] : [route];
  const exact = rules.filter(r => aliases.includes(r.type));
  // Unknown layouts/routes fail closed instead of inventing a request allowance.
  if (!exact.length && !common.length) return [];
  return [...common, ...exact];
}
export function validateReferenceQuote(q: ReferenceQuote, at: number, maxAgeMs: number): boolean {
  return [q.bid,q.ask,q.receivedAt,q.startedAt,at,maxAgeMs].every(Number.isFinite) && q.bid > 0 && q.ask >= q.bid &&
    q.startedAt <= q.receivedAt && q.receivedAt <= at && at - q.receivedAt <= maxAgeMs;
}
export function referenceFill(q: ReferenceQuote | null, side: "buy" | "sell", at: number, maxAgeMs: number,
  adverseBps: number | null): { price: number; basis: string; quoteAgeMs: number } | null {
  if (!q || !validateReferenceQuote(q,at,maxAgeMs) || adverseBps == null || !Number.isFinite(adverseBps) || adverseBps < 0 || adverseBps >= 10000) return null;
  const px = side === "buy" ? q.ask : q.bid;
  return { price: px * (1 + (side === "buy" ? 1 : -1) * adverseBps / 10000),
    basis: "E8_QUOTE_WITH_CONFIGURED_SLIPPAGE_ESTIMATE", quoteAgeMs: at-q.receivedAt };
}
export function referenceNet(side: "buy" | "sell", entry: number, exit: number, lots: number, scale: number,
  totalFees: number | null): number | null {
  if (![entry,exit,lots,scale].every(Number.isFinite) || Math.min(entry,exit,lots,scale)<=0 || totalFees==null || !Number.isFinite(totalFees) || totalFees<0) return null;
  return (exit-entry)*(side==="buy"?1:-1)*lots*scale-totalFees;
}
export function measuredFill(row: Record<string, unknown>, accountId: number, role: string, names: Map<string,string>) {
  const qty=finiteNumber(row.filledQty),price=finiteNumber(row.avgPrice),ref=String(row.id ?? row.orderId ?? "");
  if (!ref || !qty || qty<=0 || !price || price<=0 || !/^filled$/i.test(String(row.status ?? ""))) return null;
  const at=epochMs(row.lastModified ?? row.createdDate);
  const commission=finiteNumber(row.commission),fee=finiteNumber(row.fee ?? row.fees),swap=finiteNumber(row.swap ?? row.swaps ?? row.rollover);
  return {account_id:accountId,role,ref,symbol:names.get(String(row.tradableInstrumentId))??null,side:row.side??null,qty,price,
    commission:commission,fee,swap,filled_at:at==null?null:new Date(at).toISOString(),raw:row,
    costs_complete:commission!=null&&fee!=null&&swap!=null};
}

export type ReplayRequest = {
 accountId:number; symbol:string; traderSide:'buy'|'sell'; book:'a'|'b'; lots:number; openedAt:number;
 closes:Array<{at:number;lots:number}>; scaleUSD:number; feesUSD:number; adverseBps:number;
 minDelayMs:number; maxWaitMs:number; assumptionSource:string;
};
// Calibration replay: first OBSERVED quote after each event plus configured delay.
// This deliberately exposes sampling wait, and never relabels the result as a broker fill.
export function replayReference(r:ReplayRequest,quotes:ReferenceQuote[]) {
 const unavailable=(reason:string)=>({available:false,reason,basis:'E8_REFERENCE_ESTIMATE',netUSD:null});
 const numbers=[r.accountId,r.lots,r.openedAt,r.scaleUSD,r.feesUSD,r.adverseBps,r.minDelayMs,r.maxWaitMs];
 if(!numbers.every(Number.isFinite)||r.lots<=0||r.scaleUSD<=0||r.feesUSD<0||r.adverseBps<0||r.adverseBps>=10000||
  r.minDelayMs<0||r.maxWaitMs<1||r.maxWaitMs>60000||!['a','b'].includes(r.book)||!['buy','sell'].includes(r.traderSide)||
  !r.assumptionSource?.trim()||!r.closes?.length||r.closes.length>50) return unavailable('INVALID_OR_MISSING_ASSUMPTIONS');
 let last=r.openedAt,total=0;
 for(const c of r.closes){if(!Number.isFinite(c.at)||!Number.isFinite(c.lots)||c.lots<=0||c.at<=last)return unavailable('INVALID_CLOSE_SEQUENCE');last=c.at;total+=c.lots;}
 if(Math.abs(total-r.lots)>Math.max(1e-9,r.lots*1e-8))return unavailable('CLOSE_QUANTITY_MISMATCH');
 const side=r.book==='b'?(r.traderSide==='buy'?'sell':'buy'):r.traderSide;
 const exitSide=side==='buy'?'sell':'buy';
 const select=(at:number)=>quotes.filter(q=>q.accountId===r.accountId&&q.symbol===r.symbol&&q.startedAt>=at+r.minDelayMs&&
  q.receivedAt<=at+r.minDelayMs+r.maxWaitMs&&validateReferenceQuote(q,q.receivedAt,r.maxWaitMs)).sort((a,b)=>a.receivedAt-b.receivedAt)[0];
 const entryQuote=select(r.openedAt);if(!entryQuote)return unavailable('ENTRY_REFERENCE_MISSING');
 const entry=referenceFill(entryQuote,side,entryQuote.receivedAt,r.maxWaitMs,r.adverseBps)!;
 const slices=[];let gross=0;
 for(const c of r.closes){
  if(entryQuote.receivedAt>=c.at)return unavailable('ENTRY_REFERENCE_ARRIVED_AFTER_CLOSE');
  const quote=select(c.at);if(!quote)return unavailable('EXIT_REFERENCE_MISSING');
  const exit=referenceFill(quote,exitSide,quote.receivedAt,r.maxWaitMs,r.adverseBps)!;
  const value=referenceNet(side,entry.price,exit.price,c.lots,r.scaleUSD,0)!;gross+=value;
  slices.push({lots:c.lots,eventAt:c.at,quoteAt:quote.receivedAt,samplingWaitMs:quote.receivedAt-c.at,price:exit.price,grossUSD:value});
 }
 return {available:true,basis:'E8_REFERENCE_ESTIMATE',side,entryPrice:entry.price,entryQuoteAt:entryQuote.receivedAt,
  entrySamplingWaitMs:entryQuote.receivedAt-r.openedAt,slices,grossUSD:gross,feesUSD:r.feesUSD,netUSD:gross-r.feesUSD,
  assumptionSource:r.assumptionSource};
}
