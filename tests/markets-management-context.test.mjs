import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../trading.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('let omTradeId=null'),html.indexOf('// Break-even:'));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function fixture(){
 const nodes=new Map(),calls=[],messages=[];
 const node=id=>{if(!nodes.has(id)){let value='';nodes.set(id,{get value(){return value;},set value(v){value=String(v);},textContent:'',style:{},disabled:false,classList:{add(){},remove(){},contains(){return true;}},focus(){},select(){}});}return nodes.get(id);};
 const c=vm.createContext({engineBusy:false,selectedAccountMode:'demo',engineState:{account:{id:'demo'},open_trades:[
  {id:'one',side:'buy',symbol:'EURUSD',volume:.1,open_price:1.12345,sl:1.12,tp:1.13},
  {id:'two',side:'sell',symbol:'USDJPY',volume:.2,open_price:150.123,sl:151,tp:149}]},
  document:{getElementById:node},fmtPx:(price,symbol)=>`${symbol}:${price}`,quickCloseConfirm:async()=>true,
  engineCall:async body=>{calls.push(body);return{ok:true};},engineMsg:(m,ok)=>messages.push({m,ok})});
 vm.runInContext(source,c);return{c,node,calls,messages};
}
test('partial-close confirmation cannot move into another account or survive away/back',async()=>{
 for(const awayBack of[false,true]){
  const f=fixture(),d=deferred();f.c.quickCloseConfirm=()=>d.promise;f.c.openPartialDialog('one');
  const p=f.c.omSubmit();
  if(awayBack)f.c.engineCall.modeVersion=2;
  else{f.c.selectedAccountMode='challenge';f.c.engineState.account.id='challenge';}
  d.resolve(true);await p;assert.equal(f.calls.length,0);
 }
});
test('partial-close repeated clicks share one confirmation and send only one request',async()=>{
 const f=fixture(),d=deferred();let confirms=0;f.c.quickCloseConfirm=()=>{confirms++;return d.promise;};f.c.openPartialDialog('one');
 const a=f.c.omSubmit(),b=f.c.omSubmit();d.resolve(true);await Promise.all([a,b]);
 assert.equal(confirms,1);assert.equal(f.calls.length,1);assert.equal(f.calls[0].volume,.05);
});
test('partial-close confirmation rechecks busy state and changed or closed positions',async()=>{
 for(const change of['busy','resize','closed']){
  const f=fixture(),d=deferred();f.c.quickCloseConfirm=()=>d.promise;f.c.openPartialDialog('one');const p=f.c.omSubmit();
  if(change==='busy')f.c.engineBusy=true;
  if(change==='resize')f.c.engineState.open_trades[0].volume=.07;
  if(change==='closed')f.c.engineState.open_trades=[];
  d.resolve(true);await p;assert.equal(f.calls.length,0,change);
  if(change==='busy')assert.equal(f.c.engineBusy,true,'must not release another action lock');
 }
});
test('closing or replacing a dialog cancels its unsubmitted confirmation',async()=>{
 for(const replacement of[false,true]){
  const f=fixture(),d=deferred();f.c.quickCloseConfirm=()=>d.promise;f.c.openPartialDialog('one');const p=f.c.omSubmit();
  if(replacement)f.c.openModifyDialog('two');else f.c.omClose();d.resolve(true);await p;
  assert.equal(f.calls.length,0);
 }
});
test('late success or failure cannot close, relabel or add errors to a newer dialog',async()=>{
 for(const result of[{ok:true},null]){
  const f=fixture(),d=deferred();f.c.engineCall=body=>{f.calls.push(body);return d.promise;};f.c.openModifyDialog('one');
  const p=f.c.omSubmit();f.c.openPartialDialog('two');d.resolve(result);await p;
  assert.equal(f.node('omTitle').textContent,'Partial close');assert.equal(f.node('omGo').textContent,'Close part');
  assert.equal(vm.runInContext('omTradeId',f.c),'two');assert.equal(f.node('omErr').textContent,'');
  assert.equal(f.messages.length,0);
 }
});
test('a dialog opened on a prior account cannot submit even without a confirmation await',async()=>{
 const f=fixture();f.c.openModifyDialog('one');f.c.engineCall.modeVersion=2;await f.c.omSubmit();assert.equal(f.calls.length,0);
});
test('unconfirmed management results never call an uncertain action rejected',async()=>{
 const f=fixture();f.c.engineCall=async()=>null;f.c.openModifyDialog('one');await f.c.omSubmit();
 assert.match(f.node('omErr').textContent,/not confirmed|could not confirm/i);
 assert.match(f.node('omErr').textContent,/positions|history/i);assert.doesNotMatch(f.node('omErr').textContent,/rejected/);
 assert.equal(f.c.engineBusy,false);assert.equal(f.node('omGo').disabled,false);
});
test('management dialogs format the position price with its own symbol precision',()=>{
 const f=fixture();for(const open of['openModifyDialog','openPartialDialog','openTrailDialog']){
  f.c[open]('two');assert.match(f.node('omSub').textContent,/USDJPY:150.123/);
 }
});
test('valid modify, trailing off and partial payloads retain existing action semantics',async()=>{
 const f=fixture();f.c.openModifyDialog('one');f.node('omF2').value='';await f.c.omSubmit();
 f.c.openTrailDialog('one');await f.c.omSubmit();f.c.openPartialDialog('one');await f.c.omSubmit();
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[
  {action:'modify',trade_id:'one',sl:1.12,tp:null},
  {action:'set_trailing',trade_id:'one',distance:null},
  {action:'partial_close',trade_id:'one',volume:.05}]);
 assert.equal(f.c.engineBusy,false);assert.equal(f.node('omGo').disabled,false);
});

test('incomplete numeric input cannot remove an existing stop or disable trailing',async()=>{
 for(const open of['openModifyDialog','openTrailDialog']){
  const f=fixture();f.c[open]('one');f.node('omF1').value='';f.node('omF1').validity={badInput:true};await f.c.omSubmit();
  assert.equal(f.calls.length,0,open);assert.match(f.node('omErr').textContent,/valid|finish/i);
 }
 const f=fixture();f.c.openModifyDialog('one');f.node('omF2').value='';f.node('omF2').validity={badInput:true};await f.c.omSubmit();assert.equal(f.calls.length,0);
});
test('partial-close quantities cannot be silently rounded to a different slice',async()=>{
 for(const value of['0.015','0.019','0.0501']){
  const f=fixture();f.c.openPartialDialog('one');f.node('omF1').value=value;await f.c.omSubmit();
  assert.equal(f.calls.length,0,value);assert.match(f.node('omErr').textContent,/0\.01|increment/i);
 }
});
test('management rejects nonfinite or nonpositive nonblank levels before sending',async()=>{
 for(const value of['-1','0','Infinity','1.12suffix']){
  const f=fixture();f.c.openModifyDialog('one');f.node('omF1').value=value;await f.c.omSubmit();assert.equal(f.calls.length,0,value);
 }
});
test('futures partial close uses whole contracts and a whole-contract default',async()=>{
 const f=fixture();f.c.futSym=s=>s==='CME:ES'?'ES':null;f.c.engineState.open_trades[0].symbol='CME:ES';f.c.engineState.open_trades[0].volume=3;
 f.c.openPartialDialog('one');assert.equal(f.node('omF1').value,'1');assert.match(f.node('omF1Label').textContent,/contracts/i);
 f.node('omF1').value='1.5';await f.c.omSubmit();assert.equal(f.calls.length,0);
 f.node('omF1').value='1';await f.c.omSubmit();assert.equal(f.calls.length,1);assert.equal(f.calls[0].volume,1);
});
test('ordinary decimal slices remain accepted and hidden unused fields do not block them',async()=>{
 const f=fixture();f.c.engineState.open_trades[0].volume=.58;f.c.openPartialDialog('one');f.node('omF1').value='.29';
 f.node('omF2').validity={badInput:true};await f.c.omSubmit();assert.equal(f.calls.length,1);assert.equal(f.calls[0].volume,.29);
});
