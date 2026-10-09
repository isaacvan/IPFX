import fs from 'node:fs';import vm from 'node:vm';import test from 'node:test';import assert from 'node:assert/strict';import{stripTypeScriptTypes}from 'node:module';
const source=fs.readFileSync(new URL('../supabase/functions/book-executor/index.ts',import.meta.url),'utf8'),a=source.indexOf('async function destination('),b=source.indexOf('// Deterministic split',a);
test('a second connection cannot enable orders on the same monitored E8 account',async()=>{
 for(const book of ['a','b','l1','s1']){
  let decryptions=0;const ctx={Deno:{env:{get:()=> 'synthetic-placeholder'}},Number,String,Date,decryptSecret:async()=>{decryptions++;throw Error('Must not decrypt a monitored execution alias')}};
  vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(source.slice(a,b))+'\nglobalThis.getDestination=destination',ctx);
  const d={account_id:'synthetic-account',api_env:'demo',access_token_ciphertext:'synthetic-only',role:book.startsWith('s')?'shadow':book.startsWith('l')?'ladder':undefined};
  const db={from(){let head=false;const q={select(_,options){head=options?.head===true;return q},eq(){return q},in(){return q},maybeSingle:async()=>({data:d,error:null}),then(resolve,reject){return Promise.resolve({data:null,count:head?1:null,error:null}).then(resolve,reject)}};return q}};
  assert.equal(await ctx.getDestination(db,book,true),null);assert.equal(decryptions,0);
 }
});
