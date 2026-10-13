import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import vm from'node:vm';import{stripTypeScriptTypes}from'node:module';
const text=fs.readFileSync(new URL('../supabase/functions/book-executor/index.ts',import.meta.url),'utf8'),code=text.slice(text.indexOf('async function destination('),text.indexOf('// Deterministic split'));
async function run({scope=null,allowed=false,role='monitor',enabled=false,exit=false}={}){
 const calls=[],row={id:3,role,execution_enabled:enabled,status:'evaluation',api_env:'demo',account_id:'300',acc_num:'1',access_token_ciphertext:'SYNTHETIC_ONLY',access_expires_at:new Date(Date.now()+4*3600000).toISOString(),instrument_map:[]};
 const db={rpc:async(name,args)=>{calls.push({name,args});return{data:allowed,error:null}},from:()=>{
  const filters=[];let count=false;const q={select:(name,options)=>{count=!!options?.count;return q},eq:(k,v)=>{filters.push(x=>x[k]===v);return q},in:(k,v)=>{filters.push(x=>v.includes(x[k]));return q},maybeSingle:()=>q,then:resolve=>resolve(count?{count:1,error:null}:{data:filters.every(f=>f(row))?row:null,error:null})};return q;
 }};
 const fn=vm.runInNewContext(stripTypeScriptTypes(code)+'\ndestination',{Deno:{env:{get:()=> 'SYNTHETIC_KEY'}},Date,Number,String,Array,decryptSecret:async()=>{calls.push({decrypt:true});return'SYNTHETIC_ONLY';},refresh:async()=>{throw Error('Unexpected fixture refresh')}});
 return{result:await fn(db,'l3',exit,scope),calls};
}
test('ordinary and alias paths cannot read/execute the monitor token; owned ongoing access is required before decryption',async()=>{
 for(const o of[{}, {scope:'other-trade'}, {role:'ladder',enabled:true}]){const r=await run(o);assert.equal(r.result,null);assert.ok(!r.calls.some(x=>x.decrypt));}
 const r=await run({scope:'owned-trade',allowed:true});assert.equal(r.result.accountId,'300');assert.equal(r.calls[0].name,'ongoing_copy_access');assert.equal(r.calls[0].args.p_trade,'owned-trade');assert.equal(r.calls[0].args.p_exit,false);
});
test('owned exits/reconciliation use the exact same guarded account even after OFF; disallowed context never falls back to an ordinary enabled alias',async()=>{
 const r=await run({scope:'owned-trade',allowed:true,exit:true});assert.equal(r.result.accountId,'300');assert.equal(r.calls[0].args.p_exit,true);
 assert.equal((await run({scope:'foreign-trade',allowed:false,role:'ladder',enabled:true,exit:true})).result,null);
});
