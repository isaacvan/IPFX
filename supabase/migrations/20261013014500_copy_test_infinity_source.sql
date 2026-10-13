-- Source correction only: owner must still prepare/start; no session/account is enabled.
-- Strict anchors preserve the remaining installed scoped-test logic.
do $patch$
declare fn text;src text;old text;new text;
begin
 for fn,old,new in select * from (values
 ('copy_test_find_user(text)',
  'a.status=''demo'' and a.challenge_type=''demo''',
  'a.status=''active'' and a.challenge_type=''infinity'' and coalesce(a.phase,'''')<>''demo'''),
 ('copy_test_prepare(uuid,uuid,bigint,numeric,uuid,text)',
  'a.challenge_type<>''demo'' or a.status<>''demo''',
  'a.challenge_type is distinct from ''infinity'' or a.status is distinct from ''active'' or coalesce(a.phase,'''')=''demo'''),
 ('copy_test_prepare(uuid,uuid,bigint,numeric,uuid,text)',
  'SELECT_OWN_IPFX_PRACTICE_ACCOUNT', 'SELECT_OWN_ACTIVE_INFINITY_ACCOUNT'),
 ('copy_test_route(uuid,uuid,text)',
  'a.status=''demo'' and a.challenge_type=''demo''',
  'a.status=''active'' and a.challenge_type=''infinity'' and coalesce(a.phase,'''')<>''demo'' and coalesce(a.venue,''ipfx'')=''ipfx'' and public.ab_person_of(a.user_id)=s.person_id'),
 ('copy_test_claim(uuid)',
  'a.status=''demo'' and a.challenge_type=''demo''',
  'a.status=''active'' and a.challenge_type=''infinity'' and coalesce(a.phase,'''')<>''demo'' and public.ab_person_of(a.user_id)=who'),
 ('copy_test_claim(uuid)', 'SOURCE_NOT_PRACTICE_DEMO', 'SOURCE_NOT_ACTIVE_INFINITY'),
 ('copy_test_control(bigint,text,integer,uuid,boolean)',
  'if s.state<>''prepared''',
  'if not exists(select 1 from public.trading_accounts a where a.id=s.source_account_id and public.ab_person_of(a.user_id)=s.person_id and a.challenge_type=''infinity'' and a.status=''active'' and coalesce(a.phase,'''')<>''demo'' and coalesce(a.venue,''ipfx'')=''ipfx'')then raise exception ''SELECT_OWN_ACTIVE_INFINITY_ACCOUNT'';end if;
  if s.state<>''prepared''')
 )as changes(signature,anchor,replacement) loop
  src:=pg_get_functiondef(('public.'||fn)::regprocedure);
  if strpos(src,old)=0 or array_length(string_to_array(src,old),1)<>2 then raise exception 'COPY_TEST_SOURCE_DRIFT: %',fn;end if;
  execute replace(src,old,new);
 end loop;
end $patch$;
-- Show challenge/stage metadata to distinguish the selected source from practice Demo.
create or replace function public.copy_test_find_user(p_email text)returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('person_id',public.ab_person_of(u.id),'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'label',a.label,'challenge_type',a.challenge_type,'phase',a.phase,'stage',a.stage))from public.trading_accounts a where a.user_id=u.id and a.status='active' and a.challenge_type='infinity' and coalesce(a.phase,'')<>'demo' and coalesce(a.venue,'ipfx')='ipfx'),'[]'::jsonb))
 from auth.users u where lower(u.email)=lower(trim(p_email));
$$;
revoke all on function public.copy_test_find_user(text) from public,anon,authenticated;
grant execute on function public.copy_test_find_user(text) to service_role;
