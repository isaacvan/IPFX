// Supported account-state decoding; no credentials, HTTP or order capability.
import { finiteNumber } from './e8-reference.ts';
const fields=['balance','projectedBalance','todayGross','todayNet','todayFees','todayVolume','todayTradesCount','openGrossPnL','openNetPnL','positionsCount','ordersCount'] as const;
export function decodeAccountState(configValue:unknown,responseValue:unknown) {
 const unwrap=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('ACCOUNT_STATE_SCHEMA_INVALID');const r=v as Record<string,unknown>;return r.d&&typeof r.d==='object'&&!Array.isArray(r.d)?r.d as Record<string,unknown>:r;};
 const config=unwrap(configValue),response=unwrap(responseValue);
 const columns=(config.accountDetailsConfig as {columns?:Array<{id?:unknown}>}|undefined)?.columns;
 if(!Array.isArray(columns)||!columns.length||columns.length>200)throw Error('ACCOUNT_STATE_CONFIG_MISSING');
 const names=columns.map(c=>c?.id);
 if(names.some(n=>typeof n!=='string'||!n)||new Set(names).size!==names.length)throw Error('ACCOUNT_STATE_CONFIG_AMBIGUOUS');
 const values=response.accountDetailsData;
 if(!Array.isArray(values)||values.length!==names.length)throw Error('ACCOUNT_STATE_CONFIG_MISMATCH');
 const row=Object.fromEntries((names as string[]).map((n,i)=>[n,values[i]]));
 const out:Record<string,number|null>={};
 for(const f of fields){let n=finiteNumber(row[f]);if(['todayTradesCount','positionsCount','ordersCount'].includes(f)&&n!=null&&(!Number.isSafeInteger(n)||n<0))n=null;out[f]=n;}
 const currency=typeof row.currency==='string'&&/^[A-Z]{3}$/.test(row.currency)?row.currency:null;
 return {values:out,currency,basis:'BROKER_REPORTED_ACCOUNT_TOTALS',period_basis:'BROKER_TODAY_BOUNDARY_UNCONFIRMED',
  reconciliation:reconcileAccountTotals(out.todayGross,out.todayNet,out.todayFees),trade_net_verified:false};
}
export function reconcileAccountTotals(gross:number|null,net:number|null,fees:number|null) {
 if([gross,net,fees].some(n=>n==null||!Number.isFinite(n)))return {status:'INCOMPLETE',gross_minus_net:null,unattributed_gap:null};
 const gap=gross!-net!,positive=gap-fees!,signed=gap+fees!;
 const tol=1e-8*Math.max(1,Math.abs(gross!),Math.abs(net!),Math.abs(fees!));
 if(Math.abs(positive)<=tol&&Math.abs(signed)<=tol)return {status:'ZERO_REPORTED_DIFFERENCE',gross_minus_net:gap,unattributed_gap:0};
 if(Math.abs(positive)<=tol)return {status:'CONSISTENT_POSITIVE_FEE',gross_minus_net:gap,unattributed_gap:positive};
 if(Math.abs(signed)<=tol)return {status:'CONSISTENT_SIGNED_FEE',gross_minus_net:gap,unattributed_gap:signed};
 return {status:'UNATTRIBUTED_DIFFERENCE',gross_minus_net:gap,unattributed_gap:Math.abs(positive)<Math.abs(signed)?positive:signed};
}
