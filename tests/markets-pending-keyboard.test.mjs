import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../trading.html',import.meta.url),'utf8');
const engine=fs.readFileSync(new URL('../supabase/functions/trading-engine/index.ts',import.meta.url),'utf8');
const cancelBlock=engine.slice(engine.indexOf('  if (action === "cancel_pending") {'),engine.indexOf('  // ---- price alerts ----',engine.indexOf('  if (action === "cancel_pending") {'))).replaceAll('acct as Acct','acct');
const hotkeys=html.slice(html.indexOf('let hotkeysOn=false'),html.indexOf('function adjLots('));

// Run the production query builder against isolated rows. All filters come
// from the actual engine branch, including owner, account and pending status.
function pendingFixture(){
 const rows=[{id:'demo-order',account_id:'demo',user_id:'owner',status:'pending',symbol:'EURUSD',side:'buy',volume:.01,trigger_price:1.1},
  {id:'challenge-order',account_id:'challenge',user_id:'owner',status:'pending'},
  {id:'foreign-order',account_id:'demo',user_id:'other',status:'pending'},
  {id:'filled-order',account_id:'demo',user_id:'owner',status:'filled'}],audit=[];
 const c=vm.createContext({action:'cancel_pending',body:{},acct:{id:'demo'},user:{id:'owner'},state:{open:[],equity:1000,floating:0},clientIp:'synthetic',
  err:(error,status=400)=>({ok:false,error,status}),jsonOk:data=>({ok:true,...data}),statePayload:async()=>({pending_orders:rows.filter(r=>r.account_id==='demo'&&r.status==='pending')}),logAudit:async(_db,event)=>audit.push(event),
  db:{from:table=>{assert.equal(table,'pending_orders');let patch;const filters=[];return{update(value){patch=value;return this;},eq(key,value){filters.push([key,value]);return this;},async select(){const data=rows.filter(row=>filters.every(([key,value])=>row[key]===value));data.forEach(row=>Object.assign(row,patch));return{data};}};}}});
 vm.runInContext('async function cancel(){'+cancelBlock+'}',c);return{c,rows,audit};
}
test('pending cancellation is bound to the selected account as well as owner',async()=>{
 const f=pendingFixture();f.c.body={order_id:'challenge-order'};const r=await f.c.cancel();
 assert.equal(r.ok,false);assert.equal(f.rows[1].status,'pending');assert.equal(f.audit.length,0);
});
test('valid cancellation succeeds, while foreign, filled and repeated cancellation stay refused',async()=>{
 const f=pendingFixture();f.c.body={order_id:'demo-order'};assert.equal((await f.c.cancel()).ok,true);
 assert.equal(f.rows[0].status,'cancelled');assert.equal(f.audit.length,1);assert.equal(f.audit[0].account_id,'demo');
 for(const id of['demo-order','foreign-order','filled-order','missing']){f.c.body={order_id:id};assert.equal((await f.c.cancel()).ok,false);}
 assert.equal(f.rows[2].status,'pending');assert.equal(f.rows[3].status,'filled');assert.equal(f.audit.length,1);
});
function keyboard(){
 let modal=false;const listeners={},calls=[],messages=[],query=selector=>modal&&(selector.includes('.gt-tour-card')||selector.includes('[role="dialog"]')||selector.includes('dialog[open]'))?[{getClientRects:()=>[{}]}]:[];
 const c=vm.createContext({localStorage:{getItem:()=> 'on',setItem(){}},document:{addEventListener:(name,fn)=>listeners[name]=fn,querySelector:selector=>query(selector)[0]||null,querySelectorAll:query,getElementById:()=>null},
  orderType:'market',engineState:{account:{id:'demo'}},selectedAccountMode:'demo',engineCall:Object.assign(()=>{}, {modeVersion:0}),
  engineMsg:m=>messages.push(m),placeOrder:side=>calls.push(side),flattenAll:()=>calls.push('close_all'),confirm:()=>true});
 vm.runInContext(hotkeys,c);
 const press=(key,extra={})=>listeners.keydown({key,shiftKey:true,target:{tagName:'BUTTON'},preventDefault(){},...extra});
 return{c,calls,messages,press,focus:()=>listeners.focusin?.(),setModal:v=>modal=v};
}
test('trading hotkeys cannot open or close positions while the tour or native dialog is visible',()=>{
 const f=keyboard();f.setModal(true);f.press('B');f.press('S');f.press('X');f.press('X');assert.deepEqual(f.calls,[]);
});
test('close-all keyboard confirmation cannot carry across an account switch or away/back',()=>{
 for(const awayBack of[false,true]){
  const f=keyboard();f.press('X');
  if(awayBack)f.c.engineCall.modeVersion=2;else{f.c.engineState.account.id='challenge';f.c.selectedAccountMode='challenge';}
  f.press('X');assert.deepEqual(f.calls,[]);f.press('X');assert.deepEqual(f.calls,['close_all']);
 }
});
test('entering a dialog or toggling shortcuts clears an armed close-all confirmation',()=>{
 const f=keyboard();f.press('X');f.setModal(true);f.press('X');f.setModal(false);f.press('X');assert.deepEqual(f.calls,[]);
 f.c.toggleHotkeys();f.c.toggleHotkeys();f.press('X');assert.deepEqual(f.calls,[]);
});
test('moving keyboard focus interrupts the two-press close-all sequence',()=>{
 const f=keyboard();f.press('X');f.focus();f.press('X');assert.deepEqual(f.calls,[]);
});
test('normal opted-in keys still trade once and typing, modifiers and auto-repeat remain ignored',()=>{
 const f=keyboard();f.press('B');assert.deepEqual(f.calls,['buy']);
 for(const extra of[{repeat:true},{ctrlKey:true},{altKey:true},{metaKey:true},{target:{tagName:'INPUT'}},{target:{tagName:'TEXTAREA'}},{target:{tagName:'SELECT'}},{target:{isContentEditable:true}}])f.press('S',extra);
 assert.deepEqual(f.calls,['buy']);f.press('X');f.press('X');assert.deepEqual(f.calls,['buy','close_all']);
});
