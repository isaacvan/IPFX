import { emergencyStop } from './ab-allocator.ts';
import { readClient, type TlEnv } from './tradelocker-read.ts';
type Spec=Record<string,unknown>;
// Immutable instrument details only. Never cache execution permission, risk, margin or inventory.
const specs=new Map<string,{at:number;value:Spec}>(),pending=new Map<string,Promise<Spec>>();
export async function executionInstrument(token:string,env:TlEnv,accountId:string,accNum:string,inst:Spec){
 const key=[env,accountId,accNum,inst.tradable_instrument_id,inst.trade_route_id].join('|'),hit=specs.get(key);
 if(hit&&Date.now()-hit.at<6*3600000)return hit.value;
 const inFlight=pending.get(key);if(inFlight)return inFlight;
 const request=readClient(env).instrumentDetails(token,accNum,Number(inst.trade_route_id),String(inst.tradable_instrument_id)).then(value=>{
  if(specs.size>=512)specs.delete(specs.keys().next().value!);specs.set(key,{at:Date.now(),value});return value;
 }).finally(()=>pending.delete(key));pending.set(key,request);return request;
}
// lossCap (owner position loss cap, USD): the broker stop goes no further than the price where this copy loses lossCap,
// so the broker closes it automatically. It replaces the planned-risk ceiling because the loss is then bounded by the stop.
// byRisk (owner risk plan): lots are worked out so the copy risks byRisk.usd with its broker stop at byRisk.multiple x the
// trader's stop distance; `lots` is then the owner's maximum lots per copy. Wide stops get smaller lots instead of a refusal.
export function ongoingSizing(spec:Spec,source:Spec,scale:number,lots:number,side:'buy'|'sell',entry:number,sl:number,maxRisk:number,lossCap:number|null=null,byRisk:{usd:number;multiple:number}|null=null){
 const contract=Number(spec.lotSize),min=Number(spec.minLot),max=Number(spec.maxLot),step=Number(spec.lotStep),sourceContract=Number(source.contract_size);
 if(![contract,min,max,step,sourceContract,scale,lots,entry,sl,maxRisk].every(Number.isFinite)||contract<=0||min<=0||max<min||step<=0||sourceContract<=0||scale<=0||lots<min||lots>max||Math.abs(lots/step-Math.round(lots/step))>1e-8||!source.quote_currency||spec.quotingCurrency!==source.quote_currency)throw Error('BROKER_INSTRUMENT_SPEC_OR_LOT_UNVERIFIED');
 const priceScale=contract*(scale/sourceContract),backstop=emergencyStop('a',side,entry,sl);
 let stop=backstop,ceiling=maxRisk,size=lots;
 if(byRisk!==null){
  const budget=Math.min(byRisk.usd,lossCap??Infinity),dist=byRisk.multiple*Math.abs(entry-sl);
  if(!Number.isFinite(budget)||budget<=0||!Number.isFinite(byRisk.multiple)||byRisk.multiple<1||byRisk.multiple>3)throw Error('RISK_PLAN_INVALID');
  if(!(dist>0)||dist<entry*0.0002)throw Error('TRADER_STOP_TOO_TIGHT_FOR_BROKER');
  const decimals=Math.max(0,Math.ceil(-Math.log10(step)-1e-9));
  const fit=Number((Math.floor(budget/(dist*priceScale)/step+1e-9)*step).toFixed(decimals));
  size=Math.min(fit,lots);
  if(!(size>=min))throw Error('RISK_BUDGET_BELOW_MIN_LOT');
  stop=side==='buy'?entry-dist:entry+dist;ceiling=budget;
  if(!(stop>0))throw Error('TRADER_STOP_TOO_TIGHT_FOR_BROKER');
 }else if(lossCap!==null){
  if(!Number.isFinite(lossCap)||lossCap<=0)throw Error('POSITION_LOSS_CAP_INVALID');
  const dist=lossCap/(lots*priceScale),capStop=side==='buy'?entry-dist:entry+dist;
  // A stop closer than 0.02% of price is likely inside the broker's minimum distance: refuse rather than risk a rejected order.
  if(!(dist>0)||dist<entry*0.0002||!(capStop>0))throw Error('POSITION_LOSS_CAP_TOO_TIGHT_FOR_LOTS');
  stop=backstop===null?capStop:side==='buy'?Math.max(backstop,capStop):Math.min(backstop,capStop);
  ceiling=lossCap;
 }
 const raw=stop===null?NaN:Math.abs(entry-stop)*size*priceScale;
 // Reserve conservatively to the next cent without treating floating-point noise as an extra cent.
 const risk=Math.ceil((raw-Number.EPSILON*Math.max(1,Math.abs(raw))*8)*100)/100;
 if(!Number.isFinite(risk)||risk<=0||risk>ceiling+0.01)throw Error('PLANNED_STOP_RISK_EXCEEDS_OWNER_CEILING');
 return {risk,priceScale,min,step,stop,lots:size};
}
export function exactExecutionReceipt(qty:number,orderId:unknown,positionId:unknown,fill:{qty:number;price:number;orderId?:string|null;positionId?:string|null}|null,priorPositions:string[]=[]){
 return Number.isFinite(qty)&&qty>0&&typeof orderId==='string'&&/^[1-9]\d{0,19}$/.test(orderId)&&typeof positionId==='string'&&/^[1-9]\d{0,19}$/.test(positionId)&&!priorPositions.includes(positionId)&&
  fill!==null&&Number.isFinite(fill.qty)&&Math.abs(fill.qty-qty)<1e-8&&Number.isFinite(fill.price)&&fill.price>0&&fill.orderId===orderId&&fill.positionId===positionId;
}
