// Evidence calculations only. No credentials, network access, order submission or classifier changes.
export type QuoteEvidence = { bid:number; ask:number; requestedAt:number; receivedAt:number;
  providerAt:number|null; accountId:string; instrumentId:string; routeId:number };
const number=(v:unknown):number|null=>v===null||v===undefined||typeof v==='boolean'||(typeof v==='string'&&!v.trim())?null:
  (typeof v==='number'||typeof v==='string')&&Number.isFinite(Number(v))?Number(v):null;
export function observedQuote(raw:Record<string,unknown>,scope:{accountId:string;instrumentId:string;routeId:number},requestedAt:number,receivedAt:number):QuoteEvidence|null{
 const bid=number(raw.bp??raw.bid),ask=number(raw.ap??raw.ask);
 if(bid===null||ask===null||bid<=0||ask<bid||!Number.isFinite(requestedAt)||!Number.isFinite(receivedAt)||receivedAt<requestedAt)return null;
 // Keep only an explicitly named quote timestamp; generic server/request times are not quote times.
 const value=raw.quoteTimestamp??raw.quoteTime;let providerAt:number|null=null;
 if(typeof value==='string'&&/[TZ:-]/.test(value)){const t=Date.parse(value);if(Number.isFinite(t))providerAt=t;}
 else {const n=number(value);if(n!==null&&n>1e11)providerAt=n;else if(n!==null&&n>1e9)providerAt=n*1000;}
 if(providerAt!==null&&(providerAt>receivedAt||providerAt<0))providerAt=null;
 return {bid,ask,requestedAt,receivedAt,providerAt,...scope};
}
export function quoteBenchmark(q:QuoteEvidence|null,at:number,scope:{accountId:string;instrumentId:string},maxReceiveAgeMs=1000){
 if(!q||q.accountId!==scope.accountId||q.instrumentId!==scope.instrumentId||![at,q.receivedAt,q.requestedAt,q.bid,q.ask,maxReceiveAgeMs].every(Number.isFinite)||q.bid<=0||q.ask<q.bid||
  q.receivedAt>at||q.requestedAt>q.receivedAt||at-q.receivedAt>maxReceiveAgeMs||maxReceiveAgeMs<0||maxReceiveAgeMs>60000||
  q.providerAt!==null&&(!Number.isFinite(q.providerAt)||q.providerAt>q.receivedAt))return null;
 return {...q,receivedAgeMs:at-q.receivedAt,providerAgeMs:q.providerAt===null?null:at-q.providerAt,
  basis:q.providerAt===null?'OBSERVED_QUOTE_PROVIDER_AGE_UNKNOWN':'OBSERVED_PROVIDER_TIMESTAMP_NOT_GUARANTEED_FILL'};
}
export function quoteShortfall(side:'buy'|'sell',fill:number,qty:number,scale:number,q:ReturnType<typeof quoteBenchmark>){
 if(!q||!['buy','sell'].includes(side)||![fill,qty,scale].every(n=>Number.isFinite(n)&&n>0))return null;
 const benchmark=side==='buy'?q.ask:q.bid,price=side==='buy'?fill-benchmark:benchmark-fill;
 return {benchmarkPrice:benchmark,priceShortfall:price,quoteCurrencyShortfall:price*qty*scale,basis:'OBSERVED_PRE_SEND_QUOTE_SHORTFALL',providerAgeMs:q.providerAgeMs};
}
export function receiptCosts(input:Record<string,unknown>){
 const gross=number(input.gross),net=number(input.net),fee=number(input.fee),commission=number(input.commission),swap=number(input.swap);
 if(gross===null||net===null||fee===null||swap===null||typeof input.feeIncludesCommission!=='boolean')throw Error('Explicit gross, net, signed fee, signed swap and fee definition are required; blank is not zero.');
 if(input.feeIncludesCommission===false&&commission===null)throw Error('Separate signed commission is required.');
 const adjustments=fee+swap+(input.feeIncludesCommission?0:commission!);
 if(Math.abs(gross+adjustments-net)>.010000001)throw Error('Gross plus signed charges/credits does not match net within one cent.');
 return {gross,net,fee,commission,swap,feeIncludesCommission:input.feeIncludesCommission,adjustments,
  basis:'OWNER_REVIEWED_POSITION_RECEIPT',statementAuthenticated:false,canEnableLive:false};
}
export function isolatedBalance(input:{before:number|null;after:number|null;gross:number|null;adjustments:number|null;
 currency:string|null;flatBefore:boolean;flatAfter:boolean;onePosition:boolean;noOtherActivity:boolean;
 stableAfter:boolean;sameBrokerDay:boolean;windowComplete:boolean}){
 const complete=[input.before,input.after,input.gross,input.adjustments].every(n=>n!==null&&Number.isFinite(n))&&
  input.currency==='USD'&&input.flatBefore&&input.flatAfter&&input.onePosition&&input.noOtherActivity&&input.stableAfter&&input.sameBrokerDay&&input.windowComplete;
 if(!complete)return {basis:'BALANCE_ALLOCATION_AMBIGUOUS',net:null,combinedCost:null,receiptVerified:false};
 const net=input.after!-input.before!-input.adjustments!;
 return {basis:'BALANCE_RECONCILED_NET',net,combinedCost:input.gross!-net,receiptVerified:false};
}
export type PaperEvent={at:number;kind:'open'|'partial'|'close';lots:number;quote:QuoteEvidence|null};
export function pairedPaper(events:PaperEvent[],input:{accountId:string;instrumentId:string;side:'buy'|'sell';scale:number;
 signedCostsA:number|null;signedCostsB:number|null;maxReceiveAgeMs:number}){
 const unknown=(reason:string)=>({available:false,reason,netVerified:false,canEnableLive:false});
 if(events.length<2||events.length>100||events[0].kind!=='open'||!['buy','sell'].includes(input.side)||!Number.isFinite(input.scale)||input.scale<=0)return unknown('INVALID_LIFECYCLE');
 const first=events[0];let remaining=first.lots,last=first.at,a=0,b=0,spreadCost=0;
 const entry=quoteBenchmark(first.quote,first.at,input,input.maxReceiveAgeMs);if(!entry)return unknown('ENTRY_PRE_EVENT_QUOTE_MISSING');
 if(!Number.isFinite(remaining)||remaining<=0)return unknown('INVALID_QUANTITY');
 for(let i=1;i<events.length;i++){
  const e=events[i];if(!['partial','close'].includes(e.kind)||e.at<=last||!Number.isFinite(e.lots)||e.lots<=0||e.lots>remaining+1e-9||
   (e.kind==='close'&&(i!==events.length-1||Math.abs(e.lots-remaining)>1e-9))||i===events.length-1&&e.kind!=='close')return unknown('INVALID_EXIT_SEQUENCE');
  const exit=quoteBenchmark(e.quote,e.at,input,input.maxReceiveAgeMs);if(!exit)return unknown('EXIT_PRE_EVENT_QUOTE_MISSING');
  const k=e.lots*input.scale;
  a+=(input.side==='buy'?exit.bid-entry.ask:entry.bid-exit.ask)*k;
  b+=(input.side==='buy'?entry.bid-exit.ask:exit.bid-entry.ask)*k;
  spreadCost+=((entry.ask-entry.bid)+(exit.ask-exit.bid))*k;
  remaining-=e.lots;last=e.at;
 }
 if(Math.abs(remaining)>1e-9)return unknown('INCOMPLETE_QUANTITY');
 const cost=(v:number|null)=>v!==null&&Number.isFinite(v)?v:null;
 return {available:true,basis:'PAIRED_OBSERVED_QUOTES_HYPOTHETICAL_NOT_BROKER_FILLS',grossA:a,grossB:b,
  netA:cost(input.signedCostsA)===null?null:a+input.signedCostsA!,netB:cost(input.signedCostsB)===null?null:b+input.signedCostsB!,
  spreadCost,identityResidual:a+b+spreadCost,netVerified:false,canEnableLive:false};
}
