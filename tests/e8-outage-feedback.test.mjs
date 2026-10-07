import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('saved E8 quotes become visibly stale during an outage and refresh recovers',async()=>{
 const nodes=new Map(),timers=new Map();let now=Date.now(),fail=false,calls=0;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',handlers:{},addEventListener(event,fn){this.handlers[event]=fn;}});return nodes.get(id);};
 const reply={ok:true,accounts:[],summary:{accounts:[],quotes:[{account_id:1,symbol:'EURUSD',bid:1.1,ask:1.1002,spread:.0002,received_at:new Date(now).toISOString(),age_ms:100,fresh:true,max_quote_age_ms:15000}]},simulation:{positions:1,events:2,recent:[{trade_id:'fixture-trade',symbol:'EURUSD',is_practice:true,selected_book:'b',trader_side:'buy',exited_lots:.01,original_lots:.01,status:'CLOSED_GROSS_ESTIMATE',selected_gross_usd:-.25}]}};
 class Clock extends Date {static now(){return now;}}
 const ctx=vm.createContext({Date:Clock,AbortSignal,location:{replace(){throw Error('unexpected login redirect');}},document:{hidden:false,getElementById:node},window:{supabase:{createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'synthetic'}}})}})}},setInterval(fn,ms){timers.set(ms,fn);},fetch:async(_url,options)=>{calls++;assert.ok(options.signal);if(fail)throw new DOMException('synthetic timeout','TimeoutError');return{ok:true,json:async()=>reply};}});
 vm.runInContext(fs.readFileSync(new URL('../assets/js/team-e8-monitor.js',import.meta.url),'utf8'),ctx);
 await new Promise(setImmediate);
 assert.match(node('quotes').innerHTML,/Recent API reply/);
 assert.match(node('simulationTrades').innerHTML,/buy → sell \(B\)/);
 assert.match(node('simulationTrades').innerHTML,/\$-0.25/);
 assert.match(node('simulationTrades').innerHTML,/Unverified/);
 now+=20000;timers.get(1000)();assert.match(node('quotes').innerHTML,/Old API reply/);
 fail=true;await node('refresh').handlers.click();assert.match(node('status').textContent,/timed out/);
 assert.match(node('quotes').innerHTML,/Old API reply/);
 fail=false;await node('refresh').handlers.click();assert.equal(calls,3,'failed refresh releases busy state');
 assert.match(node('status').textContent,/updated/);
});

test('an unconfirmed trading request never tells the trader that no order was placed',async()=>{
 const html=fs.readFileSync(new URL('../trading.html',import.meta.url),'utf8');
 const source=html.slice(html.indexOf('async function engineCall(body){'),html.indexOf('// Non-trading engine calls'));
 for(const name of ['AbortError','TypeError']){
  let message='';const ctx=vm.createContext({freshToken:async()=> 'synthetic',selectedAccountMode:'demo',ENGINE_URL:'https://fixture.invalid',AbortController,setTimeout:()=>1,clearTimeout(){},engineMsg:m=>message=m,fetch:async()=>{const e=new Error('synthetic connection failure');e.name=name;throw e;}});
  vm.runInContext(source,ctx);assert.equal(await ctx.engineCall({action:'open'}),null);
  assert.match(message,/may have completed/);assert.match(message,/Check positions and history before retrying/);
  assert.doesNotMatch(message,/order not placed|check your connection and try again/i);
 }
});
