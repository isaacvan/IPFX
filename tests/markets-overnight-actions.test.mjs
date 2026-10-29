import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../trading.html',import.meta.url),'utf8');
const section=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function engine(){
 const messages=[],calls=[],timers=new Map(),requests=[];
 const original={account:{id:'demo',is_demo:true,challenge_type:'demo'},open_trades:[]};
 const c=vm.createContext({engineState:original,lastStateAt:1,selectedAccountMode:'demo',accountModeIntent:'demo',
  freshToken:async()=> 'synthetic',blockInfinityTradeAttempt:()=>false,ENGINE_URL:'https://fixture.invalid',
  AbortController,setTimeout:(fn,ms)=>{timers.set(ms,fn);return ms;},clearTimeout:ms=>timers.delete(ms),
  engineMsg:(m,ok)=>messages.push({m,ok}),localStorage:{setItem(){}},sessionStorage:{getItem(){},setItem(){}},
  announceAutoClosedTrades(){},showVenueBanner(){},handleAlerts(){},liveQuotesBySymbol:new Map(),renderPositions(){},renderEngineAccount(){},
  fetch:async(url,options)=>{calls.push(JSON.parse(options.body));const d=deferred();requests.push(d);return d.promise;}});
 vm.runInContext(section('async function engineCall(body){','// Non-trading engine calls'),c);
 const reply=(index,id,extra={})=>requests[index].resolve({ok:true,status:200,json:async()=>({ok:true,account:{id,is_demo:true,challenge_type:'demo'},open_trades:[],...extra})});
 return{c,calls,timers,messages,reply,original};
}
test('a late poll cannot overwrite a more recent confirmed account snapshot',async()=>{
 const f=engine(),a=f.c.engineCall({action:'state'}),b=f.c.engineCall({action:'state'});await new Promise(setImmediate);
 f.reply(1,'new');await b;f.reply(0,'old');await a;assert.equal(f.c.engineState.account.id,'new');
});
test('a late old lockout cannot overwrite a newer account lockout status',async()=>{
 const f=engine(),a=f.c.engineCall({action:'state'}),b=f.c.engineCall({action:'state'});await new Promise(setImmediate);
 f.reply(1,'new',{infinity_lockout:{locked:false}});await b;
 f.reply(0,'old',{infinity_lockout:{locked:true}});await a;
 assert.equal(f.c.engineState.infinity_lockout.locked,false);
});
test('switching account during token refresh never dispatches the click into the new account',async()=>{
 const f=engine(),auth=deferred();f.c.freshToken=()=>auth.promise;
 const a=f.c.engineCall({action:'open',symbol:'EURUSD',volume:.01});
 f.c.selectedAccountMode='challenge';f.c.accountModeIntent='challenge';auth.resolve('synthetic');await new Promise(setImmediate);
 if(f.calls.length)f.reply(0,'unexpected');await a;
 assert.equal(f.calls.length,0);assert.match(f.messages.at(-1).m,/account changed/i);
});
test('switching away and back while auth waits still cancels the original unsent click',async()=>{
 const f=engine(),auth=deferred();f.c.freshToken=()=>auth.promise;
 f.c.document={getElementById:()=>({classList:{toggle(){}}})};f.c.currentInfinityLock=()=>null;
 vm.runInContext(section('async function setAccountMode(mode){','let infStripe='),f.c);
 const order=f.c.engineCall({action:'open'}),away=f.c.setAccountMode('challenge'),back=f.c.setAccountMode('demo');
 auth.resolve('synthetic');await new Promise(setImmediate);
 assert.deepEqual(f.calls.map(c=>c.action),['state']);f.reply(0,'demo');await Promise.all([order,away,back]);
});
test('a delayed reply from another account never replaces the newly selected account',async()=>{
 const f=engine(),a=f.c.engineCall({action:'state'});await new Promise(setImmediate);
 f.c.selectedAccountMode='challenge';f.c.accountModeIntent='challenge';f.c.engineState={account:{id:'challenge'},open_trades:[]};
 f.reply(0,'old-demo');await a;assert.equal(f.c.engineState.account.id,'challenge');assert.equal(f.c.selectedAccountMode,'challenge');
});
test('auth exceptions and hangs are bounded and no trading request is sent',async()=>{
 for(const hang of[false,true]){
  const f=engine();f.c.freshToken=()=>hang?new Promise(()=>{}):Promise.reject(Error('synthetic auth failure'));
  const p=f.c.engineCall({action:'open'});await new Promise(setImmediate);
  if(hang)f.timers.get(15000)();
  assert.equal(await p,null);assert.equal(f.calls.length,0);assert.match(f.messages.at(-1).m,/no action was sent/i);
 }
});
test('close timeout names its actual 60-second deadline and never implies a safe retry',async()=>{
 const f=engine();f.c.fetch=async()=>{const e=Error('synthetic');e.name='AbortError';throw e;};
 await f.c.engineCall({action:'close'});assert.match(f.messages.at(-1).m,/60s/);assert.match(f.messages.at(-1).m,/may have completed/);
});
function reversal({stillOpen=false,changeSymbol=false,changeAccount=false,symbol='EURUSD'}={}){
 const calls=[],messages=[];
 const c=vm.createContext({activeSym:symbol,engineBusy:false,selectedAccountMode:'demo',engineState:{account:{id:'demo'},open_trades:[{id:'eur',symbol:'EURUSD',side:'buy'},{id:'gold',symbol:'XAUUSD',side:'sell'}]},execSymbol:s=>s,
  engineMsg:m=>messages.push(m),placeOrder:async side=>calls.push({action:'open',side,symbol:c.activeSym}),
  closeTradeById:async id=>{calls.push({action:'close',id});if(!stillOpen)c.engineState.open_trades=c.engineState.open_trades.filter(t=>t.id!==id);if(changeSymbol)c.activeSym='XAUUSD';if(changeAccount)c.engineState.account.id='other';return true;}});
 vm.runInContext(section('async function reversePosition(){','function cancelAll()'),c);return{c,calls,messages};
}
test('reverse chooses the selected market, never the last unrelated open position',async()=>{
 const f=reversal();await f.c.reversePosition();assert.deepEqual(f.calls,[{action:'close',id:'eur'},{action:'open',side:'sell',symbol:'EURUSD'}]);
});
test('reverse never creates an entry before the original close is confirmed',async()=>{
 const f=reversal({stillOpen:true});await f.c.reversePosition();assert.equal(f.calls.length,1);assert.match(f.messages.at(-1),/clos/i);
});
test('reverse stops if the trader changes market or account while closing',async()=>{
 for(const options of[{changeSymbol:true},{changeAccount:true}]){const f=reversal(options);await f.c.reversePosition();assert.equal(f.calls.length,1);}
});
test('reverse with no position on this market cannot silently open a new buy',async()=>{
 const f=reversal({symbol:'USDJPY'});await f.c.reversePosition();assert.equal(f.calls.length,0);assert.match(f.messages.at(-1),/no open position/i);
});
test('close all reports remaining positions instead of claiming everything closed',async()=>{
 const messages=[],c=vm.createContext({engineBusy:false,selectedAccountMode:'demo',engineState:{account:{id:'demo'},open_trades:[{id:'one'}]},quickCloseConfirm:async()=>true,
  engineCall:async()=>({ok:true,open_trades:[{id:'one'}]}),engineMsg:(m,ok)=>messages.push({m,ok})});
 vm.runInContext(section('async function flattenAll(){','function fmtPx('),c);await c.flattenAll();
 assert.doesNotMatch(messages.at(-1).m,/All positions closed/);assert.match(messages.at(-1).m,/still open/);
});

test('close-all confirmation for one account cannot close a newly selected account',async()=>{
 const messages=[],d=deferred(),calls=[],c=vm.createContext({engineBusy:false,selectedAccountMode:'demo',engineState:{account:{id:'demo'},open_trades:[{id:'one'}]},
  quickCloseConfirm:()=>d.promise,engineCall:async body=>{calls.push(body);return{ok:true,open_trades:[]};},engineMsg:m=>messages.push(m)});
 vm.runInContext(section('async function flattenAll(){','function fmtPx('),c);
 const p=c.flattenAll();c.selectedAccountMode='challenge';c.engineState={account:{id:'challenge'},open_trades:[{id:'challenge-position'}]};d.resolve(true);await p;
 assert.equal(calls.length,0);assert.match(messages.at(-1),/account changed/i);
});

test('fill feedback stays tied to the submitted symbol and lots while the trader edits the ticket',async()=>{
 const messages=[],d=deferred(),c=vm.createContext({activeSym:'EURUSD',ordLots:.02,engineBusy:false,slOn:false,tpOn:false,orderType:'market',
  engineState:{account:{rules_version:'infinity_v1'}},
  document:{getElementById:()=>({open:false}),querySelector:()=>null},crypto:{randomUUID:()=> 'fixture'},
  blockInfinityTradeAttempt:()=>false,stageRulesBlockEntry:()=>false,dailyCapMessage:()=>null,feedFresh:()=>true,
  execSymbol:s=>s,fmtPx:(p,s)=>s+':'+p,engineMsg:m=>messages.push(m),engineCall:()=>d.promise});
 vm.runInContext(section('async function placeOrder(side){','async function cancelPending('),c);
 const p=c.placeOrder('buy');c.activeSym='XAUUSD';c.ordLots=.5;
 d.resolve({ok:true,open_trades:[{symbol:'EURUSD',side:'buy',opened_at:'2026-10-20',open_price:1.1}]});await p;
 assert.match(messages.at(-1),/BUY 0.02 EURUSD filled/);assert.match(messages.at(-1),/EURUSD:1.1/);
});
test('a pending acknowledgement cannot erase a newly edited different-market ticket',async()=>{
 const d=deferred(),messages=[],nodes={ruleCriticalDialog:{open:false},triggerPrice:{value:'1.11'},pendOco:{value:'old-order'}};
 const c=vm.createContext({activeSym:'EURUSD',ordLots:.02,engineBusy:false,slOn:false,tpOn:false,orderType:'limit',
  engineState:{account:{rules_version:'infinity_v1'}},
  document:{getElementById:id=>nodes[id],querySelector:()=>null},pendingExpiryIso:()=>null,
  blockInfinityTradeAttempt:()=>false,stageRulesBlockEntry:()=>false,dailyCapMessage:()=>null,feedFresh:()=>true,
  execSymbol:s=>s,fmtPx:(p,s)=>s+':'+p,engineMsg:m=>messages.push(m),engineCall:body=>body.action==='state'?null:d.promise});
 vm.runInContext(section('async function placeOrder(side){','async function cancelPending('),c);
 const p=c.placeOrder('buy');c.activeSym='XAUUSD';c.ordLots=.5;nodes.triggerPrice.value='2700';nodes.pendOco.value='new-order';
 d.resolve({ok:true,pending:{id:'fixture'}});await p;
 assert.equal(nodes.triggerPrice.value,'2700');assert.equal(nodes.pendOco.value,'new-order');assert.match(messages.at(-1),/BUY limit 0.02 EURUSD/);
});

test('classic market and pending entry refuse unfinished and invalid active stop/target fields',async()=>{
 for(const orderType of ['market','limit'])for(const field of ['slPrice','tpPrice'])for(const value of ['','-1','0','Infinity','1.12suffix']){
  const calls=[],messages=[],nodes={ruleCriticalDialog:{open:false},slPrice:{value:'1.12'},tpPrice:{value:'1.13'},triggerPrice:{value:'1.125'},pendOco:{value:''}};
  nodes[field]={value,validity:{badInput:value===''}};
  const c=vm.createContext({activeSym:'EURUSD',ordLots:.02,engineBusy:false,slOn:true,tpOn:true,orderType,crypto:{randomUUID:()=> 'synthetic-order'},
   document:{getElementById:id=>nodes[id],querySelector:()=>null},pendingExpiryIso:()=>null,
   blockInfinityTradeAttempt:()=>false,stageRulesBlockEntry:()=>false,dailyCapMessage:()=>null,feedFresh:()=>true,
   execSymbol:s=>s,engineMsg:m=>messages.push(m),engineCall:async p=>{calls.push(p);return null;}});
  vm.runInContext(section('async function placeOrder(side){','async function cancelPending('),c);
  await c.placeOrder('buy');assert.equal(calls.length,0,`${orderType} ${field} ${value}`);assert.match(messages[0],/valid positive/);assert.equal(c.engineBusy,false);
  nodes[field].value=field==='slPrice'?'1.12':'1.13';nodes[field].validity.badInput=false;
  await c.placeOrder('buy');assert.equal(calls.length,1);assert.equal(calls[0].sl,1.12);assert.equal(calls[0].tp,1.13);
 }
});

test('spot SL/TP steppers retain quote precision and move exactly one displayed tick',()=>{
 for(const [symbol,digits,price,expected] of[['EURUSD',5,'1.10000','1.10001'],['USDJPY',3,'150.123','150.124'],['XAGUSD',3,'31.123','31.124'],['XAUUSD',2,'2700.12','2700.13'],['DJI',0,'41000','41001']]){
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{value:price,classList:{add(){},toggle(){}},dispatchEvent(){}});return nodes.get(id);};
  const c=vm.createContext({activeSym:symbol,domDigits:digits,ordMidPrice:Number(price),slOn:false,tpOn:false,
   pxDigits:()=>digits,futSym:()=>null,document:{getElementById:node},updatePnlPreview(){},updateRiskPreview(){},updateSltpReadouts(){},Event});
  vm.runInContext(section('function adjSltp(type,dir){','function updateSltpReadouts('),c);
  c.adjSltp('sl',1);assert.equal(node('slPrice').value,expected,symbol);
  c.adjSltp('sl',-1);assert.equal(node('slPrice').value,price,symbol+' round trip');
 }
});
