import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{pathToFileURL}from'node:url';
const user='22222222-2222-4222-8222-222222222222',file=user+'/id.jpg';
test('photo ID alone is accepted; foreign paths, missing photo ID and expired ID remain rejected',async()=>{
 const{PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js').href),db=new PGlite();try{
 await db.exec(`create schema auth;create function auth.uid()returns uuid language sql as $$select '${user}'::uuid$$;
 create schema storage;create table storage.objects(bucket_id text,name text);insert into storage.objects values('kyc-documents','${file}');
 create table trader_kyc(user_id uuid,status text);create table kyc_submissions(user_id uuid,doc_type text,storage_path text);
 create function submit_kyc(p_documents jsonb)returns text language plpgsql as $$declare v_uid uuid:=auth.uid();d jsonb;v_types text[]:='{}';begin
 if jsonb_typeof(p_documents)<>'array' then raise exception 'DOCUMENTS_REQUIRED';end if;
 for d in select * from jsonb_array_elements(p_documents) loop
 if split_part(coalesce(d->>'path',''),'/',1)<>v_uid::text then raise exception 'KYC_BAD_PATH';end if;
 if not exists(select 1 from storage.objects where bucket_id='kyc-documents'and name=d->>'path')then raise exception 'OBJECT_NOT_FOUND';end if;
 v_types:=array_append(v_types,d->>'doc_type');end loop;
 if not ('id_front' = any(v_types) and 'proof_of_address' = any(v_types)) then raise exception 'KYC_DOCUMENTS_REQUIRED';end if;
 insert into kyc_submissions select v_uid,e->>'doc_type',e->>'path'from jsonb_array_elements(p_documents)e;insert into trader_kyc values(v_uid,'pending');return 'pending';end;$$;
 create function submit_challenge_application(p_challenge_type text,p_details jsonb,p_preset_id text)returns jsonb language plpgsql as $$
 declare v_uid uuid:=auth.uid();v_id_expiry date;v_address_date date;begin
 if not exists(select 1 from trader_kyc where user_id=v_uid and status in('pending','verified'))
 or not exists(select 1 from public.kyc_submissions where user_id=v_uid and doc_type='id_front')
 or not exists(select 1 from public.kyc_submissions where user_id=v_uid and doc_type='proof_of_address')then raise exception 'KYC_DOCUMENTS_REQUIRED';end if;
 v_id_expiry:=(p_details->>'id_expiry_date')::date;
 v_address_date:=(p_details->>'proof_of_address_date')::date;
 if v_id_expiry<current_date or v_address_date>current_date
     or v_address_date<current_date-interval '3 months' then raise exception 'DOCUMENT_DATES_INVALID';end if;
 return jsonb_build_object('accepted',true);end;$$;`);
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261009003500_photo_id_without_address_document.sql',import.meta.url),'utf8'));
 await assert.rejects(db.query('select submit_kyc($1)',[[{doc_type:'id_front',path:'someone-else/id.jpg'}]]),/BAD_PATH/);
 await assert.rejects(db.query('select submit_kyc($1)',[[{doc_type:'id_back',path:file}]]),/DOCUMENTS_REQUIRED/);
 assert.equal((await db.query('select submit_kyc($1)r',[[{doc_type:'id_front',storage_path:file}]])).rows[0].r,'pending');
 assert.equal((await db.query("select submit_challenge_application('infinity',$1,'infinity_s1')r",[{id_expiry_date:'2099-01-01'}])).rows[0].r.accepted,true);
 for(const d of [{},{id_expiry_date:'2000-01-01'}])await assert.rejects(db.query("select submit_challenge_application('infinity',$1,'infinity_s1')",[d]),/DOCUMENT_DATES_INVALID/);
 }finally{await db.close();}
});
