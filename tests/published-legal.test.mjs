import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import crypto from'node:crypto';import{pathToFileURL}from'node:url';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const migration=read('supabase/migrations/20261008200041_published_legal_acceptance.sql');
test('published legal sources name only the authorised operator and match pinned immutable sources',()=>{
 for(const kind of['terms','privacy']){const html=read(kind+'.html');assert.match(html,/Paul Adeniji/);assert.doesNotMatch(html,/\[Registered|Unpublished review draft|IPFX Capital Ltd|E8|HeroFX/);
  assert.equal(html,read((kind==='terms'?'legal/2026-10-08-v1.6/':'legal/2026-10-08-v1.2/')+kind+'.html'));const hash=crypto.createHash('sha256').update(html).digest('hex');assert.ok((migration+read('supabase/migrations/20261008201552_legal_terms_glossary_alignment.sql')+read('supabase/migrations/20261008240000_legal_terms_v15_infinity.sql')+read('supabase/migrations/20261008250000_legal_terms_v16_privacy_v12.sql')).includes(hash));}
 assert.match(read('assets/js/checkout-flow.js'),/terms_version: '2026-10-08-1.6'/);assert.match(read('start-challenge.html'),/legal\/2026-10-08-v1.6\/terms.html/);
});
test('acceptances enforce signed-in user/current versions, reject stale/false consent, deduplicate and remain immutable',async()=>{
 const{PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js').href),db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.uid()returns uuid language sql as 'select nullif(current_setting(''test.actor_uid'',true),'''')::uuid';
 create function submit_challenge_application(p_challenge_type text,p_details jsonb,p_preset_id text)returns jsonb language plpgsql as $$
 declare v_uid uuid:=auth.uid();begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode='28000'; end if;
 return p_details;end;$$;`);
 await db.exec(migration);const context={challenge_type:'infinity',preset_id:'infinity_s1'},details={terms_version:'2026-10-08-1.3',privacy_notice_version:'2026-10-08-1.1',terms_accepted:true};
 await assert.rejects(db.query('select legal_acceptance_record($1,$2)',[details,context]),/NOT_SIGNED_IN/);
 await db.exec("select set_config('test.actor_uid','11111111-1111-4111-8111-111111111111',false)");
 await assert.rejects(db.query('select legal_acceptance_record($1,$2)',[{...details,terms_version:'2026-09'},context]),/LEGAL_VERSION_UPDATED/);
 await assert.rejects(db.query('select legal_acceptance_record($1,$2)',[{...details,terms_accepted:false},context]),/LEGAL_VERSION_UPDATED/);
 await db.query('select submit_challenge_application($1,$2,$3)',['infinity',details,'infinity_s1']);await db.query('select submit_challenge_application($1,$2,$3)',['infinity',details,'infinity_s1']);
 const rows=(await db.query('select * from platform_legal_acceptances')).rows;assert.equal(rows.length,1);assert.ok(rows[0].accepted_at);assert.equal(rows[0].user_id,'11111111-1111-4111-8111-111111111111');
 await assert.rejects(db.exec("update platform_legal_acceptances set accepted_at=now()"),/LEGAL_RECORD_IMMUTABLE/);
 await assert.rejects(db.exec("delete from platform_legal_documents"),/LEGAL_RECORD_IMMUTABLE/);
 await db.exec('set role authenticated');await assert.rejects(db.exec('select * from platform_legal_acceptances'),/permission denied/);
 }finally{await db.close();}
});
