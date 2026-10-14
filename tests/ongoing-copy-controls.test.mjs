import test from'node:test';import assert from'node:assert/strict';import{ongoingCopyControl}from'../supabase/functions/_shared/ongoing-copy-controls.ts';
const owner='11111111-1111-4111-8111-111111111111',person='22222222-2222-4222-8222-222222222222';
test('funded ON requires explicit confirmation and binds actor/developer flags on the server, never client input',async()=>{
 const calls=[],db={rpc:async(name,args)=>{calls.push({name,args});return {data:{ok:true},error:null}}};
 assert.equal((await ongoingCopyControl(db,{action:'ongoing_copy_on',id:1,version:1},owner,true)).status,400);assert.equal(calls.length,0);
 assert.equal((await ongoingCopyControl(db,{action:'ongoing_copy_on',id:1,version:1,confirm_funded_execution:true,p_actor:person,developer:true},owner,false)).status,200);
 assert.equal(calls[0].args.p_actor,owner);assert.equal(calls[0].args.p_developer,false);
});
test('connecting and selecting have bounded validated inputs and never invoke ON or broker requests',async()=>{
 const calls=[],db={rpc:async(name,args)=>{calls.push({name,args});return {data:{ok:true},error:null}}};
 const b={action:'ongoing_copy_connect',id:3,lots:.01,risk_usd:10,confirm_owned_and_permitted:true,reason:'Synthetic owner permission'};
 for(const change of[{id:0},{lots:NaN},{lots:2},{risk_usd:101},{confirm_owned_and_permitted:false},{reason:'bad'}])assert.equal((await ongoingCopyControl(db,{...b,...change},owner,true)).status,400);
 await ongoingCopyControl(db,b,owner,true);assert.equal(calls[0].name,'ongoing_copy_connect');assert.equal(calls[0].args.p_actor,owner);assert.equal(calls.length,1);
 await ongoingCopyControl(db,{action:'ongoing_copy_select',id:1,person_id:person,enabled:true,reason:'Synthetic chosen person'},owner,true);assert.equal(calls[1].name,'ongoing_copy_select');assert.equal(calls[1].args.p_confirm,false);
});

test('one-action start requires a human start indication and binds actor and developer capability on the server',async()=>{const calls=[],db={rpc:async(name,args)=>{calls.push({name,args});return{data:{ok:true}}}};const b={action:'ongoing_copy_start_trader',id:1,person_id:person,version:2,reason:'Synthetic explicit live start'};assert.equal((await ongoingCopyControl(db,b,owner,false)).status,400);assert.equal(calls.length,0);await ongoingCopyControl(db,{...b,confirm_funded_execution:true,p_actor:person,developer:true},owner,false);assert.equal(calls[0].name,'ongoing_copy_start_trader');assert.equal(calls[0].args.p_actor,owner);assert.equal(calls[0].args.p_developer,false);assert.equal(calls[0].args.p_confirm,true);});


test('owner status returns saved capacity only for this owner connection, with no mutation',async()=>{
 const calls=[];const db={rpc:async(name)=>{calls.push(name);return{data:{connections:[{id:1,account_id:3}]}}},from:table=>({select:()=>table==='ladder_accounts'?{in:async()=>({data:[]})}:Promise.resolve({data:[{book:'l3',position_limit:100,margin_per_lot_usd:1000,provider_evidence:'Synthetic broker specification'},{book:'l99',position_limit:5}]})})};
 const r=await ongoingCopyControl(db,{action:'ongoing_copy_status'},owner,false);assert.equal(r.status,200);assert.equal(r.body.capacity.length,1);assert.equal(r.body.capacity[0].book,'l3');assert.deepEqual(calls,['ongoing_copy_summary']);
});

test('capacity status read failure does not return incomplete current execution status',async()=>{
 const db={rpc:async()=>({data:{connections:[]}}),from:table=>({select:()=>table==='ladder_accounts'?{in:async()=>({data:[]})}:Promise.resolve({error:{message:'Synthetic outage'}})})};assert.equal((await ongoingCopyControl(db,{action:'ongoing_copy_status'},owner,false)).status,503);
});
