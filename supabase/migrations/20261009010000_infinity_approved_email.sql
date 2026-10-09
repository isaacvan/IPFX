-- Email sent when an Infinity application is approved and the Stage 1 account has been issued.
-- Sent by admin-console (application_decide) through the same lifecycle email path as the other account emails.
-- Until an email provider key is configured the message is recorded in email_events as "queued", so nothing is lost.
insert into public.email_templates (key, category, subject, preheader, body_html, body_text, is_active) values (
  'infinity_approved', 'account',
  'Your Infinity Challenge has been approved. Start trading now',
  'Your free $1,000 Stage 1 account is ready on IPFX Markets.',
  '<p>Hi {{customer_name}},</p>
<p><strong>Good news: your Infinity Challenge application has been approved and your identity is verified.</strong> Your free $1,000 Stage 1 account is ready and you can trade now.</p>
<p><a href="{{trading_url}}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">Start trading on IPFX Markets</a></p>
<p>Before your first trade:</p>
<ul>
<li>Put a stop-loss on every trade within 30 seconds. A trade without one is closed and counts as a strike, and three strikes end your run.</li>
<li>Stage 1 target: 4% ($40), with at least 14 days, 10 trading days, 30 exposure sessions and 30 qualifying trades.</li>
<li>Staying inside the daily loss limit (2.5%) and the trailing drawdown limit (5%) is essential: breaching either fails the account straight away.</li>
<li>You can follow your progress on your dashboard: <a href="{{dashboard_url}}">{{dashboard_url}}</a>.</li>
</ul>
<p>Good luck,<br>The IPFX Capital team</p>',
  'Hi {{customer_name}},

Good news: your Infinity Challenge application has been approved and your identity is verified. Your free $1,000 Stage 1 account is ready and you can trade now.

Start trading on IPFX Markets: {{trading_url}}

Before your first trade:
- Put a stop-loss on every trade within 30 seconds. A trade without one is closed and counts as a strike, and three strikes end your run.
- Stage 1 target: 4% ($40), with at least 14 days, 10 trading days, 30 exposure sessions and 30 qualifying trades.
- Staying inside the daily loss limit (2.5%) and the trailing drawdown limit (5%) is essential: breaching either fails the account straight away.
- Follow your progress on your dashboard: {{dashboard_url}}

Good luck,
The IPFX Capital team',
  true
) on conflict (key) do nothing;
