import test from 'node:test';
import assert from 'node:assert/strict';
import {launchReadiness} from '../supabase/functions/_shared/launch-readiness.ts';
const now=Date.parse('2026-10-11T12:00:00Z');
const base=()=>({settings:null,accounts:[],capacity:[],reference:{accounts:[],fills:0,fee_complete_fills:0},developerConfigured:false,signupSecretsConfigured:false,errors:[]});
const check=(r,id)=>r.checks.find(c=>c.id===id);
test('empty setup cannot imply connected monitoring, broker execution, zero costs or reconciled reserve',()=>{
 const r=launchReadiness(base(),now);
 assert.equal(check(r,'monitor').state,'action');assert.equal(check(r,'sampling').state,'action');
 assert.equal(check(r,'costs').state,'action');assert.equal(check(r,'reserve').state,'action');
 assert.equal(r.execution_enablement_changed,false);assert.equal(r.production_capacity_verified,false);
});
test('saved monitor is distinct from recent data, revoked sampling, stale data and execution proof',()=>{
 const i=base();i.accounts=[{id:1,role:'monitor',execution_enabled:false}];
 i.reference.accounts=[{id:1,enabled:false,last_quote_at:new Date(now-100).toISOString()}];
 assert.equal(check(launchReadiness(i,now),'monitor').state,'checked');assert.equal(check(launchReadiness(i,now),'sampling').state,'action');
 i.reference.accounts[0].enabled=true;assert.equal(check(launchReadiness(i,now),'sampling').state,'checked');
 i.reference.accounts[0].error_code='AUTH_EXPIRED';assert.equal(check(launchReadiness(i,now),'sampling').state,'action');
 delete i.reference.accounts[0].error_code;i.reference.accounts[0].last_quote_at=new Date(now-16000).toISOString();
 assert.equal(check(launchReadiness(i,now),'sampling').state,'action');
 i.reference.accounts[0].last_quote_at=new Date(now+100).toISOString();assert.equal(check(launchReadiness(i,now),'sampling').state,'action');
 assert.equal(check(launchReadiness(i,now),'execution').state,'action');
});
test('capacity is matched to each destination and developer configuration never implies broker approval',()=>{
 const i=base();i.accounts=[{id:1,role:'shadow',api_env:'demo',execution_enabled:false},{id:2,role:'monitor',api_env:'live',execution_enabled:false}];
 i.capacity=[{book:'l1',position_limit:200,margin_per_lot_usd:1000,provider_evidence:'Synthetic provider evidence'}];i.developerConfigured=true;
 assert.equal(check(launchReadiness(i,now),'capacity').state,'action');
 i.capacity[0].book='s1';const r=launchReadiness(i,now);assert.equal(check(r,'capacity').state,'checked');
 assert.match(check(r,'capacity').detail,/approval.*still need verification/);assert.equal(check(r,'execution').state,'action');
 i.developerConfigured=false;assert.equal(check(launchReadiness(i,now),'capacity').state,'action');
 i.capacity[0].position_limit=Infinity;assert.equal(check(launchReadiness(i,now),'capacity').state,'action');
});
test('partial cost evidence, zero fills and recorded cash never imply verified copied net or bank reconciliation',()=>{
 const i=base();i.settings={starting_reserve_usd:0};i.reference.fills=4;i.reference.fee_complete_fills=3;
 assert.equal(check(launchReadiness(i,now),'costs').state,'action');i.reference.fee_complete_fills=4;
 const r=launchReadiness(i,now);assert.equal(check(r,'costs').state,'checked');assert.match(check(r,'costs').detail,/does not verify/);
 assert.equal(check(r,'reserve').state,'action');assert.match(check(r,'reserve').detail,/not bank reconciliation/);
 i.signupSecretsConfigured=true;assert.equal(check(launchReadiness(i,now),'signup').state,'action');
});
test('unavailable diagnostics remain unknown and unrelated history cannot make a monitor fresh',()=>{
 const i=base();i.capacity=null;i.reference=null;i.errors=['Unavailable'];const r=launchReadiness(i,now);
 assert.equal(r.diagnostics_complete,false);for(const id of ['capacity','sampling','costs'])assert.equal(check(r,id).state,'unknown');
 i.reference={accounts:[{id:999,enabled:true,last_quote_at:new Date(now).toISOString()}]};i.accounts=[{id:1,role:'monitor',execution_enabled:false}];
 assert.equal(check(launchReadiness(i,now),'sampling').state,'action');
});
test('legacy A/B review demos are included without treating disconnected destinations as usable',()=>{
 const i=base();i.reviewDestinations=[{book:'a',status:'connected',environment:'demo'},{book:'b',status:'disconnected',environment:'demo'}];
 i.capacity=[{book:'a',position_limit:200,margin_per_lot_usd:1000,provider_evidence:'Synthetic documented evidence'}];i.developerConfigured=true;
 const r=launchReadiness(i,now);assert.equal(check(r,'demo').state,'checked');assert.match(check(r,'demo').detail,/1 demo/);assert.equal(check(r,'capacity').state,'checked');
 assert.equal(check(r,'execution').state,'action');
});
