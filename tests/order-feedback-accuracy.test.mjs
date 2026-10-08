import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../trading.html',import.meta.url),'utf8');

function engine(reply,{status=200,renderFailure=false}={}){
 const original={account:{id:'fixture',challenge_type:'demo'},open_trades:[{id:'existing-position'}]},messages=[];
 const ctx=vm.createContext({engineState:original,lastStateAt:123,freshToken:async()=> 'synthetic',selectedAccountMode:'demo',accountModeIntent:'demo',blockInfinityTradeAttempt:()=>false,showInfinityTradeWarning(){},ENGINE_URL:'https://fixture.invalid',AbortController,setTimeout:()=>1,clearTimeout(){},Date,Array,localStorage:{setItem(){}},engineMsg:m=>messages.push(m),announceAutoClosedTrades(){},showVenueBanner(){},liveQuotesBySymbol:new Map(),renderPositions(){if(renderFailure)throw Error('synthetic rendering failure');},renderEngineAccount(){},fetch:async()=>({ok:status<400,status,json:async()=>reply})});
 vm.runInContext(html.slice(html.indexOf('async function engineCall(body){'),html.indexOf('// Non-trading engine calls')),ctx);
 return{ctx,original,messages};
}
test('an accepted pending-order acknowledgement preserves all visible positions and returns success',async()=>{
 const reply={ok:true,pending:{id:'fixture-order'}};const f=engine(reply);
 assert.equal(await f.ctx.engineCall({action:'place_pending'}),reply);assert.equal(f.ctx.engineState,f.original);assert.equal(f.messages.length,0);
});
test('a rendering failure after a confirmed close must never imply the close was rejected',async()=>{
 const reply={ok:true,account:{id:'fixture',challenge_type:'demo'},open_trades:[]},f=engine(reply,{renderFailure:true});
 assert.equal(await f.ctx.engineCall({action:'close'}),reply);assert.equal(f.ctx.lastStateAt,0);assert.match(f.messages[0],/Action confirmed/);
});
test('a server error is unconfirmed, preserving the account and telling the trader to reconcile before retrying',async()=>{
 const f=engine({ok:false,error:'synthetic failure'},{status:500});assert.equal(await f.ctx.engineCall({action:'open'}),null);assert.equal(f.ctx.engineState,f.original);assert.match(f.messages[0],/Check positions and history before retrying/);
});

function risk({pending=false,symbol='EURUSD',stop=1.113,trigger=1.115,conversion=1,cap=null}={}){
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{style:{},value:'',textContent:'',hidden:false});return nodes.get(id);};
 node('slPrice').value=String(stop);node('triggerPrice').value=String(trigger);
 const q=symbol==='USDJPY'?{bid:150,ask:150.02}:{bid:1.1,ask:1.1002};
 const ctx=vm.createContext({document:{getElementById:node},engineState:{account:{equity:100000,limits:{max_risk_per_trade_usd:cap}}},slOn:true,orderType:pending?'limit':'market',ordLots:.01,ordMidPrice:(q.bid+q.ask)/2,activeSym:symbol,liveQuotesBySymbol:new Map([[symbol,q]]),execSymbol:x=>x,symMeta:()=>({quoteCurrency:symbol==='USDJPY'?'JPY':'USD'}),clientUsdPerQuote:()=>conversion,contractSizeFor:()=>100000,isFinite,parseFloat,Number,Math});
 const start=html.indexOf('function orderPreviewEntry('),end=html.indexOf('// ── BREACH WARNING',start);vm.runInContext(html.slice(start,end),ctx);
 return{ctx,node};
}
test('pending stop risk uses the requested entry, rather than the current market price',()=>{
 const f=risk({pending:true});f.ctx.updateRiskPreview();assert.equal(f.node('opRiskVal').textContent,'$2.00');assert.match(f.node('opRiskNote').textContent,/excludes fees/);
});
test('market stop risk includes the executable spread side for both buys and sells',()=>{
 const buy=risk({stop:1.099}),sell=risk({stop:1.102});buy.ctx.updateRiskPreview();sell.ctx.updateRiskPreview();assert.equal(buy.node('opRiskVal').textContent,'$1.20');assert.equal(sell.node('opRiskVal').textContent,'$2.00');
});
test('JPY risk is converted to dollars, and missing conversion is unavailable rather than an invented amount',()=>{
 const f=risk({symbol:'USDJPY',stop:149,conversion:1/150});f.ctx.updateRiskPreview();assert.equal(f.node('opRiskVal').textContent,'$6.80');
 const missing=risk({symbol:'USDJPY',stop:149,conversion:null,cap:250});missing.ctx.updateRiskPreview();assert.equal(missing.node('opRiskVal').textContent,'Unavailable');assert.equal(missing.node('opRiskSize').hidden,true);
});
