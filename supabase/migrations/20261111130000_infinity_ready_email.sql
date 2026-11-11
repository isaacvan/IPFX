-- "Congratulations, you are ready to trade" email.
-- Sent by trading-engine (claim_infinity) the moment a free Infinity application is approved automatically and the
-- Stage 1 account is opened. Applications used to wait about 14 hours for a person; identity documents are now
-- checked after approval, so this email must not say the identity is verified.
insert into public.email_templates (key, category, subject, preheader, body_html, body_text, is_active) values (
  'infinity_ready', 'account',
  'Congratulations, you are ready to trade with IPFX',
  'Your free Infinity Stage 1 account is open. You can trade now.',
  '<p>Hi {{customer_name}},</p>
<p><strong>Congratulations. Your Infinity Challenge application is approved and your free $1,000 simulated Stage 1 account is open.</strong> There is nothing to wait for: you can place your first trade now.</p>
<p><a href="{{trading_url}}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">Start trading on IPFX Markets</a></p>
<p>Three things to know before your first trade:</p>
<ul>
<li><strong>Add a stop-loss to every trade within 30 seconds.</strong> A trade without one is closed and counts as a strike. Three strikes end the run.</li>
<li>Your dashboard shows your profit target, counted trades, consistency score and trading limits: <a href="{{dashboard_url}}">{{dashboard_url}}</a>.</li>
<li>We check identity documents after approval. If something does not match, we may pause the account and ask you for a clearer document. Your identity must be verified before any payout.</li>
</ul>
<p>Good luck,<br>The IPFX Capital team</p>',
  'Hi {{customer_name}},

Congratulations. Your Infinity Challenge application is approved and your free $1,000 simulated Stage 1 account is open. There is nothing to wait for: you can place your first trade now.

Start trading on IPFX Markets: {{trading_url}}

Three things to know before your first trade:
- Add a stop-loss to every trade within 30 seconds. A trade without one is closed and counts as a strike. Three strikes end the run.
- Your dashboard shows your profit target, counted trades, consistency score and trading limits: {{dashboard_url}}
- We check identity documents after approval. If something does not match, we may pause the account and ask you for a clearer document. Your identity must be verified before any payout.

Good luck,
The IPFX Capital team',
  true
) on conflict (key) do update set
  category = excluded.category, subject = excluded.subject, preheader = excluded.preheader,
  body_html = excluded.body_html, body_text = excluded.body_text, is_active = true;
