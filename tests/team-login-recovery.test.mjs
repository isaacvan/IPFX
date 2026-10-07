import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';

function loginFixture({failure='network',existingSession=false,allow=true}={}){
 const elements=new Map(),navigation=[];let activeSession=existingSession,signOuts=0;
 const get=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',disabled:false,style:{},on:false,classList:{toggle(_name,on){get(id).on=on;}},focus(){},addEventListener(name,fn){this[name]=fn;}});return elements.get(id);};
 const sdk={auth:{getSession:async()=>({data:{session:activeSession?{access_token:'synthetic-session'}:null}}),
  signInWithPassword:async()=>{activeSession=true;return{error:null};},signOut:async()=>{signOuts++;},
  mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:'aal1'},error:null}),listFactors:async()=>({data:{totp:[{id:'fixture-factor',status:'verified'}]},error:null}),
   challengeAndVerify:async()=>({data:{},error:null})}}};
 const context=vm.createContext({window:{supabase:{createClient:()=>sdk}},document:{getElementById:get},location:{search:'?next=%2Fteam-e8-monitor.html',replace:u=>navigation.push(u)},
  URLSearchParams,AbortSignal,Error,String,fetch:async()=>{if(failure==='network')throw new TypeError('Failed to fetch');return new Response(JSON.stringify({team_access:allow}),{status:failure==='service'?503:200});}});
 const html=fs.readFileSync(new URL('../team-login.html',import.meta.url),'utf8'),source=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];vm.runInContext(source,context);
 return{get,navigation,setFailure:x=>failure=x,get signOuts(){return signOuts;},settle:()=>new Promise(r=>setImmediate(r)),submit:()=>get('loginForm').submit({preventDefault(){}})};
}
test('failed network access check restores password form, clears password and permits MFA retry',async()=>{
 const f=loginFixture();await f.settle();f.get('password').value='synthetic-test-value';await f.submit();
 assert.equal(f.get('checkingStage').on,false);assert.equal(f.get('passwordStage').on,true);assert.equal(f.get('loginButton').disabled,false);assert.equal(f.get('password').value,'');assert.match(f.get('error').textContent,/Could not reach/);assert.equal(f.signOuts,0);
 f.setFailure(null);await f.submit();assert.equal(f.get('mfaStage').on,true);assert.deepEqual(f.navigation,[]);
 f.get('code').value='123456';await f.get('mfaForm').submit({preventDefault(){}});assert.deepEqual(f.navigation,['/team-e8-monitor.html']);
});
test('temporary access-service failure does not masquerade as an owner denial',async()=>{
 const f=loginFixture({failure:'service'});await f.settle();await f.submit();assert.equal(f.get('passwordStage').on,true);assert.equal(f.signOuts,0);assert.match(f.get('error').textContent,/temporarily unavailable/);
});
test('existing session failure also recovers, while actual owner denial stays denied',async()=>{
 const f=loginFixture({existingSession:true});await f.settle();assert.equal(f.get('passwordStage').on,true);assert.equal(f.get('checkingStage').on,false);
 const denied=loginFixture({failure:null,allow:false});await denied.settle();await denied.submit();assert.equal(denied.signOuts,1);assert.match(denied.get('error').textContent,/does not have Team access/);assert.deepEqual(denied.navigation,[]);
});

function accessFixture({owner=true,admin=true}={}){
 let handler,reads=0;
 const client={auth:{getUser:async()=>{reads++;return{data:{user:{id:'fixture-user',email:owner?'owner@example.invalid':'someone@example.invalid'}},error:null};}},
  from(){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:admin?{user_id:'fixture-user'}:null,error:null})};return q;}};
 const source=fs.readFileSync(new URL('../supabase/functions/team-access/index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
 vm.runInContext(stripTypeScriptTypes(source),vm.createContext({Response,Set,JSON,String,Deno:{env:{get:n=>n==='IPFX_OWNER_EMAIL'?'owner@example.invalid':'fixture'},serve:h=>handler=h},createClient:()=>client}));
 return{run:(origin,method='OPTIONS',bearer=false)=>handler(new Request('https://fixture.test',{method,headers:{origin,...(bearer?{authorization:'Bearer synthetic-session'}:{})}})),get reads(){return reads;}};
}
test('access CORS matches exact localhost/live origins; other origins cannot reach owner check',async()=>{
 const f=accessFixture();for(const origin of ['http://localhost:8127','https://ipfxcapital.com']){const r=await f.run(origin);assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),origin);assert.equal(r.headers.get('vary'),'Origin');}
 const bad=await f.run('https://unapproved.example','POST',true);assert.equal(bad.status,403);assert.equal(f.reads,0);
 assert.equal((await f.run('http://localhost:8127','POST',false)).status,401);assert.equal(f.reads,0);
});
test('allowing localhost does not bypass owner identity or admin membership',async()=>{
 for(const opts of [{owner:false},{admin:false}]){const f=accessFixture(opts),r=await f.run('http://localhost:8127','POST',true);assert.equal((await r.json()).team_access,false);}
 const f=accessFixture(),r=await f.run('http://localhost:8127','POST',true);assert.equal((await r.json()).team_access,true);
});
