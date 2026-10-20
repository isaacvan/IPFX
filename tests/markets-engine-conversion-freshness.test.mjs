import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const source=fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts',import.meta.url),'utf8');
const part=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const instruments={EURUSD:{quote:'USD',contract:100000,cls:'forex'},EURJPY:{quote:'JPY',contract:100000,cls:'forex'},USDJPY:{quote:'JPY',contract:100000,cls:'forex'}};
function fixture(){
 const now=100000,quotes=new Map(),calls=[];
 const c=vm.createContext({Date:class extends Date{static now(){return now;}},INSTRUMENTS:instruments,LEVERAGE:100,
  STALE_MS:8000,STALE_MS_CRYPTO:20000,STALE_MS_FUTURES:15000,SYMBOL_QUIET_MAX_MS:60000,
  fetchQuote:async symbol=>{calls.push(symbol);return quotes.get(symbol)??null;}});
 vm.runInContext(stripTypeScriptTypes(part('function quoteStale(', '// ---------- live copier hook ----------')),c);
 vm.runInContext(stripTypeScriptTypes(part('async function usedMarginUsd(', '// When a stage is passed')),c);
 vm.runInContext(stripTypeScriptTypes(part('async function openRiskUsd(', '// The date a failed Infinity')),c);
 const quote=(symbol,mid,extra={})=>quotes.set(symbol,{symbol,mid,bid:mid-.001,ask:mid+.001,spread:.002,providerTs:now,receivedTs:now,source:'fixture',...extra});
 return{c,quotes,quote,calls};
}
const trade={symbol:'EURJPY',side:'buy',volume:.01,open_price:160,sl:159};
test('all supported non-USD conversions refuse stale rates, while USD needs no quote',async()=>{
 const f=fixture();assert.equal(await f.c.usdPerQuote('USD'),1);assert.equal(f.calls.length,0);
 for(const [currency,pair,rate] of[['JPY','USDJPY',150],['CAD','USDCAD',1.35],['CHF','USDCHF',.9],['GBP','GBPUSD',1.25],['EUR','EURUSD',1.1]]){
  f.quote(pair,rate);assert.equal(await f.c.usdPerQuote(currency),['GBP','EUR'].includes(currency)?rate:1/rate,currency+' valid');
  f.quote(pair,rate,{providerTs:90000});assert.equal(await f.c.usdPerQuote(currency),null,currency);
 }
});
test('live quiet-feed allowance is preserved; dead-feed and overlong symbol silence cannot convert',async()=>{
 const f=fixture();f.quote('USDJPY',150,{source:'ctrader',providerTs:70000,feedTs:99000});
 assert.equal(await f.c.usdPerQuote('JPY'),1/150);
 f.quote('USDJPY',150,{source:'ctrader',providerTs:99000,feedTs:90000});assert.equal(await f.c.usdPerQuote('JPY'),null);
 f.quote('USDJPY',150,{source:'ctrader',providerTs:39000,feedTs:99000});assert.equal(await f.c.usdPerQuote('JPY'),null);
});
test('invalid conversion sides, midpoint and timestamp never produce a dollar amount',async()=>{
 for(const patch of[{mid:NaN},{mid:-1},{bid:0},{bid:null},{bid:151,ask:150},{mid:160},{receivedTs:NaN,providerTs:null}]){
  const f=fixture();f.quote('USDJPY',150,patch);assert.equal(await f.c.usdPerQuote('JPY'),null,JSON.stringify(patch));
 }
});
test('malformed timestamps cannot make a price usable even with a healthy-looking heartbeat',async()=>{
 for(const patch of[{providerTs:NaN},{receivedTs:NaN},{source:'ctrader',providerTs:70000,feedTs:NaN},{source:'ctrader',providerTs:70000,feedTs:Infinity}]){
  const f=fixture();f.quote('USDJPY',150,patch);assert.equal(f.c.quoteStale(f.quotes.get('USDJPY')),true,JSON.stringify(patch));assert.equal(await f.c.usdPerQuote('JPY'),null);
 }
});
test('timestamps beyond the existing one-minute provider clock tolerance cannot grant freshness',async()=>{
 for(const field of ['providerTs','receivedTs','feedTs']){
  const f=fixture();f.quote('USDJPY',150,{source:'ctrader',feedTs:100000,[field]:160001});
  assert.equal(f.c.quoteStale(f.quotes.get('USDJPY')),true,field);assert.equal(await f.c.usdPerQuote('JPY'),null,field);
 }
 const f=fixture();f.quote('USDJPY',150,{providerTs:150000,receivedTs:80000});assert.equal(f.c.quoteStale(f.quotes.get('USDJPY')),true,'provider clock compared with original receipt');
});
test('timestamp validation preserves null-provider fallback, allowed clock skew and healthy quiet quotes',async()=>{
 const f=fixture();for(const patch of[{providerTs:null},{providerTs:160000},{source:'ctrader',providerTs:70000,feedTs:99000}]){
  f.quote('USDJPY',150,patch);assert.equal(f.c.quoteStale(f.quotes.get('USDJPY')),false);assert.equal(await f.c.usdPerQuote('JPY'),1/150);
 }
});

test('a stale or missing conversion is unknown P&L, margin and open risk, never zero exposure',async()=>{
 for(const stale of[false,true]){
  const f=fixture();f.quote('EURJPY',161);if(stale)f.quote('USDJPY',150,{providerTs:90000});
  assert.equal(await f.c.tradePnl(trade,161),null);assert.equal(await f.c.usedMarginUsd([trade]),null);assert.equal(await f.c.openRiskUsd([trade]),null);
 }
});
test('valid conversion recovery preserves signed P&L, margin and aggregate risk formulas',async()=>{
 const f=fixture();f.quote('EURJPY',161);f.quote('USDJPY',150);
 assert.ok(Math.abs(await f.c.tradePnl(trade,161)-6.666666666666667)<1e-9);
 assert.ok(Math.abs(await f.c.tradePnl({...trade,side:'sell'},161)+6.666666666666667)<1e-9);
 assert.ok(Math.abs(await f.c.usedMarginUsd([trade])-10.733333333333333)<1e-9);
 assert.equal(await f.c.openRiskUsd([trade]),6.67);assert.equal(await f.c.usedMarginUsd([]),0);assert.equal(await f.c.openRiskUsd([]),0);
});
test('pending orders wait unchanged while conversion, used margin or portfolio risk cannot be verified',async()=>{
 for(const unavailable of['conversion','margin','risk']){
  const row={id:'synthetic-order',symbol:'EURUSD',status:'pending',side:'buy',volume:.01,sl:1.09,tp:null},patches=[];
  const c=vm.createContext({Date,INSTRUMENTS:instruments,MAX_OPEN_POSITIONS:20,isTradableAccount:()=>true,
   fetchQuote:async()=>({bid:1.1,ask:1.1002,spread:.0002}),quoteStale:()=>false,marketOpen:()=>true,pendingTriggered:()=>true,
   symbolCheck:async()=>({ok:true,maxSpread:1,slippageBps:0}),rulesV2:()=>true,roundPrice:(_s,p)=>p,adverse:p=>p,
   usdPerQuote:async()=>unavailable==='conversion'?null:1,usedMarginUsd:async()=>unavailable==='margin'?null:0,openRiskUsd:async()=>unavailable==='risk'?null:0,
   ruleGate:()=>{throw Error('Unknown portfolio data reached the fill gate');},logAudit:async()=>{},
   db:{from:()=>{let patch;const q={select(){return q;},eq(){return q;},order(){return q;},update(p){patch=p;return q;},then(resolve){if(patch){patches.push(patch);Object.assign(row,patch);}return resolve({data:[row]});}};return q;}}});
  const start=source.indexOf('async function processPendingOrders('),end=source.indexOf('\nasync function ',start+1);
  vm.runInContext(stripTypeScriptTypes(source.slice(start,end)),c);await c.processPendingOrders(c.db,{id:'synthetic-account'},[],1000);
  assert.equal(row.status,'pending',unavailable);assert.equal(patches.length,0);
 }
});
test('market-entry portfolio checks cannot treat unknown margin or open risk as zero',async()=>{
 const code='async function entry(){'+part('      const needed = (inst.contract * volume * q.mid * conv) / LEVERAGE;', '      await flagCrossAccountHedge(')+'return{allowed:true};}';
 for(const unavailable of['margin','risk']){
  const c=vm.createContext({inst:{contract:100000},volume:.01,q:{mid:1.1},conv:1,LEVERAGE:100,state:{open:[],equity:1000},
   usedMarginUsd:async()=>unavailable==='margin'?null:0,openRiskUsd:async()=>unavailable==='risk'?null:0,
   reject:async reason=>({allowed:false,reason}),rulesV2:()=>true,A:{max_risk_per_trade_pct:.5},sl:1.09,fill:1.1,startBal:1000,
   effectiveRiskLimit:()=>({effective:20}),MAX_TOTAL_RISK_MULTIPLE:4,round2:n=>Math.round(n*100)/100});
  vm.runInContext(stripTypeScriptTypes(code),c);assert.equal((await c.entry()).allowed,false,unavailable);
 }
});
