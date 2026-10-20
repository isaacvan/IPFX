import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const source=fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts',import.meta.url),'utf8');
const part=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const quote=(extra={})=>({symbol:'USDJPY',mid:150,bid:149.99,ask:150.01,spread:.02,providerTs:100000,receivedTs:100000,feedTs:100000,source:'fxcm-basic',...extra});
const row=q=>({...q,received_at:new Date(q.receivedTs).toISOString(),provider_ts:new Date(q.providerTs).toISOString(),feed_ts:new Date(q.feedTs).toISOString()});
function fixture(){
 let rows=[],upstream=0,reads=0;const cache=new Map();
 const c=vm.createContext({Date:class extends Date{static now(){return 100000;}},quoteCache:cache,CACHE_TTL_MS:750,INSTRUMENTS:{USDJPY:{cls:'forex'}},FXCM_SYMBOLS:{USDJPY:'USDJPY'},
  STALE_MS:8000,STALE_MS_CRYPTO:20000,STALE_MS_FUTURES:15000,SYMBOL_QUIET_MAX_MS:60000,BAD_TICK_WINDOW_MS:60000,BAD_TICK_MAX_MOVE:{forex:.03},
  fetchFxcmRaw:async()=>{upstream++;return{bid:149.99,ask:150.01,ts:100000,feedTs:100000};},lastKnownQuote:async()=>null,
  round6:n=>Math.round(n*1e6)/1e6,getCacheClient:()=>({from:()=>{const q={select(){return q;},eq(){return q;},maybeSingle:async()=>{reads++;return{data:rows[0]??null};},upsert:async()=>({}),then:resolve=>{reads++;return Promise.resolve(resolve({data:rows}));}};return q;}})});
 vm.runInContext(stripTypeScriptTypes(part('function quoteStale(','// backward-compatible mid-price')),c);
 vm.runInContext(stripTypeScriptTypes(part('async function fetchQuote(','function round6(')),c);
 vm.runInContext(stripTypeScriptTypes(part('const WARM_EVERY_MS','// Quote pump:')),c);
 return{c,cache,setRows:r=>{rows=r;},stats:()=>({upstream,reads})};
}
test('a future local-cache timestamp cannot trap the engine on that quote or reject recovery as an outlier',async()=>{
 const f=fixture();f.cache.set('USDJPY',quote({mid:1,receivedTs:200000}));const q=await f.c.fetchQuote('USDJPY');
 assert.equal(q?.mid,150);assert.equal(q.receivedTs,100000);assert.equal(f.stats().upstream,1);
});
test('a future shared-cache receipt or malformed provider timestamp falls through to a genuine quote',async()=>{
 for(const patch of[{receivedTs:200000},{providerTs:200000}]){
  const f=fixture();f.setRows([row(quote({mid:1,...patch}))]);const q=await f.c.fetchQuote('USDJPY');assert.equal(q?.mid,150);assert.equal(f.stats().upstream,1);
 }
});
test('bulk warming refuses future rows and replaces a poisoned local watermark with valid data',async()=>{
 const f=fixture();f.setRows([row(quote({receivedTs:200000}))]);await f.c.warmQuotes(true);assert.equal(f.cache.has('USDJPY'),false);
 f.cache.set('USDJPY',quote({mid:1,receivedTs:200000}));f.setRows([row(quote())]);await f.c.warmQuotes(true);assert.equal(f.cache.get('USDJPY').mid,150);
});
test('fresh valid cache hits avoid upstream calls and older warm rows cannot overwrite a newer valid quote',async()=>{
 const f=fixture(),fresh=quote();f.cache.set('USDJPY',fresh);assert.equal(await f.c.fetchQuote('USDJPY'),fresh);assert.deepEqual(f.stats(),{reads:0,upstream:0});
 f.setRows([row(quote({mid:149.9,receivedTs:99900}))]);await f.c.warmQuotes(true);assert.equal(f.cache.get('USDJPY'),fresh);
});
test('a genuine recent baseline still blocks an implausible jump through the existing bad-tick filter',async()=>{
 const f=fixture();f.cache.set('USDJPY',quote({mid:100,receivedTs:99000}));assert.equal(await f.c.fetchQuote('USDJPY'),null);assert.equal(f.stats().upstream,1);
});
