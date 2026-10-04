-- Brain control room: everything about one person in one call (owner page drawer). Read-only.
create or replace function public.ab_brain_person(p_person uuid)
returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object(
    'profile', (select to_jsonb(p) from public.ab_trader_profiles p where p.person_id = p_person),
    'metrics', (select to_jsonb(m) from public.ab_trader_metrics m where m.person_id = p_person),
    'name', (select full_name from public.user_profiles where user_id = p_person),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'label', a.label, 'challenge_type', a.challenge_type, 'stage', a.stage, 'status', a.status,
        'starting_balance', a.starting_balance, 'balance', a.balance, 'breach_reason', a.breach_reason, 'breached_at', a.breached_at,
        'investigation_hold', a.investigation_hold, 'access_revoked_at', a.access_revoked_at, 'created_at', a.created_at)
        order by a.created_at desc)
      from public.trading_accounts a where public.ab_person_of(a.user_id) = p_person), '[]'::jsonb),
    'trades', coalesce((select jsonb_agg(t order by t.closed_at desc) from (
        select l.trade_id, l.symbol, l.side, l.volume, l.opened_at, l.closed_at, l.hold_seconds, l.trader_pnl_usd, l.trader_r,
               l.risk_basis, l.replay_basis, l.same_r, l.reverse_r, l.stop_loss
        from public.ab_trade_ledger l where l.person_id = p_person order by l.closed_at desc limit 100) t), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('from', e.from_state, 'to', e.to_state, 'reason', e.reason, 'at', e.created_at,
        'policy', e.policy_version, 'actor', e.actor) order by e.created_at desc)
      from public.ab_lifecycle_events e where e.person_id = p_person), '[]'::jsonb),
    'alerts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'severity', a.severity, 'title', a.title, 'detail', a.detail,
        'first_seen', a.first_seen, 'resolved_at', a.resolved_at) order by a.last_seen desc)
      from public.ab_alerts a where a.person_id = p_person and (a.resolved_at is null or a.resolved_at > now() - interval '7 days')), '[]'::jsonb),
    'flags', coalesce((select jsonb_agg(jsonb_build_object('reason', f.reason, 'status', f.status, 'at', f.created_at) order by f.created_at desc)
      from public.trade_safety_flags f where public.ab_person_of(f.user_id) = p_person), '[]'::jsonb),
    'book_orders', coalesce((select jsonb_agg(o order by o.created_at desc) from (
        select o.book, o.event, o.symbol, o.side, o.qty, o.status, o.fill_price, o.pnl_usd, o.error, o.created_at
        from public.book_orders o where o.person_id = p_person order by o.created_at desc limit 50) o), '[]'::jsonb),
    'skips', coalesce((select jsonb_agg(jsonb_build_object('book', s.book, 'reason', s.reason, 'at', s.created_at) order by s.created_at desc)
      from (select * from public.ab_copy_skips where person_id = p_person order by created_at desc limit 30) s), '[]'::jsonb)
  );
$$;
revoke all on function public.ab_brain_person(uuid) from public, anon, authenticated;
grant execute on function public.ab_brain_person(uuid) to service_role;
