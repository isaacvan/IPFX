import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Risk}from '../hub/risk.mjs';import {riskJournal}from '../hub/risk-journal.mjs';
const id='00000000-0000-4000-8000-000000000001';
const account={id,status:'demo',challenge_type:'demo',revoked:false};const snap=()=>({accounts:[account],trades:[],pending:[]});
const good=()=>({ok:true,results:[{id,open:0,status:'demo'}]});
function fixture(engine,journal){const r=new Risk({quotes:new Map(),mode:'active',log(){},engine,rpc:async()=>snap(),journal});r.accounts.set(id,account);r.specs={EURUSD:{contract:100000,quote:'USD'}};r.lastFull=Date.now();return r;}
test('failed calls and per-account errors retry without another quote and never count as checked',async()=>{
 let calls=0;const r=fixture(async()=>{calls++;if(calls===1)throw Error('Synthetic outage');if(calls===2)return {ok:true,results:[{id,error:'Synthetic account failure'}]};return good()});
 r.flag(id,'stop_loss');await r.flush();assert.equal(r.queue.size,1);assert.equal(r.summary().healthy,false);assert.equal(r.stats.checkedAccounts,0);
 r.jobs.get(id).dueAt=0;await r.flush();assert.equal(r.queue.size,1);assert.equal(r.stats.checkedAccounts,0);
 r.jobs.get(id).dueAt=0;await r.flush();assert.equal(r.queue.size,0);assert.equal(r.stats.checkedAccounts,1);assert.equal(r.summary().healthy,true);
});
test('an uncertain risk job survives restart and clears only after a confirmed check',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ipfx-risk-fixture-')),file=path.join(dir,'queue.json');
 try{
  const r=fixture(async()=>{throw Error('Synthetic lost reply')},riskJournal(file));const errors=[];r.log=(...v)=>errors.push(v);r.flag(id,'loss_limit');await r.flush();assert.ok(fs.existsSync(file),JSON.stringify(errors));
  const restored=fixture(async()=>good(),riskJournal(file));assert.equal(restored.queue.size,1);await restored.flush();assert.equal(restored.queue.size,0);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),[]);
 }finally{if(fs.existsSync(file))fs.unlinkSync(file);if(fs.existsSync(file+'.tmp'))fs.unlinkSync(file+'.tmp');fs.rmdirSync(dir)}
});
