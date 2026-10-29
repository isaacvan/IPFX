// Validation kernel, to be called INSIDE the same transaction as risk reservation.
// These helpers do not acquire locks and are not standalone order enforcement.
const finite = n => typeof n==='number' && Number.isFinite(n);
export function validateStop({side,entry,price,oldStop=null,newStop,bid,ask,rules}) {
  if (![entry,price,newStop,bid,ask].every(finite) || ask<=bid) return 'LIVE_PRICE_AND_STOP_REQUIRED';
  if (side!=='buy' && side!=='sell') return 'INVALID_SIDE';
  if (oldStop!=null && (!finite(oldStop) || (side==='buy' ? newStop<oldStop : newStop>oldStop))) return 'STOP_CANNOT_WIDEN';
  const distance=side==='buy'?price-newStop:newStop-price;
  if(distance+1e-12<(ask-bid)*rules.stop_spread_multiple) return 'STOP_TOO_CLOSE';
  return null;
}
export function validateRisk({groupOpeningRisk,additionalOpeningRisk,openRisk,additionalOpenRisk,perTradeLimit,rules}) {
  if (![groupOpeningRisk,additionalOpeningRisk,openRisk,additionalOpenRisk,perTradeLimit].every(finite) ||
    Math.min(groupOpeningRisk,additionalOpeningRisk,openRisk,additionalOpenRisk,perTradeLimit)<0) return 'RISK_UNAVAILABLE';
  if (groupOpeningRisk+additionalOpeningRisk>perTradeLimit+0.000001) return 'COUNTED_TRADE_RISK_LIMIT';
  if (openRisk+additionalOpenRisk>perTradeLimit*rules.total_risk_multiple+0.000001) return 'TOTAL_OPEN_RISK_LIMIT';
  return null;
}
export function pauseRemainingSeconds(lastStopOut,now,rules) {
  if(lastStopOut==null) return 0;
  const last=Date.parse(lastStopOut);
  if(!Number.isFinite(last)||!Number.isFinite(now)) throw new Error('INVALID_PAUSE_TIME');
  return Math.max(0,Math.ceil((last+rules.stop_pause_seconds*1000-now)/1000));
}
export function referencePricing({mid,currentBid,currentAsk,referenceBid,referenceAsk,referenceFresh,profile}) {
  if(![mid,currentBid,currentAsk].every(finite)||currentAsk<=currentBid) throw new Error('INVALID_PRICE');
  if (!referenceFresh || !finite(referenceBid)||!finite(referenceAsk)||referenceAsk<=referenceBid)
    return {bid:currentBid,ask:currentAsk,fallback:true};
  if(!finite(profile.spread_markup)||profile.spread_markup<1) throw new Error('INVALID_MARKUP');
  const half=(referenceAsk-referenceBid)*profile.spread_markup/2;
  // Keep the IPFX mid; the reference supplies spread only, never direction.
  return {bid:mid-half,ask:mid+half,fallback:false};
}
