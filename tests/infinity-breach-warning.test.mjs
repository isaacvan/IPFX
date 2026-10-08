import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const html=fs.readFileSync(new URL('../trading.html',import.meta.url),'utf8');
function warning(){
 const nodes=new Map(),node=id=>{if(!nodes.has(id)){const set=new Set();nodes.set(id,{textContent:'',classList:{add:x=>set.add(x),remove:x=>set.delete(x),contains:x=>set.has(x)},focus(){}});}return nodes.get(id);};
 const context=vm.createContext({Date,isFinite,document:{getElementById:node},accountModeIntent:'challenge',engineState:{infinity_lockout:{locked:true,blocked_until:'2026-11-01T00:00:00Z'}},
 setAccountMode:async mode=>{context.accountModeIntent=mode;}});
 const start=html.indexOf('function currentInfinityLock()'),end=html.indexOf('function currentBreach()',start);vm.runInContext(html.slice(start,end),context);
 return{context,node};
}
test('the breach warning returns on every attempted Infinity order after dismissal, with the restart date',async()=>{
 const f=warning();for(let i=0;i<3;i++){
 assert.equal(f.context.blockInfinityTradeAttempt(),true);assert.equal(f.node('infBreachAttempt').classList.contains('open'),true);
 assert.match(f.node('infBreachAttemptText').textContent,/1 November 2026.*UTC/);assert.match(f.node('infBreachAttemptText').textContent,/No trade has been placed/);
 f.context.closeInfinityTradeWarning();assert.equal(f.node('infBreachAttempt').classList.contains('open'),false);
 }
 await f.context.choosePracticeAfterBreach();assert.equal(f.context.blockInfinityTradeAttempt(),false);
 f.context.accountModeIntent='challenge';assert.equal(f.context.blockInfinityTradeAttempt(),true);
 f.context.engineState.infinity_lockout={locked:false};assert.equal(f.context.blockInfinityTradeAttempt(),false);
});
test('a backend-blocked acknowledgement never becomes a success/filled notification',async()=>{
 let warningCount=0;const messages=[],context=vm.createContext({engineState:{account:{is_demo:true}},selectedAccountMode:'challenge',accountModeIntent:'challenge',
 blockInfinityTradeAttempt:()=>false,showInfinityTradeWarning:()=>warningCount++,freshToken:async()=> 'synthetic',ENGINE_URL:'https://fixture.invalid',
 Date,Array,AbortController,setTimeout:()=>1,clearTimeout(){},engineMsg:m=>messages.push(m),fetch:async()=>({status:409,ok:false,json:async()=>({ok:false,order_blocked:true,infinity_lockout:{locked:true,blocked_until:'2026-11-01'},error:'Account has been breached'})})});
 vm.runInContext(html.slice(html.indexOf('async function engineCall(body){'),html.indexOf('// Non-trading engine calls')),context);
 assert.equal(await context.engineCall({action:'open'}),null);assert.equal(await context.engineCall({action:'place_pending'}),null);
 assert.equal(warningCount,2);assert.equal(messages.some(m=>/filled|resting/i.test(m)),false);
});
