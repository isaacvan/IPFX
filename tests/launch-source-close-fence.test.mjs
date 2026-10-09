import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {fixture,account,user,root,slice}from './helpers/e8-db-fixture.mjs';
test('a persisted full close blocks a concurrent partial without changing source volume or crediting a slice',async()=>{
 const {db,open}=await fixture({atomic:true});try{
  await open();await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261009072000_source_close_intents.sql',import.meta.url),'utf8'));
  const claimed=(await db.query('select fn_request_ipfx_full_close($1,$2,$3,.02,$4)as r',[root,account,user,{reason:'manual',exit:1.101}])).rows[0].r;assert.equal(claimed.ok,true);
  const partial=(await db.query('select fn_commit_ipfx_partial($1,$2,$3,.02,1.1,.01,1.101,1,false,0,0,$4)as r',[root,account,user,slice])).rows[0].r;assert.equal(partial.reason,'FULL_CLOSE_IN_PROGRESS');
  assert.equal(Number((await db.query('select volume from trades where id=$1',[root])).rows[0].volume),.02);
  assert.equal((await db.query('select count(*)::int n from trades where id=$1',[slice])).rows[0].n,0);
  const closed=(await db.query('select fn_commit_ipfx_close($1,$2,$3,.02,1.1,1.101,2,\'manual\',false,0,0,null)as r',[root,account,user])).rows[0].r;assert.equal(closed.ok,true);assert.equal(Number(closed.balance),100002);
  const repeat=(await db.query('select fn_commit_ipfx_close($1,$2,$3,.02,1.1,1.101,2,\'manual\',false,0,0,null)as r',[root,account,user])).rows[0].r;assert.equal(repeat.ok,false);
 }finally{await db.close()}
});
