-- 26 Nov 2026: news email "IPFX Markets is coming to your phone" to every account with a confirmed email.
-- Owner approved the wording (preview docs/email-preview/mobile-coming-preview.html) and the audience.
-- It is a marketing email: the outbox adds the per-recipient one-click unsubscribe link and header, skips anyone on the
-- do-not-email list, and sends transactional mail first. Sent through SES at the outbox pace (60 per 5-minute run).
begin;

insert into public.email_templates (key, category, subject, preheader, body_html, body_text, is_active) values (
  'ipfx_mobile_coming', 'account',
  'IPFX Markets is coming to your phone',
  'Trade and pass your Infinity stages from your phone, not just your laptop.',
  '<p>Hi {{customer_name}},</p>
<p style="font-size:18px;font-weight:700;margin:0 0 8px">IPFX Markets is coming to your phone.</p>
<p>We are finishing a mobile version of IPFX Markets, so you will not need a laptop to trade. You will be able to open and close trades, set your stop and take profit, follow your counted trades and score, and pass your stages from your phone. We will email you as soon as it is ready to install.</p>
<p style="margin:22px 0 8px;font-weight:700">A quick reminder of how Infinity works</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:14px;line-height:1.5">
<tr><td style="padding:10px 12px;border:1px solid #e5e7eb;width:34%;vertical-align:top"><strong>Stage 1</strong><br>$1,000, free</td><td style="padding:10px 12px;border:1px solid #e5e7eb">Reach 4% ($40) with at least 20 counted trades and a consistency score of 1.0. No minimum days.</td></tr>
<tr><td style="padding:10px 12px;border:1px solid #e5e7eb;vertical-align:top"><strong>Stage 2</strong><br>$5,000</td><td style="padding:10px 12px;border:1px solid #e5e7eb">Reach 7% ($350) with 40 counted trades. <strong>This is where you start earning:</strong> your share of the profit is held for you. Verify your identity to move up.</td></tr>
<tr><td style="padding:10px 12px;border:1px solid #e5e7eb;vertical-align:top"><strong>Stage 3</strong><br>$10,000</td><td style="padding:10px 12px;border:1px solid #e5e7eb">Reach 8% ($800) with 50 counted trades. <strong>Your Stage 2 and Stage 3 earnings are then paid out together:</strong> 85% of that profit, up to $700, in one payout request (minimum withdrawal $500).</td></tr>
<tr><td style="padding:10px 12px;border:1px solid #e5e7eb;vertical-align:top"><strong>Stage 4</strong><br>from $25,000</td><td style="padding:10px 12px;border:1px solid #e5e7eb">A funded agreement made with you. $25,000 is the standard account; strong traders can be funded at $300,000 or more.</td></tr>
</table>
<p style="margin-top:18px">Every trader gets one free Stage 1 restart each calendar month, so if your last run ended you can start again on IPFX Markets today.</p>
<p><a href="{{trading_url}}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">Open IPFX Markets</a></p>
<p style="font-size:13px;color:#667085">Full rules: <a href="{{rules_page_url}}">Infinity rules</a> and <a href="{{terms_url}}">Terms</a>. Payouts are subject to identity and payout checks.</p>
<p>Good luck,<br>The IPFX Capital team</p>
<p style="font-size:12px;color:#98a2b3">You are getting this because you have an IPFX Capital account. <a href="{{unsubscribe_link}}" style="color:#98a2b3">Unsubscribe from news emails</a>.</p>',
  'Hi {{customer_name}},

IPFX Markets is coming to your phone.

We are finishing a mobile version of IPFX Markets, so you will not need a laptop to trade. You will be able to open and close trades, set your stop and take profit, follow your counted trades and score, and pass your stages from your phone. We will email you as soon as it is ready to install.

A quick reminder of how Infinity works:

- Stage 1, $1,000, free: reach 4% ($40) with at least 20 counted trades and a consistency score of 1.0. No minimum days.
- Stage 2, $5,000: reach 7% ($350) with 40 counted trades. This is where you start earning: your share of the profit is held for you. Verify your identity to move up.
- Stage 3, $10,000: reach 8% ($800) with 50 counted trades. Your Stage 2 and Stage 3 earnings are then paid out together: 85% of that profit, up to $700, in one payout request (minimum withdrawal $500).
- Stage 4, from $25,000: a funded agreement made with you. $25,000 is the standard account; strong traders can be funded at $300,000 or more.

Every trader gets one free Stage 1 restart each calendar month, so if your last run ended you can start again on IPFX Markets today.

Open IPFX Markets: {{trading_url}}

Full rules: {{rules_page_url}} and {{terms_url}}. Payouts are subject to identity and payout checks.

Good luck,
The IPFX Capital team

You are getting this because you have an IPFX Capital account. Unsubscribe from news emails: {{unsubscribe_link}}',
  true
) on conflict (key) do update set subject = excluded.subject, preheader = excluded.preheader, body_html = excluded.body_html,
  body_text = excluded.body_text, is_active = true;

insert into public.email_events (user_id, template_key, to_email, subject, status, provider, payload)
select u.id, 'ipfx_mobile_coming', u.email, 'IPFX Markets is coming to your phone', 'queued', 'ses',
       jsonb_build_object('campaign', 'mobile-coming-2026-11', 'vars', jsonb_build_object(
         'trading_url', 'https://ipfxcapital.com/trading.html',
         'rules_page_url', 'https://ipfxcapital.com/infinity-v2.html',
         'terms_url', 'https://ipfxcapital.com/legal/2026-10-31-v2.3/terms.html'))
  from auth.users u
 where u.email is not null and u.deleted_at is null and u.email_confirmed_at is not null
   and not exists (select 1 from public.email_suppressions s where s.email = lower(trim(u.email)))
   and not exists (select 1 from public.email_events e where e.user_id = u.id and e.template_key = 'ipfx_mobile_coming');

commit;
