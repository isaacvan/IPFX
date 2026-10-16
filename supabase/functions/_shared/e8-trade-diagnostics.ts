// Read-only joins of saved evidence. No provider requests, order functions or calibration writes.
import {finiteNumber,epochMs} from './e8-reference.ts';
import {quoteBenchmark,quoteShortfall} from './e8-evidence.ts';
type Row=Record<string,any>;
const near=(a:number,b:number)=>Math.abs(a-b)<.010000001;
const sameQty=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<1e-8;
const flat=(r:Row)=>r.amounts?.positionsCount===0&&r.amounts?.ordersCount===0;
const time=(v:unknown)=>typeof v==='string'?Date.parse(v):NaN;
export function diagnoseTradeEvidence(input:{accountId:number;root:Row;exits:Row[];source:Row;fills:Row[];dispatches:Row[];
 before:Row|null;after:Row[];intervalFills:Row[];historyHealthy:boolean;contract:Row|null}){
 const {accountId,root,exits,source,fills,dispatches}=input;
 const unavailable=(reason:string)=>({available:false,reason,netVerified:false,canEnableLive:false});
 if(root.book!=='l'+accountId||!['buy','sell'].includes(root.side)||!['filled','closed'].includes(root.status)||
   !/^[1-9]\d{0,23}$/.test(String(root.broker_position_id??''))||!Array.isArray(root.ongoing_prior_position_ids)||
   root.ongoing_prior_position_ids.includes(root.broker_position_id)||root.source_trade_id!==source.id||source.status!=='closed')return unavailable('EXACT_CLOSED_OWNED_POSITION_REQUIRED');
 const wanted=[root,...exits],ids=wanted.map(o=>o.broker_order_id);
 if(!exits.length||exits.length>100||ids.some(id=>typeof id!=='string'||!/^[1-9]\d{0,23}$/.test(id))||new Set(ids).size!==ids.length||fills.length!==ids.length)return unavailable('COMPLETE_UNIQUE_ORDER_IDENTITIES_REQUIRED');
 if(exits.some(o=>o.book!==root.book||o.source_trade_id!==root.source_trade_id||o.broker_position_id!==root.broker_position_id||o.dispatch_state!=='confirmed'||o.status!=='closed'))return unavailable('CONFIRMED_EXITS_REQUIRED');
 const opened=finiteNumber(root.qty),scale=finiteNumber(root.price_scale_per_lot);
 if(opened===null||opened<=0||scale===null||scale<=0)return unavailable('VERIFIED_QUANTITY_AND_USD_SCALE_REQUIRED');
 const matched:Row[]=[];
 for(const o of wanted){
  const matches=fills.filter(f=>f.account_id===accountId&&f.ref===o.broker_order_id);
  if(matches.length!==1)return unavailable('EXACT_ACCOUNT_ORDER_RECEIPT_REQUIRED');
  const f=matches[0],raw=f.raw??{},opening=o.id===root.id,qty=finiteNumber(f.qty),price=finiteNumber(f.price);
  if(typeof raw.positionId!=='string'||raw.positionId!==root.broker_position_id||String(raw.id??raw.orderId)!==f.ref||
    String(raw.tradableInstrumentId)!==String(fills.find(x=>x.ref===root.broker_order_id)?.raw?.tradableInstrumentId)||
    !/^filled$/i.test(String(raw.status))||String(raw.isOpen)!==String(opening)||
    f.side!==(opening?root.side:root.side==='buy'?'sell':'buy')||f.symbol!==fills.find(x=>x.ref===root.broker_order_id)?.symbol||
    qty===null||qty<=0||!sameQty(qty,Number(o.qty))||price===null||price<=0||!Number.isFinite(Number(o.fill_price))||Math.abs(price-Number(o.fill_price))>1e-9)return unavailable('BROKER_RECEIPT_MISMATCH');
  matched.push(f);
 }
 if(!sameQty(exits.reduce((sum,o)=>sum+Number(o.qty),0),opened))return unavailable('EXIT_QUANTITY_INCOMPLETE');
 const contract=input.contract,first=matched[0];
 if(!contract||contract.account_id!==accountId||contract.quote_currency!=='USD'||String(contract.instrument_id)!==String(first.raw.tradableInstrumentId)||
   !sameQty(Number(contract.lot_size),scale)||!Number.isFinite(time(contract.observed_at))||time(contract.observed_at)>(epochMs(first.raw.createdDate)??-Infinity))return unavailable('PRE_ENTRY_USD_CONTRACT_REQUIRED');
 const gross=exits.reduce((sum,o)=>sum+(Number(o.fill_price)-Number(root.fill_price))*(root.side==='buy'?1:-1)*Number(o.qty)*scale,0);
 const timing=wanted.map(o=>{
  const d=dispatches.find(x=>x.operation_id===o.id),f=matched.find(x=>x.ref===o.broker_order_id)!;
  const requested=o.id===root.id?time(source.opened_at):time(source.close_requested_at??source.closed_at);
  const sent=d?time(d.sent_at):NaN,created=epochMs(f.raw?.createdDate);
  const q=d?.quote_snapshot,instrument=String(f.raw?.tradableInstrumentId??'');
  const benchmark=q&&q.instrument_id===instrument&&q.account_id===accountId?quoteBenchmark({bid:Number(q.bid),ask:Number(q.ask),requestedAt:time(q.requested_at),receivedAt:time(q.received_at),providerAt:q.broker_quote_at?time(q.broker_quote_at):null,accountId:String(accountId),instrumentId:instrument,routeId:Number(q.route_id)},sent,{accountId:String(accountId),instrumentId:instrument}):null;
  const shortfall=d?.fill_confirmed?quoteShortfall(o.side,Number(o.fill_price),Number(o.qty),scale,benchmark):null;
  return {event:o.event,orderId:o.broker_order_id,sourceToDispatchMs:Number.isFinite(sent)&&Number.isFinite(requested)&&sent>=requested?sent-requested:null,
   sourceToBrokerOrderMs:created!==null&&Number.isFinite(requested)&&created>=requested?created-requested:null,
   brokerAckMs:finiteNumber(d?.ack_ms),receiptLookupMs:finiteNumber(d?.receipt_lookup_ms),
   quoteShortfall:shortfall?.priceShortfall??null,quoteShortfallUsd:shortfall?.quoteCurrencyShortfall??null,
   providerQuoteAgeMs:shortfall?.providerAgeMs??null,timestampBasis:'BROKER_ORDER_CREATION_IS_NOT_EXACT_FILL_TIME'};
 });
 const before=input.before,after=input.after[0],settled=input.after[1];
 let balanceCandidate:Row={available:false,reason:'ISOLATED_STABLE_BALANCE_INTERVAL_UNAVAILABLE',netVerified:false};
 if(before&&after&&settled&&[before,after,settled].every(r=>r.account_id===accountId&&flat(r))&&
   time(after.requested_at)>Math.max(...matched.map(f=>epochMs(f.raw.createdDate)??Infinity))&&
   time(before.received_at)<Math.min(...matched.map(f=>epochMs(f.raw.createdDate)??-Infinity))&&
   time(settled.requested_at)>time(after.received_at)&&time(after.received_at)>time(before.received_at)&&time(after.received_at)-time(before.received_at)<=20*3600000&&input.historyHealthy){
  const fields=['balance','todayGross','todayNet','todayFees'];
  const complete=[before,after,settled].every(s=>fields.every(k=>finiteNumber(s.amounts?.[k])!==null));
  const intervalIds=input.intervalFills.map(f=>f.ref);
  const exactInterval=intervalIds.length===ids.length&&new Set(intervalIds).size===ids.length&&input.intervalFills.every(f=>f.account_id===accountId&&ids.includes(f.ref)&&String(f.raw?.positionId)===root.broker_position_id);
  if(complete&&exactInterval){
   const delta=(key:string)=>Number(after.amounts[key])-Number(before.amounts[key]);
   const stable=fields.every(k=>Math.round(Number(after.amounts[k])*100)===Math.round(Number(settled.amounts[k])*100));
   const consistent=near(delta('balance'),delta('todayNet'))&&near(delta('todayGross'),gross)&&near(delta('todayFees'),delta('todayGross')-delta('todayNet'));
   const currencies=[before.currency,after.currency,settled.currency],currency=currencies.every(c=>typeof c==='string'&&c===currencies[0])?currencies[0]:null;
   const currencyConflict=currencies.some(c=>c!=null)&&currency===null;
   if(stable&&consistent&&!currencyConflict&&(currency===null||currency==='USD'))balanceCandidate={available:true,beforeId:before.id,afterId:after.id,settledId:settled.id,
    gross,accountNet:delta('balance'),combinedCost:gross-delta('balance'),currency,
    costPerLot:(gross-delta('balance'))/opened,basis:'BALANCE_CANDIDATE_REQUIRES_OWNER_REVIEW',
    commission:null,swap:null,netVerified:false,requires:['Confirm account currency','Confirm no other adjustments or missing activity','Confirm broker day and posting settlement']};
  }
 }
 return {available:true,sourceTradeId:source.id,accountId,positionId:root.broker_position_id,symbol:source.symbol,lots:opened,
  brokerGrossUsd:Math.round(gross*100)/100,timing,balanceCandidate,netVerified:false,canEnableLive:false};
}

// deno-lint-ignore no-explicit-any
export async function loadTradeDiagnostic(db:any,accountId:number,positionId:string){
 const {data:root,error:re}=await db.from('book_orders').select('*').eq('book','l'+accountId).eq('event','open').eq('broker_position_id',positionId).maybeSingle();
 if(re||!root)return {available:false,reason:'UNIQUE_OWNED_OPENING_NOT_FOUND',netVerified:false,canEnableLive:false};
 const [{data:source,error:se},{data:exits,error:ee}]=await Promise.all([
  db.from('trades').select('id,status,symbol,opened_at,closed_at,close_requested_at').eq('id',root.source_trade_id).maybeSingle(),
  db.from('book_orders').select('*').eq('book',root.book).eq('source_trade_id',root.source_trade_id).neq('event','open').order('id').limit(101)]);
 if(se||ee||!source||!exits||exits.length>100)return {available:false,reason:'SOURCE_OR_COMPLETE_EXITS_UNAVAILABLE',netVerified:false};
 const ids=[root,...exits].map(o=>o.broker_order_id).filter((id:unknown)=>typeof id==='string');
 const [{data:fills,error:fe},{data:dispatches,error:de},{data:monitor,error:me}]=await Promise.all([
  db.from('cost_fills').select('account_id,ref,side,symbol,qty,price,raw,filled_at').eq('account_id',accountId).in('ref',ids).limit(102),
  db.from('e8_dispatch_evidence').select('*').in('operation_id',[root,...exits].map(o=>o.id)).limit(102),
  db.from('e8_monitor_profiles').select('history_error_code,last_history_at').eq('account_id',accountId).maybeSingle()]);
 if(fe||de||me||!fills?.length)return {available:false,reason:'EXACT_BROKER_EVIDENCE_UNAVAILABLE',netVerified:false};
 const times=fills.map((f:Row)=>epochMs(f.raw?.createdDate));
 if(times.some((t:number|null)=>t===null))return {available:false,reason:'BROKER_ORDER_TIMES_UNAVAILABLE',netVerified:false};
 const start=Math.min(...times),end=Math.max(...times);
 const [{data:beforeRows,error:be},{data:after,error:ae},{data:contract,error:ce}]=await Promise.all([
  db.from('e8_account_snapshots').select('id,account_id,requested_at,received_at,amounts,currency').eq('account_id',accountId).lt('received_at',new Date(start).toISOString()).gte('received_at',new Date(start-600000).toISOString()).order('received_at',{ascending:false}).limit(1),
  db.from('e8_account_snapshots').select('id,account_id,requested_at,received_at,amounts,currency').eq('account_id',accountId).gt('requested_at',new Date(end+1000).toISOString()).lte('requested_at',new Date(end+600000).toISOString()).order('requested_at').limit(3),
  db.from('e8_instrument_evidence').select('account_id,instrument_id,lot_size,quote_currency,observed_at').eq('account_id',accountId).eq('symbol',source.symbol).lte('observed_at',new Date(start).toISOString()).order('observed_at',{ascending:false}).limit(1).maybeSingle()]);
 const before=beforeRows?.[0]??null;
 let intervalFills:Row[]=[],historyHealthy=false;
 if(!be&&!ae&&before&&after?.length>=2){
  const {data:interval,error:ie}=await db.from('cost_fills').select('account_id,ref,raw').eq('account_id',accountId).gt('filled_at',before.received_at).lte('filled_at',after[0].received_at).limit(1001);
  intervalFills=interval??[];historyHealthy=!ie&&intervalFills.length<1001&&monitor?.history_error_code===null&&time(monitor.last_history_at)>=time(after[0].received_at);
 }
 return diagnoseTradeEvidence({accountId,root,exits,source,fills,dispatches:dispatches??[],before,after:after??[],intervalFills,historyHealthy,contract:ce?null:contract});
}
