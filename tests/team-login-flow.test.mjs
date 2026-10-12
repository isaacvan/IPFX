import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../team-login.html',import.meta.url),'utf8');
const source=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}){
 const elements=new Map(),navigation=[],removed=[],enrolled=[],verified=[],signOuts=[];
 let level=options.level||'aal1',allow=true,verifyError=null;
 const get=id=>{
  if(!elements.has(id))elements.set(id,{value:'',style:{},textContent:'',disabled:false,
   classList:{toggle(_class,on){get(id).on=on;}},focus(){},addEventListener(event,fn){this[event]=fn;}});
  return elements.get(id);
 };
 const session={access_token:'synthetic-token',user:{email:'paulade491@gmail.com'}};
 const sdk={auth:{getSession:async()=>({data:{session},error:options.sessionError||null}),
  signOut:async args=>{signOuts.push(args);return{error:null};},
  mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:level},error:null}),
   listFactors:async()=>({data:{all:options.factors||[],totp:(options.factors||[]).filter(f=>f.factor_type==='totp'&&f.status==='verified')},error:null}),
   unenroll:async({factorId})=>{removed.push(factorId);return{error:options.cleanupError||null};},
   enroll:async args=>{enrolled.push(args);return{data:{id:'new-factor',totp:{qr_code:options.qr||'<svg xmlns="http://www.w3.org/2000/svg"></svg>'}},error:options.enrollError||null};},
   challengeAndVerify:async args=>{verified.push(args);if(verifyError)return{data:null,error:verifyError};if(options.upgrade!==false)level='aal2';if(options.revokeOnVerify)allow=false;return{data:{},error:null};}
  }}};
 const body={style:{visibility:'hidden'}};
 const context=vm.createContext({window:options.noSdk?{}:{supabase:{createClient:()=>sdk}},
  document:{body,getElementById:get},location:{search:options.search||'?next=%2Fteam-brain.html',replace:url=>navigation.push(url)},
  URLSearchParams,AbortSignal,Error,String,encodeURIComponent,
  fetch:async()=>{if(options.fetchGate)await options.fetchGate;return new Response(JSON.stringify({team_access:allow}));}});
 vm.runInContext(source,context);
 return{get,navigation,removed,enrolled,verified,signOuts,body,tick,
  setVerifyError(error){verifyError=error;},
  async submit(id,code){get(id==='mfaForm'?'code':'enrollCode').value=code;await get(id).submit({preventDefault(){}});},
  retry:()=>get('retryButton').click()};
}

test('first setup displays an SVG QR and only opens the requested Team page after session upgrade',async()=>{
 const f=fixture();await f.tick();
 assert.equal(f.get('enrollStage').on,true);assert.equal(f.enrolled.length,1);assert.deepEqual(f.navigation,[]);
 assert.match(f.get('qr').src,/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
 await f.submit('enrollForm','123456');assert.deepEqual(f.navigation,['/team-brain.html']);
 assert.equal(f.verified[0].factorId,'new-factor');
});

test('SDK data-URL QR remains usable without double encoding',async()=>{
 const qr='data:image/svg+xml;utf-8,%3Csvg%3E%3C%2Fsvg%3E',f=fixture({qr});await f.tick();assert.equal(f.get('qr').src,qr);
});

test('a refresh replaces only abandoned IPFX Team setup and leaves other factors alone',async()=>{
 const f=fixture({factors:[
  {id:'abandoned',factor_type:'totp',status:'unverified',friendly_name:'IPFX Team'},
  {id:'other',factor_type:'totp',status:'unverified',friendly_name:'Another app'},
  {id:'phone',factor_type:'phone',status:'verified',friendly_name:'IPFX Team'}
 ]});await f.tick();assert.deepEqual(f.removed,['abandoned']);assert.equal(f.enrolled.length,1);assert.equal(f.get('enrollStage').on,true);
});

test('an existing verified authenticator always takes precedence over pending enrollment',async()=>{
 const f=fixture({factors:[
  {id:'active',factor_type:'totp',status:'verified',friendly_name:'Personal'},
  {id:'abandoned',factor_type:'totp',status:'unverified',friendly_name:'IPFX Team'}
 ]});await f.tick();assert.equal(f.get('mfaStage').on,true);assert.equal(f.enrolled.length,0);assert.deepEqual(f.removed,[]);
 await f.submit('mfaForm','123456');assert.equal(f.verified[0].factorId,'active');assert.deepEqual(f.navigation,['/team-brain.html']);
});

test('failed setup cleanup stops enrollment and remains recoverable',async()=>{
 const f=fixture({cleanupError:{message:'Setup service unavailable'},factors:[{id:'abandoned',factor_type:'totp',status:'unverified',friendly_name:'IPFX Team'}]});
 await f.tick();assert.equal(f.get('retryStage').on,true);assert.equal(f.enrolled.length,0);assert.deepEqual(f.navigation,[]);assert.equal(f.get('retryButton').disabled,false);
});

test('invalid code does not open Team and the next code can succeed',async()=>{
 const f=fixture();await f.tick();f.setVerifyError({message:'Invalid TOTP code entered'});
 await f.submit('enrollForm','123456');assert.deepEqual(f.navigation,[]);assert.equal(f.get('enrollButton').disabled,false);
 assert.match(f.get('error').textContent,/newest code/);f.setVerifyError(null);
 await f.submit('enrollForm','654321');assert.deepEqual(f.navigation,['/team-brain.html']);
});

test('malformed code never reaches the verification API',async()=>{
 const f=fixture();await f.tick();await f.submit('enrollForm','12345x');assert.equal(f.verified.length,0);assert.deepEqual(f.navigation,[]);
});

test('verification network errors are not blamed on the authenticator code',async()=>{
 const f=fixture();await f.tick();f.setVerifyError({message:'Failed to fetch'});await f.submit('enrollForm','123456');
 assert.match(f.get('error').textContent,/Could not reach/);assert.doesNotMatch(f.get('error').textContent,/newest code/);assert.deepEqual(f.navigation,[]);
});

test('verification success without an AAL2 session cannot open Team',async()=>{
 const f=fixture({upgrade:false});await f.tick();await f.submit('enrollForm','123456');assert.deepEqual(f.navigation,[]);assert.equal(f.get('enrollButton').disabled,false);
});

test('owner membership is checked again after verification, and denial only signs out this browser',async()=>{
 const f=fixture({revokeOnVerify:true});await f.tick();await f.submit('enrollForm','123456');
 assert.deepEqual(f.navigation,['/']);assert.equal(f.signOuts.length,1);assert.equal(f.signOuts[0].scope,'local');
});

test('already verified owner session opens Team without adding or removing factors',async()=>{
 const f=fixture({level:'aal2'});await f.tick();assert.deepEqual(f.navigation,['/team-brain.html']);assert.equal(f.enrolled.length,0);assert.deepEqual(f.removed,[]);
});

test('repeated access retries cannot race or create two setup factors',async()=>{
 let release;const f=fixture({fetchGate:new Promise(resolve=>release=resolve)});await f.tick();
 f.retry();f.retry();release();await f.tick();assert.equal(f.enrolled.length,1);assert.equal(f.get('retryButton').disabled,false);
});

test('failed CDN load shows a visible recovery message instead of a blank page',async()=>{
 const f=fixture({noSdk:true});await f.tick();assert.equal(f.body.style.visibility,'visible');assert.equal(f.get('retryStage').on,true);
 assert.match(f.get('error').textContent,/Refresh this page/);assert.deepEqual(f.navigation,[]);
});

test('session read errors remain retryable without signing the owner out',async()=>{
 const f=fixture({sessionError:{message:'Network unavailable'}});await f.tick();assert.equal(f.get('retryStage').on,true);assert.deepEqual(f.navigation,[]);assert.equal(f.signOuts.length,0);
});

test('Team destinations reject external URLs and preserve allowed nested query strings',async()=>{
 for(const next of ['https://evil.example','//evil.example','/\\evil.example','/team-brain.html/../login.html']){
  const f=fixture({level:'aal2',search:'?next='+encodeURIComponent(next)});await f.tick();assert.deepEqual(f.navigation,['/trader-analytics.html']);
 }
 const next='/team-brain.html?view=alerts#current',f=fixture({level:'aal2',search:'?next='+encodeURIComponent(next)});await f.tick();assert.deepEqual(f.navigation,[next]);
});

test('normal login return destination rejects browser-normalized external redirects',()=>{
 const page=fs.readFileSync(new URL('../login.html',import.meta.url),'utf8');
 const snippet=page.match(/const safeNext = ([\s\S]*?);/)[0];
 for(const next of ['/team-login.html?next=%2Fteam-brain.html','/dashboard.html','//evil.example','/\\evil.example','/\n/evil.example','/\t/evil.example','https://evil.example']){
  const safe=vm.runInNewContext(snippet+'safeNext',{requestedNext:next});
  assert.equal(new URL(safe,'https://ipfxcapital.com').origin,'https://ipfxcapital.com');
  if(next.startsWith('/team-login'))assert.equal(safe,next);
 }
});
