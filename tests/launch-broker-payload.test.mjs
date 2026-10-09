import fs from 'node:fs';import vm from 'node:vm';import test from 'node:test';import assert from 'node:assert/strict';import {stripTypeScriptTypes}from 'node:module';import{marketOrder}from '../supabase/functions/_shared/tradelocker.ts';
const source=fs.readFileSync(new URL('../supabase/functions/book-executor/index.ts',import.meta.url),'utf8'),a=source.indexOf('const bookStrategy ='),b=source.indexOf('async function destination',a);
test('all demo and ladder strategy IDs fit the documented 31-character API limit',()=>{
 const ctx={Error};vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(source.slice(a,b))+'\nglobalThis.strategy=bookStrategy;',ctx);
 for(const book of ['a','b','s1','s10','l1','l70','l1000000']){const id=ctx.strategy(book,'11111111-1111-4111-8111-111111111111');assert.equal(id.length,31);assert.ok(id.startsWith('ipfx'+book+'_'));}
 assert.throws(()=>ctx.strategy('l123456789012345678','11111111-1111-4111-8111-111111111111'),/TOO_LONG/);
});
test('protective prices specify absolute stop/take-profit types; absent levels stay absent',()=>{
 const base={qty:.01,routeId:1,side:'buy',tradableInstrumentId:1,sourceTradeId:'11111111-1111-4111-8111-111111111111'};
 const order=marketOrder({...base,sl:1.1,tp:1.2});assert.equal(order.stopLossType,'absolute');assert.equal(order.takeProfitType,'absolute');
 const none=marketOrder(base);assert.equal('stopLossType'in none,false);assert.equal('takeProfitType'in none,false);
});
