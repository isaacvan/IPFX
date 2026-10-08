-- Seamless stage progression + a plain-English "exposure session" answer (owner request 2026-10-08).
--
-- 1. fn_pass_candidates(): evaluation accounts that have reached their profit target, have no open trades and have
--    not yet been promoted. The background sweep only visited accounts WITH open trades, so a flat trader who
--    qualified purely by time passing (e.g. the 14th day arriving) waited until they next opened the platform.
--    The sweep now also visits these accounts every 10 seconds; the engine's own pass gate still decides, so this
--    only makes the promotion happen on time, never earlier than the rules allow.
-- 2. The chatbot gets a clear "What is an exposure session?" answer and the stage answers point to it.
create or replace function public.fn_pass_candidates()
returns table (account_id uuid)
language sql stable security definer set search_path to '' as $$
  select a.id
  from public.trading_accounts a
  where a.status = 'active' and a.phase = 'evaluation' and a.access_revoked_at is null
    and coalesce(a.profit_target_pct, 0) > 0
    and a.balance >= round(a.starting_balance * (1 + a.profit_target_pct / 100), 2)
    and not exists (select 1 from public.trades t where t.account_id = a.id and t.status = 'open')
    and not exists (select 1 from public.trading_accounts n where n.funded_from_account_id = a.id)
  limit 200;
$$;
revoke all on function public.fn_pass_candidates() from public, anon, authenticated;
grant execute on function public.fn_pass_candidates() to service_role;

insert into public.support_kb (id, topic, title, keywords, answer, follow_ups, is_active)
values (
  'exposure-sessions', 'infinity', 'What is an exposure session?',
  array['exposure session', 'exposure sessions', 'session', 'sessions', 'trading session', 'independent sessions', 'split tickets', 'how are sessions counted'],
  E'An **exposure session** is one burst of trading.\n\n- Trades that are **open at the same time** count as the **same** session.\n- A trade you open **within 60 minutes of closing everything** also counts as the same session.\n- A **new** session starts when you open a trade after being **flat for more than 60 minutes**.\n\n**Example:** you buy EURUSD at 09:00, add a second ticket at 09:10 and close both at 09:40. At 10:20 you open a GBPUSD trade and close it at 10:30. That is still **one** session. At 11:45 you open another trade: you have been flat for 75 minutes, so that is a **second** session.\n\nIt exists so nobody can reach the minimum by splitting one idea into lots of small tickets. Stage 1 needs 30 sessions, Stage 2 needs 60 and Stage 3 needs 40, as well as the minimum trading days. Trades closed for having no stop-loss do not count. You can follow your count in the Challenge progress panel on IPFX Markets.',
  array['What do I need to pass Stage 1?', 'How do Infinity payouts work?'], true)
on conflict (id) do update set topic = excluded.topic, title = excluded.title, keywords = excluded.keywords,
  answer = excluded.answer, follow_ups = excluded.follow_ups, is_active = true, updated_at = now()
where public.support_kb.edited_by_owner is not true;

update public.support_kb
set answer = replace(answer, 'independent exposure sessions', 'exposure sessions (separate bursts of trading: ask "What is an exposure session?")'),
    updated_at = now()
where id in ('infinity-stage1', 'infinity-stage2', 'infinity-stage3', 'infinity-overview')
  and answer like '%independent exposure sessions%' and edited_by_owner is not true;
