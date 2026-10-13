import test from'node:test';import assert from'node:assert/strict';import{brokerCapacitySnapshot}from'../supabase/functions/_shared/tradelocker.ts';
test('same accNum on different logins cannot reuse the wrong broker schema; concurrent reads share one config fetch',async()=>{
 const beforeFetch=globalThis.fetch,beforeDeno=globalThis.Deno;const configs=new Map();globalThis.Deno={env:{get:()=>undefined}};
 globalThis.fetch=async(url,init)=>{
  assert.equal(init.method,'GET');const identity=init.headers.Authorization;let d;
  if(String(url).endsWith('/trade/config')){configs.set(identity,(configs.get(identity)||0)+1);await Promise.resolve();const names=identity.endsWith('SYNTHETIC_B')?['freeMargin','balance']:['balance','freeMargin'];d={accountDetailsConfig:{columns:names.map(id=>({id}))},positionsConfig:{columns:[{id:'id'}]},ordersConfig:{columns:[{id:'id'}]}};}
  else if(String(url).endsWith('/state'))d={accountDetailsData:identity.endsWith('SYNTHETIC_B')?[222,50000]:[50000,111]};
  else if(String(url).endsWith('/positions'))d={positions:[['900']]};else if(String(url).endsWith('/orders'))d={orders:[]};else throw Error('Unexpected fixture request');
  return new Response(JSON.stringify({d}),{status:200});
 };
 try{const a=await brokerCapacitySnapshot('SYNTHETIC_A','account-a','1'),b=await brokerCapacitySnapshot('SYNTHETIC_B','account-b','1');assert.equal(a.free_margin_usd,111);assert.equal(b.free_margin_usd,222);
 const parallel=await Promise.all(Array.from({length:50},()=>brokerCapacitySnapshot('SYNTHETIC_C','account-c','1')));assert.equal(parallel.length,50);assert.equal(configs.get('Bearer SYNTHETIC_C'),1);assert.equal(configs.size,3);
 }finally{globalThis.fetch=beforeFetch;globalThis.Deno=beforeDeno;}
});
