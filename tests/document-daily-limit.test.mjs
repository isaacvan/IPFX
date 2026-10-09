import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import test from 'node:test';import {stripTypeScriptTypes}from 'node:module';
const source=fs.readFileSync(new URL('../supabase/functions/admin-console/index.ts',import.meta.url),'utf8'),a=source.indexOf('  if (action === "kyc_document_url")'),b=source.indexOf('  if (action === "kyc_queue")',a);
const code=stripTypeScriptTypes('globalThis.run=async function(){'+source.slice(a,b)+'}');
test('more than forty document links work in one hour; the three-hundred-and-fifty-per-day limit remains',async()=>{
 const id='11111111-1111-4111-8111-111111111111',calls=[],signed=[];let daily=0,audits=0,auditOk=true;
 const doc={id,user_id:'synthetic-user',doc_type:'id_front',storage_path:'synthetic-only/no-real-document.pdf'};
 const context={action:'kyc_document_url',body:{document_id:id},user:{id:'synthetic-owner'},UUID:/^[0-9a-f-]{36}$/,req:{headers:{get:()=>null}},String,
 db:{
   from:()=>({select(){return this},eq(){return this},maybeSingle:async()=>({data:doc,error:null})}),
   storage:{from:()=>({createSignedUrl:async(path,ttl)=>{signed.push({path,ttl});return {data:{signedUrl:'https://fixture.invalid/not-a-real-file'},error:null}}})}
 },
 allowRequest:async(_,key,__,cap,seconds)=>{calls.push({key,cap,seconds});assert.equal(key,'admin:kyc_document_day');daily++;return daily<=cap},logAdminStrict:async()=>{audits++;return auditOk},json:x=>x,err:(error,status)=>({error,status})};
 vm.createContext(context);vm.runInContext(code,context);
 for(let i=0;i<350;i++){const result=await context.run();assert.equal(result.ok,true)}
 assert.equal(signed.length,350);assert.equal(audits,350);assert.ok(signed.every(x=>x.ttl===60));assert.ok(calls.every(x=>x.cap===350&&x.seconds===86400));
 assert.equal((await context.run()).status,429);assert.equal(signed.length,350);
 daily=0;auditOk=false;assert.equal((await context.run()).status,503);assert.equal(signed.length,350,'no signed link without a successful audit');
});
