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
export function ongoingSizing(spec:Spec,source:Spec,scale:number,lots:number,side:'buy'|'sell',entry:number,sl:number,maxRisk:number){
 const contract=Number(spec.lotSize),min=Number(spec.minLot),max=Number(spec.maxLot),step=Number(spec.lotStep),sourceContract=Number(source.contract_size);
 if(![contract,min,max,step,sourceContract,scale,lots,entry,sl,maxRisk].every(Number.isFinite)||contract<=0||min<=0||max<min||step<=0||sourceContract<=0||scale<=0||lots<min||lots>max||Math.abs(lots/step-Math.round(lots/step))>1e-8||!source.quote_currency||spec.quotingCurrency!==source.quote_currency)throw Error('BROKER_INSTRUMENT_SPEC_OR_LOT_UNVERIFIED');
 const priceScale=contract*(scale/sourceContract),stop=emergencyStop('a',side,entry,sl);
 const raw=stop===null?NaN:Math.abs(entry-stop)*lots*priceScale;
 // Reserve conservatively to the next cent without treating floating-point noise as an extra cent.
 const risk=Math.ceil((raw-Number.EPSILON*Math.max(1,Math.abs(raw))*8)*100)/100;
 if(!Number.isFinite(risk)||risk<=0||risk>maxRisk)throw Error('PLANNED_STOP_RISK_EXCEEDS_OWNER_CEILING');
 return {risk,priceScale,min,step,stop};
}
export function exactExecutionReceipt(qty:number,orderId:unknown,positionId:unknown,fill:{qty:number;price:number;orderId?:string|null;positionId?:string|null}|null,priorPositions:string[]=[]){
 return Number.isFinite(qty)&&qty>0&&typeof orderId==='string'&&/^[1-9]\d{0,19}$/.test(orderId)&&typeof positionId==='string'&&/^[1-9]\d{0,19}$/.test(positionId)&&!priorPositions.includes(positionId)&&
  fill!==null&&Number.isFinite(fill.qty)&&Math.abs(fill.qty-qty)<1e-8&&Number.isFinite(fill.price)&&fill.price>0&&fill.orderId===orderId&&fill.positionId===positionId;
}
