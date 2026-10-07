import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';import {readJsonObject} from '../supabase/functions/_shared/request-guards.ts';
const actor='66666666-6666-4666-8666-666666666666',person='22222222-2222-4222-8222-222222222222';
async function harness(options={}){
 let handler;const calls=[];
 const auth={auth:{getUser:async()=>({data:{user:options.noUser?null:{id:actor,email:options.email||'owner@fixture.invalid'}}})}};
 const db={from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:options.noAdmin?null:{user_id:actor}})}),
  rpc:async(name,args)=>{calls.push({name,args});return options.rpcError?{error:{code:'fixture'}}:{data:options.refuse?{ok:false,error:'No funded execution connection'}:{ok:true,state:args.p_target,control:'MANUAL'}};}};
 const context=vm.createContext({Response,TextEncoder,Date,JSON,Number,String,Array,Promise,Set,atob,
  Deno:{env:{get:n=>n==='IPFX_OWNER_EMAIL'?'owner@fixture.invalid':'fixture'},serve:h=>handler=h},
  createClient:(_u,_key,opts)=>opts?.global?auth:db,allowRequest:async()=>!options.limited,readJsonObject});
 const src=fs.readFileSync(new URL('../supabase/functions/brain-monitor/index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
 vm.runInContext(stripTypeScriptTypes(src),context);
 const run=async(over={})=>{
  const token='fixture.'+Buffer.from(JSON.stringify({aal:options.aal||'aal2'})).toString('base64url')+'.fixture';
  const r=await handler(new Request('https://fixture.invalid',{method:'POST',headers:{origin:'https://ipfxcapital.com',authorization:'Bearer '+token},
   body:JSON.stringify({action:'set_model',person_id:person,target:'AB_DEMO',reason:'Reviewed evidence',expected_state:'BB_DEMO',expected_manual:null,...over})}));
  return {status:r.status,body:await r.json()};
 };return{run,calls};
}
test('only the verified owner with MFA/admin membership can send a model mutation',async()=>{
 for(const opts of [{noUser:true},{aal:'aal1'},{email:'other@fixture.invalid'},{noAdmin:true},{limited:true}]){
  const h=await harness(opts);assert.ok((await h.run()).status>=400);assert.equal(h.calls.length,0);
 }
 const h=await harness();assert.equal((await h.run({actor_id:person})).status,200);
 assert.equal(h.calls[0].name,'ab_owner_set_model');assert.equal(h.calls[0].args.p_actor,actor,'client cannot spoof actor');
 assert.equal(h.calls[0].args.p_expected_manual,null);
});
test('invalid changes and unavailable execution destinations do not claim success',async()=>{
 const h=await harness();for(const over of [{target:'anything'},{person_id:'no'},{reason:'x'},{reason:'x'.repeat(301)}])assert.equal((await h.run(over)).status,400);
 assert.equal(h.calls.length,0);
 const denied=await harness({refuse:true});assert.equal((await denied.run({target:'AB_LIVE'})).status,409);
 const failed=await harness({rpcError:true});const r=await failed.run();assert.equal(r.status,503);assert.match(r.body.error,/unconfirmed/);
});
