import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import{stripTypeScriptTypes}from'node:module';
import{solutionOptions}from'../supabase/functions/_shared/brain-solutions.ts';
const owner='44444444-4444-4444-8444-444444444444',person='11111111-1111-4111-8111-111111111111';
const raw=fs.readFileSync(new URL('../supabase/functions/brain-monitor/index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
async function harness({email='owner@example.test',mfa='aal2',auditFails=false,path=person+'/passport.jpg',rate=true}={}){
 let handler;const signed=[],rpcCalls=[],reads=[];
 const rows={admins:{user_id:owner},ab_alerts:{id:1,key:'trader:NO_SL:'+person,category:'rules',severity:'warning',person_id:person,first_seen:'2026-10-08T00:00:00Z',title:'Stop loss review',resolved_at:null},
 trader_identity_private:{legal_first_name:'Synthetic',legal_last_name:'Applicant',address_line_1:'Test street'},challenge_enrolment_requests:[],kyc_submissions:[{id:person,doc_type:'id_front',created_at:'2026-10-08'}],trader_kyc:{status:'pending'},user_profiles:{full_name:'Synthetic Applicant'}};
 const db={auth:{admin:{getUserById:async()=>({data:{user:{email:'synthetic@example.test'}},error:null})}},
  storage:{from:()=>({createSignedUrl:async(p,ttl)=>{signed.push({p,ttl});return{data:{signedUrl:'https://example.test/private'},error:null};}})},
  rpc:async(name,args)=>{rpcCalls.push({name,args});return{data:{ok:true,message:'Synthetic action applied'},error:null};},
  from:(table)=>{reads.push(table);let result={data:rows[table]??null,error:null,count:0};const q={then:(resolve,reject)=>Promise.resolve(result).then(resolve,reject)};
   for(const method of['select','eq','is','in','order','range','limit','maybeSingle'])q[method]=()=>q;
   q.insert=()=>{result={data:null,error:auditFails?{code:'FAIL'}:null};return q;};return q;}};
 const auth={auth:{getUser:async()=>({data:{user:{id:owner,email}}})}};
 let clients=0;
 const Deno={env:{get:k=>k==='IPFX_OWNER_EMAIL'?'owner@example.test':'synthetic-config'},serve:h=>handler=h};
 new Function('Deno','createClient','allowRequest','readJsonObject','solutionOptions',stripTypeScriptTypes(raw))
  (Deno,()=>++clients%2===1?auth:db,async()=>rate,req=>req.json(),solutionOptions);
 const invoke=async body=>handler(new Request('https://example.test/brain',{method:'POST',headers:{origin:'https://ipfxcapital.com','content-type':'application/json',authorization:'Bearer a.'+btoa(JSON.stringify({aal:mfa}))+'.c'},body:JSON.stringify(body)}));
 return{invoke,signed,rpcCalls,reads};
}
test('owner MFA, owner identity and rate gate precede private identity access',async()=>{
 for(const[options,status]of[[{mfa:'aal1'},401],[{email:'outsider@example.test'},403],[{rate:false},429]]){
  const h=await harness(options),r=await h.invoke({action:'application_detail',user_id:person,reason:'Synthetic review'});assert.equal(r.status,status);assert.equal(h.signed.length,0);assert.ok(!h.reads.includes('trader_identity_private'));
 }
});
test('application metadata cannot bypass protected identity/document endpoints; audit failure is closed',async()=>{
 const failed=await harness({auditFails:true});assert.equal((await failed.invoke({action:'application_detail',user_id:person,reason:'Synthetic review'})).status,503);assert.equal(failed.signed.length,0);
 const h=await harness(),r=await h.invoke({action:'application_detail',user_id:person,reason:'Synthetic review'});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 const data=await r.json();assert.equal(h.signed.length,0);assert.ok(!h.reads.includes('trader_identity_private'));assert.equal(data.identity,undefined);assert.equal(data.documents[0].id,person);assert.equal(data.documents[0].url,undefined);
});
test('solution API uses verified actor, validates offered action, and passes immutable alert occurrence',async()=>{
 const h=await harness(),request=crypto.randomUUID(),base={action:'alert_solution',alert_id:1,reason:'Please keep a stop loss',request_id:request,occurrence:'2026-10-08T00:00:00Z',actor_id:person};
 assert.equal((await h.invoke({...base,kind:'halt_books'})).status,400);assert.equal(h.rpcCalls.length,0);
 assert.equal((await h.invoke({...base,kind:'warn'})).status,200);assert.equal(h.rpcCalls[0].args.p_actor,owner);assert.equal(h.rpcCalls[0].args.p_occurrence,base.occurrence);
});
