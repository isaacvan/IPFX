import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(process.env.MARKETS_GUIDED_TEST_SOURCE||new URL('../assets/js/markets-guided.js',import.meta.url),'utf8');
function fixture({stored=false,storageBlocked=false,accountReady=true}={}){
 const nodes=[],intervals=new Map(),timeouts=new Map(),listeners=new Map(),storage=new Map(stored?[['ipfx-markets-tour-v1','1']]:[]);
 let serial=0;const gate={modal:false,cookie:false,visible:true};
 const target={hidden:false,get offsetParent(){return gate.visible?{}:null;},getClientRects:()=>gate.visible?[{}]:[],getBoundingClientRect:()=>({left:100,top:100,right:220,bottom:130,width:120,height:30})};
 const make=()=>{const children=new Map();return{style:{},className:'',classList:{toggle(){},remove(){}},setAttribute(){},appendChild(){},before(){},after(){},addEventListener(){},focus(){},remove(){const index=nodes.indexOf(this);if(index>=0)nodes.splice(index,1);},querySelector(selector){if(!children.has(selector))children.set(selector,{focus(){}});return children.get(selector);}};};
 const c={activeSym:'EURUSD',engineState:accountReady?{account:{id:'synthetic-demo'}}:null,
  document:{readyState:'complete',head:make(),body:{...make(),append(...items){nodes.push(...items);}},getElementById:id=>id==='gtCard'?{}:null,createElement:make,
   querySelector(selector){if(selector==='.tb-feedback')return null;if(selector==='dialog[open]')return gate.modal?target:null;if(selector==='.ipfx-cookie-panel')return gate.cookie?target:null;if(selector==='.gt-tour-card')return nodes.find(n=>n.className==='gt-tour-card')??null;return target;},
   querySelectorAll(selector){if(selector.includes('gt-tour-scrim'))return nodes.slice();if(selector.includes('dialog'))return gate.modal?[target]:[];return[];},
   addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}},
  localStorage:{getItem:key=>{if(storageBlocked)throw Error('Storage blocked');return storage.get(key)??null;},setItem:(key,value)=>{if(storageBlocked)throw Error('Storage blocked');storage.set(key,value);}},
  setInterval:(fn,ms)=>{const id=++serial;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),setTimeout:(fn,ms)=>{const id=++serial;timeouts.set(id,{fn,ms});return id;},
  placeOrder:async()=>{},innerWidth:1440,innerHeight:1000};c.window=c;vm.createContext(c);vm.runInContext(source,c);
 const tick=()=>{for(const {fn,ms}of [...intervals.values()])if(ms===1000)fn();};
 const flush=()=>{const pending=[...timeouts.values()];timeouts.clear();for(const {fn}of pending)fn();};
 const count=()=>nodes.filter(n=>n.className==='gt-tour-card').length;
 const close=()=>nodes.find(n=>n.className==='gt-tour-card').querySelector('.gt-x').onclick();
 return{c,gate,tick,flush,count,close,listeners,storage};
}
test('a queued automatic tour cannot reopen after the trader manually opens and dismisses it',()=>{
 const f=fixture();f.tick();f.c.ipfxTour();assert.equal(f.count(),1);f.close();assert.equal(f.count(),0);f.flush();f.tick();assert.equal(f.count(),0);
 f.c.ipfxTour();assert.equal(f.count(),1,'explicit replay remains available');
});
test('a dismissed manual tour stays dismissed in this page even when localStorage is blocked',()=>{
 const f=fixture({storageBlocked:true});f.c.ipfxTour();f.close();f.tick();f.flush();assert.equal(f.count(),0);
});
for(const [gate,label]of [['cookie','privacy choice'],['modal','native dialog']])test('automatic startup rechecks '+label+' after its delay and retries when clear',()=>{
  const f=fixture();f.tick();f.gate[gate]=true;f.flush();assert.equal(f.count(),0,gate);
  f.gate[gate]=false;f.tick();f.flush();assert.equal(f.count(),1,gate+' cleared');
});
test('the automatic tour waits for the ticket to be visible instead of consuming its first visit while hidden',()=>{
 const f=fixture();f.gate.visible=false;f.tick();f.flush();assert.equal(f.count(),0);assert.equal(f.storage.has('ipfx-markets-tour-v1'),false);
 f.gate.visible=true;f.tick();f.flush();assert.equal(f.count(),1);
});
test('a prior visit prevents automatic startup and late account loading still permits a genuine first visit',()=>{
 const seen=fixture({stored:true});seen.tick();seen.flush();assert.equal(seen.count(),0);seen.c.ipfxTour();assert.equal(seen.count(),1);
 const late=fixture({accountReady:false});late.tick();late.flush();assert.equal(late.count(),0);late.c.engineState={account:{id:'synthetic-demo'}};late.tick();late.flush();assert.equal(late.count(),1);
});
test('escape dismisses immediately, releases its listener and preserves the seen marker',()=>{
 const f=fixture();f.c.ipfxTour();let prevented=false;f.listeners.get('keydown')({key:'Escape',preventDefault(){prevented=true;},stopPropagation(){}});
 assert.equal(prevented,true);assert.equal(f.count(),0);assert.equal(f.listeners.has('keydown'),false);assert.equal(f.storage.get('ipfx-markets-tour-v1'),'1');
});
