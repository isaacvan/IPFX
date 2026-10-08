-- Read-only account context for the owner Brain. Routing state is independent
-- of the participant's practice/challenge account type. No policy changes.
begin;
create index if not exists trades_account_opened_context on public.trades(account_id,opened_at desc);
create index if not exists pending_account_created_context on public.pending_orders(account_id,created_at desc);
create function public.ab_brain_account_context(p_people uuid[]) returns table(person_id uuid,accounts jsonb)
language sql stable security definer set search_path='' as $$
 select public.ab_person_of(a.user_id),jsonb_agg(jsonb_build_object(
  'id',a.id,'label',a.label,'phase',a.phase,'challenge_type',a.challenge_type,'stage',a.stage,'status',a.status,
  'balance',a.balance,'starting_balance',a.starting_balance,'access_revoked_at',a.access_revoked_at,
  'investigation_hold',a.investigation_hold,'breach_reason',a.breach_reason,'breached_at',a.breached_at,'created_at',a.created_at,
  'open_positions',(select count(*) from public.trades t where t.account_id=a.id and t.status='open'),
  'last_order_at',greatest((select max(t.opened_at) from public.trades t where t.account_id=a.id),
    (select max(p.created_at) from public.pending_orders p where p.account_id=a.id))) order by a.created_at desc,a.id)
 from public.trading_accounts a where public.ab_person_of(a.user_id)=any(p_people)
 group by public.ab_person_of(a.user_id);
$$;
revoke all on function public.ab_brain_account_context(uuid[]) from public,anon,authenticated;
grant execute on function public.ab_brain_account_context(uuid[]) to service_role;
commit;
