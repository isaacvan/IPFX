-- 28 Nov 2026: news email "Trade IPFX from your phone: want early access?" (template only; nothing is queued here).
-- Each recipient's button is their own link (trading.html?phone=1&ea=<token>, see 20261128100000_mobile_early_access.sql).
-- Queued separately with scripts/campaigns/phone-early-access-queue.sql once the owner approves the preview.
-- Marketing: the outbox adds the one-click unsubscribe link and header and skips anyone on the do-not-email list.
insert into public.email_templates (key, category, subject, preheader, body_html, body_text, is_active) values (
  'ipfx_phone_early_access', 'account',
  'Trade IPFX from your phone: want early access?',
  'One tap and the phone version of IPFX Markets switches on for your account.',
  '<p>Hi {{customer_name}},</p>
<p style="font-size:18px;font-weight:700;margin:0 0 8px">You no longer need a laptop to trade with IPFX.</p>
<p>The phone version of IPFX Markets is ready for early access, on iPhone and Android. It runs in your phone''s browser, so there is nothing to download.</p>
<p style="margin:22px 0"><a href="{{early_access_url}}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:8px;font-size:16px">Get early access</a></p>
<p>Tap the button on your phone and IPFX Markets opens in the phone layout. Once you sign in, it stays switched on for your account on any phone you use.</p>
<p style="margin:22px 0 8px;font-weight:700">From your phone you can</p>
<ul style="margin:0 0 16px;padding-left:20px;line-height:1.6">
<li>open and close trades, with your stop loss and take profit</li>
<li>follow your positions, balance and progress through each stage</li>
<li>add IPFX to your home screen so it opens like an app</li>
</ul>
<p><strong>A simpler Stage 1 is coming in December.</strong> We will email you the new rules before they start.</p>
<p>Early access is new, so if anything looks wrong on your phone, reply to this email and tell us.</p>
<p>Good luck,<br>The IPFX Capital team</p>
<p style="font-size:12px;color:#98a2b3">You are getting this because you have an IPFX Capital account. <a href="{{unsubscribe_link}}" style="color:#98a2b3">Unsubscribe from news emails</a>.</p>',
  'Hi {{customer_name}},

You no longer need a laptop to trade with IPFX.

The phone version of IPFX Markets is ready for early access, on iPhone and Android. It runs in your phone''s browser, so there is nothing to download.

Get early access: {{early_access_url}}

Open the link on your phone and IPFX Markets opens in the phone layout. Once you sign in, it stays switched on for your account on any phone you use.

From your phone you can:
- open and close trades, with your stop loss and take profit
- follow your positions, balance and progress through each stage
- add IPFX to your home screen so it opens like an app

A simpler Stage 1 is coming in December. We will email you the new rules before they start.

Early access is new, so if anything looks wrong on your phone, reply to this email and tell us.

Good luck,
The IPFX Capital team

You are getting this because you have an IPFX Capital account. Unsubscribe from news emails: {{unsubscribe_link}}',
  true
) on conflict (key) do update set subject = excluded.subject, preheader = excluded.preheader, body_html = excluded.body_html,
  body_text = excluded.body_text, is_active = true;
