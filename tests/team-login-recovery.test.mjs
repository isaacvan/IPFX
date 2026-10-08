import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';

const OWNER='paulade491@gmail.com';
// The Team Login page opens only for the owner (owner request 2026-10-08): signed out goes to the normal login and comes
// back, any other account goes home, and the owner proceeds to the access check and authenticator code.
function loginFixture({failure='network',email=OWNER,allow=true}={}){
 const elements=new Map(),navigation=[],body={style:{visibility:'hidden'}};let signOuts=0,fetches=0;
 const get=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',disabled:false,style:{},on:false,classList:{toggle(_name,on){get(id).on=on;}},focus(){},addEventListener(name,fn){this[name]=fn;}});return elements.get(id);};
 const sdk={auth:{getSession:async()=>({data:{session:email?{access_token:'synthetic-session',user:{email}}:null}}),
  signOut:async()=>{signOuts++;},
  mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:'aal1'},error:null}),listFactors:async()=>({data:{totp:[{id:'fixture-factor',status:'verified'}]},error:null}),
   challengeAndVerify:async()=>({data:{},error:null})}}};
 const context=vm.createContext({window:{supabase:{createClient:()=>sdk}},document:{getElementById:get,body},location:{search:'?next=%2Fteam-e8-monitor.html',replace:u=>navigation.push(u)},
  URLSearchParams,AbortSignal,Error,String,encodeURIComponent,fetch:async()=>{fetches++;if(failure==='network')throw new TypeError('Failed to fetch');return new Response(JSON.stringify({team_access:allow}),{status:failure==='service'?503:200});}});
 const html=fs.readFileSync(new URL('../team-login.html',import.meta.url),'utf8'),source=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];vm.runInContext(source,context);
 return{get,navigation,body,setFailure:x=>failure=x,get signOuts(){return signOuts;},get fetches(){return fetches;},settle:()=>new Promise(r=>setImmediate(r)),retry:()=>get('retryButton').click()};
}
test('signed out visitors are sent to the normal login, return here afterwards and never see the page',async()=>{
 const f=loginFixture({email:null});await f.settle();
 assert.deepEqual(f.navigation,['/login.html?next='+encodeURIComponent('/team-login.html?next='+encodeURIComponent('/team-e8-monitor.html'))]);
 assert.equal(f.body.style.visibility,'hidden');assert.equal(f.fetches,0);
});
test('any account other than the owner is sent to the home page without the page being shown or any check being made',async()=>{
 for(const email of ['someone@example.com','paulade491@gmail.com.evil.test','isaac.vanenck@gmail.com']){
  const f=loginFixture({email});await f.settle();assert.deepEqual(f.navigation,['/']);assert.equal(f.body.style.visibility,'hidden');assert.equal(f.fetches,0);assert.equal(f.signOuts,0);}
});
test('the owner is recognised in any letter case and reaches the authenticator step after a failed check is retried',async()=>{
 const f=loginFixture({email:'PauladE491@Gmail.com'});await f.settle();
 assert.equal(f.body.style.visibility,'visible');assert.equal(f.get('retryStage').on,true);assert.equal(f.get('checkingStage').on,false);assert.match(f.get('error').textContent,/Could not reach/);assert.equal(f.signOuts,0);assert.deepEqual(f.navigation,[]);
 f.setFailure(null);f.retry();await f.settle();assert.equal(f.get('mfaStage').on,true);assert.deepEqual(f.navigation,[]);
 f.get('code').value='123456';await f.get('mfaForm').submit({preventDefault(){}});assert.deepEqual(f.navigation,['/team-e8-monitor.html']);
});
test('a temporary access-service failure does not masquerade as an owner denial',async()=>{
 const f=loginFixture({failure:'service'});await f.settle();assert.equal(f.get('retryStage').on,true);assert.equal(f.signOuts,0);assert.deepEqual(f.navigation,[]);assert.match(f.get('error').textContent,/temporarily unavailable/);
});
test('an owner session that the server does not recognise as team access is signed out and sent home',async()=>{
 const f=loginFixture({failure:null,allow:false});await f.settle();assert.equal(f.signOuts,1);assert.deepEqual(f.navigation,['/']);
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

test('the homepage shows Team Login (nav and footer) only after the owner has signed in, and the page has no password form of its own',()=>{
 const home=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),page=fs.readFileSync(new URL('../team-login.html',import.meta.url),'utf8');
 assert.match(home,/<a href="\/team-login\.html" id="navTeamLogin" hidden /);
 assert.equal((home.match(/<li hidden data-team-only><a href="\/?team-login\.html">Team Login<\/a><\/li>/g)||[]).length,2);
 assert.match(home,/session\.user\.email\|\|''\)\.trim\(\)\.toLowerCase\(\)==='paulade491@gmail\.com'/);
 assert.match(home,/document\.querySelectorAll\('\[data-team-only\]'\)\.forEach\(el=>\{el\.hidden=false;\}\)/);
 assert.doesNotMatch(home.replace(/<a href="\/team-login\.html" id="navTeamLogin" hidden[^>]*>Team Login<\/a>/,'').replace(/<li hidden data-team-only>.*?<\/li>/g,''),/team-login\.html/);
 assert.match(page,/<body style="visibility:hidden">/);
 assert.doesNotMatch(page,/signInWithPassword|id="password"|id="loginForm"/);
 const start=fs.readFileSync(new URL('../start-challenge.html',import.meta.url),'utf8');
 assert.match(start,/id="challengePreviewLogin" href="\/team-login\.html" style="display:none"/);
 assert.match(start,/if \(!response\.ok \|\| !access\?\.team_access\) return;\s+login\.style\.display = '';/);
});
