import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../trading.html',import.meta.url),'utf8');
const part=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
function fixture(){
 let now=100000;const calls=[],nodes=new Map();
 const c=vm.createContext({Date:class extends Date{static now(){return now;}},activeSym:'EURUSD',liveQuotesBySymbol:new Map(),
  document:{getElementById:()=>null,querySelectorAll:()=>[]},ipfxChart:null,domDigits:5,domPrice:0,ordMidPrice:0,ordLots:.01,engineState:{account:{equity:1000}},
  estMarginExposure:()=>({margin:1}),pxDigits:()=>5,refreshClientMarks(){},updatePnlPreview(){},syncTicketStatus(){},
  symMeta:symbol=>({quoteCurrency:/JPY$/.test(symbol)?'JPY':/GBP$/.test(symbol)?'GBP':'USD'}),
  connectHub(){},syncHubSubs(){},ensureQuoteStream(){},hasSession:()=>true,pollsPaused:()=>false,ticketPollDue:()=>true,
  priceFetchBusy:false,lastTicketPoll:0,quoteAppliedRt:0,lastPushedQuoteAt:0,engineBusy:false,engineCall(){},hubLive:()=>false,
  ENGINE_URL:'https://synthetic.invalid',freshToken:async()=> 'synthetic',setTimeout:()=>1,AbortSignal,
  fetch:async(_url,options)=>{calls.push(JSON.parse(options.body));return{ok:true,json:async()=>c.reply};},
  reply:{ok:true,symbol:'EURUSD',status:'live',bid:1.1,ask:1.1002,mid:1.1001,digits:5,received_ts:1000}});
 vm.runInContext(part('function execSymbol(raw){','function refreshClientMarks(){'),c);
 vm.runInContext(part('let lastQuoteTs=0','// Load shaping'),c);
 vm.runInContext(part('function updateOrdPrices(value){','// Real quote for the active instrument'),c);
 vm.runInContext(part('function onPushedQuote(p){','async function pollTicketPrice(){'),c);
 vm.runInContext(part('async function pollTicketPrice(){','// continuously re-evaluate staleness'),c);
 vm.runInContext(part('function clearOrdPrices(){','function changeInstrument('),c);
 vm.runInContext(part('function hubSymbols(){','function syncHubSubs('),c);
 const seed=(symbol='EURUSD',more={})=>c.cacheLiveQuote({symbol,bid:1.1,ask:1.1002,mid:1.1001,status:'live',digits:5,...more});
 const state=()=>vm.runInContext('({lastQuoteTs,feedState,lastQuoteSym:typeof lastQuoteSym===\'undefined\'?null:lastQuoteSym})',c);
 const markLive=()=>{seed();vm.runInContext("lastQuoteTs=Date.now();feedState='live';if(typeof lastQuoteSym!=='undefined')lastQuoteSym=execSymbol(activeSym);",c);};
 return{c,calls,seed,state,markLive,advance:ms=>now+=ms};
}
test('invalid, zero or crossed quotes cannot remain usable in the per-symbol cache',()=>{
 for(const bad of[{bid:null},{ask:undefined},{bid:0},{ask:0},{bid:-1},{bid:2,ask:1},{bid:Infinity},{bid:'1.1'}]){
  const f=fixture();f.seed();f.seed('EURUSD',bad);assert.equal(f.c.liveQuotesBySymbol.has('EURUSD'),false,JSON.stringify(bad));
 }
});
test('an explicit stale, closed or unavailable symbol invalidates its last cached conversion',()=>{
 for(const status of['stale','closed','no_feed']){
  const f=fixture();f.seed('USDJPY',{bid:150,ask:150.02});f.seed('USDJPY',{status});
  assert.equal(f.c.clientUsdPerQuote('JPY'),null,status);
 }
});
test('older timestamped packets cannot replace a newer cached price',()=>{
 const f=fixture();f.seed('EURUSD',{received_ts:2000});f.seed('EURUSD',{bid:1,ask:1.0002,received_ts:1000});
 assert.equal(f.c.liveQuotesBySymbol.get('EURUSD').bid,1.1);
});
test('feed freshness rejects explicit non-tradable states despite a recent good tick',()=>{
 const f=fixture();f.markLive();assert.equal(f.c.feedFresh(),true);
 for(const status of['stale','closed','connecting']){f.c.setFeed(status);assert.equal(f.c.feedFresh(),false,status);}
});
test('feed freshness belongs to the selected symbol, not another recently selected market',()=>{
 const f=fixture();f.markLive();f.seed('XAUUSD',{bid:2700,ask:2700.1});f.c.activeSym='XAUUSD';assert.equal(f.c.feedFresh(),false);
});
test('a stale poll cannot renew the fresh timer or permit an order',async()=>{
 const f=fixture();f.markLive();const before=f.state().lastQuoteTs;f.advance(1000);f.c.reply.status='stale';await f.c.pollTicketPrice();
 assert.equal(f.c.feedFresh(),false);assert.equal(f.state().lastQuoteTs,before);assert.equal(f.state().feedState,'stale');
});
test('poll auth failure releases the poll lock so a subsequent valid quote can recover',async()=>{
 const f=fixture();f.c.freshToken=async()=>{throw Error('synthetic auth failure');};
 await assert.doesNotReject(()=>f.c.pollTicketPrice());assert.equal(f.c.priceFetchBusy,false);
 f.c.freshToken=async()=> 'synthetic';await f.c.pollTicketPrice();assert.equal(f.calls.length,1);assert.equal(f.c.feedFresh(),true);
});
test('invalid or mismatched poll replies never make the selected market tradable',async()=>{
 for(const patch of[{bid:0},{bid:2,ask:1},{ask:null},{symbol:'XAUUSD'},{status:'unexpected'}]){
  const f=fixture();Object.assign(f.c.reply,patch);await f.c.pollTicketPrice();assert.equal(f.c.feedFresh(),false,JSON.stringify(patch));
 }
});
test('a valid selected-market push restores the live state after a stale connection',()=>{
 const f=fixture();f.c.setFeed('stale');f.c.onPushedQuote({s:'EURUSD',b:1.1,a:1.1002,m:1.1001,d:5,rt:2000});
 assert.equal(f.state().feedState,'live');assert.equal(f.c.feedFresh(),true);
});
test('conversion risk is unavailable after local freshness expires, and recovers on a validated quote',()=>{
 const f=fixture();f.seed('USDJPY',{bid:150,ask:150.02,mid:150.01});assert.equal(f.c.clientUsdPerQuote('JPY'),1/150.01);
 f.advance(6001);assert.equal(f.c.clientUsdPerQuote('JPY'),null);assert.equal(f.c.clientUsdPerQuote('USD'),1);
 f.seed('USDJPY',{bid:151,ask:151.02,mid:151.01});assert.equal(f.c.clientUsdPerQuote('JPY'),1/151.01);
});
test('an older stale poll cannot undo a more recent live push',async()=>{
 const f=fixture();f.c.onPushedQuote({s:'EURUSD',b:1.1,a:1.1002,d:5,rt:2000});f.c.reply.status='stale';
 await f.c.pollTicketPrice();assert.equal(f.c.feedFresh(),true);assert.equal(f.state().feedState,'live');
});
test('changing market clears the old watermark and closed status before accepting the new market',()=>{
 const f=fixture();f.c.quoteAppliedRt=5000;f.c.setFeed('closed');f.c.clearOrdPrices();f.c.activeSym='XAUUSD';
 f.c.onPushedQuote({s:'XAUUSD',b:2700,a:2700.1,d:2,rt:1000});assert.equal(f.c.feedFresh(),true);
 assert.equal(f.state().lastQuoteSym,'XAUUSD');assert.equal(f.c.quoteAppliedRt,1000);
});
test('conversion instruments are included in the existing hub subscription for active and open markets',()=>{
 const f=fixture();f.c.activeSym='GBPJPY';f.c.engineState.open_trades=[{symbol:'EURGBP'}];
 assert.deepEqual(Array.from(f.c.hubSymbols()),['GBPJPY','USDJPY','GBPUSD']);
});
test('crossed or missing push prices cannot renew the last genuine quote timestamp',()=>{
 for(const patch of[{b:2,a:1},{b:0},{a:null}]){
  const f=fixture();f.markLive();const before=f.state().lastQuoteTs;f.advance(6001);
  f.c.onPushedQuote({s:'EURUSD',b:1.1,a:1.1002,d:5,rt:2000,...patch});assert.equal(f.state().lastQuoteTs,before);assert.equal(f.c.feedFresh(),false);
 }
});
test('a collapsed watchlist still refreshes a missing conversion through the existing batch request',async()=>{
 const f=fixture();f.c.activeSym='GBPJPY';f.c.wlCollapsed=true;f.c.wlPollBusy=false;f.c.lastUserActivity=100000;f.c.wlEntries=()=>[];
 f.c.reply={ok:true,quotes:[{symbol:'USDJPY',bid:150,ask:150.02,status:'demo',digits:3}]};
 vm.runInContext(part('let lastWlPoll=0;','if(document.getElementById(\'wlList\'))'),f.c);
 await f.c.pollWatchlist();assert.deepEqual(Array.from(f.calls[0].symbols),['USDJPY']);assert.equal(f.c.clientUsdPerQuote('JPY'),1/150.01);
 assert.equal(f.c.wlPollBusy,false);
});
test('healthy hub retains the slow fallback for fresh conversions and refreshes only when the conversion expires',async()=>{
 const f=fixture();f.c.activeSym='GBPJPY';f.c.wlCollapsed=true;f.c.wlPollBusy=false;f.c.lastUserActivity=100000;f.c.wlEntries=()=>[];f.c.hubLive=()=>true;
 f.seed('USDJPY',{bid:150,ask:150.02});f.c.reply={ok:true,quotes:[{symbol:'USDJPY',bid:150,ask:150.02,status:'demo',digits:3}]};
 vm.runInContext(part('let lastWlPoll=0;','if(document.getElementById(\'wlList\'))'),f.c);vm.runInContext('lastWlPoll=Date.now()',f.c);
 f.advance(5000);await f.c.pollWatchlist();assert.equal(f.calls.length,0);
 f.advance(1001);await f.c.pollWatchlist();assert.equal(f.calls.length,1);assert.equal(f.c.clientUsdPerQuote('JPY'),1/150.01);
});
test('invalidating a quote retains its source watermark so an older packet cannot revive it',()=>{
 const f=fixture();f.seed('USDJPY',{bid:150,ask:150.02,received_ts:2000});f.seed('USDJPY',{status:'stale',received_ts:3000});
 f.seed('USDJPY',{bid:150,ask:150.02,received_ts:2000});assert.equal(f.c.clientUsdPerQuote('JPY'),null);
 f.seed('USDJPY',{bid:151,ask:151.02,received_ts:4000});assert.equal(f.c.clientUsdPerQuote('JPY'),1/151.01);
});
