-- Tell traders whose Infinity run failed this month when they can start again (owner request 2026-10-13).
-- One email per trader, sent through the email outbox. New breaches get the same information in the normal
-- "account ended" email from the engine.
begin;
insert into public.email_templates (key, category, subject, preheader, body_html, body_text, is_active) values (
  'infinity_breach_notice', 'account',
  'Your Infinity Stage 1 restarts on {{restart_date}}',
  'Your failed run is closed. A fresh $1,000 Stage 1 starts automatically on {{restart_date}}.',
  '<p>Hi {{customer_name}},</p>
<p>Your Infinity run ended because a rule limit was reached. Your trades were closed and that account cannot place any more trades.</p>
<p><strong>A fresh $1,000 Stage 1 starts automatically on {{restart_date}}.</strong> You do not need to apply again, and we will email you when it is ready. Until then you can practise on IPFX Demo.</p>
<p>When your new run starts, remember:</p>
<ul>
<li>Put a stop-loss on every trade within 30 seconds.</li>
<li>Stay inside the daily loss limit (2.5%) and the trailing drawdown limit (5%): breaking either ends the run.</li>
<li>At most $14 of profit counts toward the target each day, and open trades close when you reach $14 in a day.</li>
</ul>
<p><a href="{{dashboard_url}}">Open your dashboard</a></p>
<p>The IPFX Capital team</p>',
  'Hi {{customer_name}},

Your Infinity run ended because a rule limit was reached. Your trades were closed and that account cannot place any more trades.

A fresh $1,000 Stage 1 starts automatically on {{restart_date}}. You do not need to apply again, and we will email you when it is ready. Until then you can practise on IPFX Demo.

When your new run starts, remember:
- Put a stop-loss on every trade within 30 seconds.
- Stay inside the daily loss limit (2.5%) and the trailing drawdown limit (5%): breaking either ends the run.
- At most $14 of profit counts toward the target each day, and open trades close when you reach $14 in a day.

Dashboard: {{dashboard_url}}

The IPFX Capital team',
  true
) on conflict (key) do nothing;

insert into public.email_events (user_id, template_key, to_email, subject, status, provider, payload)
select distinct on (a.user_id) a.user_id, 'infinity_breach_notice', u.email,
       'Your Infinity Stage 1 restarts on 1 November 2026', 'queued', 'resend',
       jsonb_build_object('vars', jsonb_build_object('restart_date', '1 November 2026', 'dashboard_url', 'https://ipfxcapital.com/dashboard.html'),
                          'account_id', a.id)
from public.trading_accounts a
join auth.users u on u.id = a.user_id
where a.challenge_type = 'infinity' and coalesce(a.phase, '') <> 'demo' and a.status = 'breached'
  and a.breached_at >= '2026-10-01' and a.breached_at < '2026-11-01' and u.email is not null
  and not exists (select 1 from public.email_events e where e.user_id = a.user_id and e.template_key = 'infinity_breach_notice')
order by a.user_id, a.breached_at desc;
commit;
