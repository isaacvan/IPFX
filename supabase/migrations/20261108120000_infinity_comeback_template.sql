-- Come-back email for traders who have stopped trading (2026-11-08). Template only: no email_events rows, scheduling or sending here.
-- Opt-out is "reply with the word unsubscribe" (there is no unsubscribe page yet), so the footer says so instead of linking one.
begin;
insert into public.email_templates(key,category,subject,preheader,body_html,body_text,is_active) values(
'infinity_comeback','account','We listened. The challenge is free, the rules are lighter, and Stages 2 and 3 pay.',
'No minimum days, no profit cap, and up to $700 paid when you finish Stage 3.',
$c$<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>We listened: free to start, paid after Stage 3</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1b1f24;">
<div style="display:none;max-height:0;overflow:hidden;">No minimum days, no profit cap, and up to $700 paid when you finish Stage 3.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;">
  <tr><td style="background:#0f1720;padding:28px 28px 24px;color:#ffffff;">
    <div style="font-size:13px;letter-spacing:1px;color:#9fb3c8;text-transform:uppercase;">Infinity v2 is live</div>
    <div style="font-size:27px;font-weight:bold;margin-top:6px;line-height:1.25;">You asked. We changed it.</div>
    <div style="font-size:15px;color:#c9d6e3;margin-top:10px;line-height:1.5;">A free challenge, lighter rules, and real payouts when you finish Stage 3.</div>
  </td></tr>
  <tr><td style="padding:24px 28px 8px;font-size:15px;line-height:1.6;">
    <p style="margin:0 0 12px;">Hi {{first_name}},</p>
    <p style="margin:0 0 12px;">You told us what was getting in your way: waiting out minimum trading days, a profit cap that closed your winners, and a daily-loss rule that punished you for holding overnight. A lot of you stopped trading because of it.</p>
    <p style="margin:0 0 4px;">So we changed it. <b>Infinity v2 is live, and it is built on what you told us.</b></p>
  </td></tr>
  <tr><td style="padding:16px 28px 0;"><div style="font-size:18px;font-weight:bold;margin-bottom:8px;">What's different now</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;line-height:1.5;">
      <tr><td style="padding:6px 0;vertical-align:top;width:26px;color:#0b6b3a;font-weight:bold;">&#10003;</td><td style="padding:6px 0;"><b>No minimum trading days.</b> Pass as soon as your results show it. No waiting period.</td></tr>
      <tr><td style="padding:6px 0;vertical-align:top;color:#0b6b3a;font-weight:bold;">&#10003;</td><td style="padding:6px 0;"><b>No daily profit cap.</b> We no longer close your trades for making money. Let winners run.</td></tr>
      <tr><td style="padding:6px 0;vertical-align:top;color:#0b6b3a;font-weight:bold;">&#10003;</td><td style="padding:6px 0;"><b>Daily loss is measured from your closed balance.</b> Profit you hold overnight can't breach you on a pullback.</td></tr>
      <tr><td style="padding:6px 0;vertical-align:top;color:#0b6b3a;font-weight:bold;">&#10003;</td><td style="padding:6px 0;"><b>Fewer trades to prove it.</b> Stage 1 needs 20 counted trades (it was 30). Stage 2 needs 40 (it was 60).</td></tr>
      <tr><td style="padding:6px 0;vertical-align:top;color:#0b6b3a;font-weight:bold;">&#10003;</td><td style="padding:6px 0;"><b>Tighter FX spreads,</b> close to institutional pricing.</td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:18px 28px 0;"><div style="padding:16px 18px;background:#eef6ee;border-radius:8px;font-size:15px;line-height:1.6;">
    <div style="font-size:18px;font-weight:bold;margin-bottom:6px;">It costs you nothing to start</div>
    The challenge is <b>free</b>. Start with a $1,000 Stage 1 account and work up to $5,000, then $10,000. No fee to enter, no fee to restart (one Stage 1 attempt each month).
  </div></td></tr>
  <tr><td style="padding:14px 28px 0;"><div style="padding:16px 18px;background:#0f1720;color:#ffffff;border-radius:8px;font-size:15px;line-height:1.6;">
    <div style="font-size:18px;font-weight:bold;margin-bottom:6px;">And you get paid for it</div>
    <b>The profit you make in Stage 2 and Stage 3 is paid to you when you finish Stage 3.</b>
    <ul style="margin:10px 0 0;padding-left:20px;color:#dbe6f1;">
      <li>You receive <b>85% of your closed profit from Stages 2 and 3</b>, up to a <b>maximum of $700</b>. The <b>minimum payout is $500</b>, so your 85% share needs to reach $500 before it can be paid.</li>
      <li>You'll need to verify your identity and add a payout method.</li>
      <li>Past Stage 3, <b>Stage 4 ($25,000)</b> pays out every 14 days at the same 85% split.</li>
    </ul>
  </div></td></tr>
  <tr><td style="padding:20px 28px 0;font-size:15px;line-height:1.6;"><div style="font-size:18px;font-weight:bold;margin-bottom:6px;">Where to pick up</div>
    <p style="margin:0 0 8px;"><b>Your run is still open?</b> Switch it to v2 from your dashboard. Your balance and progress carry over. Switching is one-way and needs you to have no open trades.</p>
    <p style="margin:0 0 4px;"><b>Your run ended or you breached?</b> Restart Stage 1 on v2.</p>
  </td></tr>
  <tr><td align="center" style="padding:20px 28px 8px;"><a href="{{trading_url}}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 32px;border-radius:8px;">Open IPFX Markets</a></td></tr>
  <tr><td style="padding:16px 28px 0;font-size:14px;line-height:1.6;"><div style="font-size:16px;font-weight:bold;margin-bottom:6px;">The honest bit</div>
    We'd rather you read these now than find them mid-trade:
    <ul style="margin:8px 0 0;padding-left:20px;">
      <li>A <b>stop loss on every trade</b>, at least 8&times; the spread away. You can tighten it, never widen it.</li>
      <li>Profit counts only on trades <b>held 5 minutes or more</b>. Losses always count.</li>
      <li>To pass a stage you need your <b>profit target and a consistency score</b>. The score is on your dashboard live.</li>
      <li><b>One account per person.</b> Infinity accounts are simulated.</li>
    </ul>
    <p style="margin:12px 0 0;">Full rules: <a href="{{rules_page_url}}" style="color:#2563eb;">{{rules_page_url}}</a>. Questions? Reply to this email. We read every message.</p>
  </td></tr>
  <tr><td style="padding:18px 28px 24px;font-size:15px;line-height:1.6;">Good trading,<br>The IPFX Capital team</td></tr>
  <tr><td style="background:#f0f2f5;padding:16px 28px;font-size:12px;line-height:1.5;color:#5b6570;">Infinity accounts are simulated trading accounts. Please read the full terms: <a href="{{terms_url}}" style="color:#5b6570;">{{terms_url}}</a>. Don't want these emails? Reply to this one with the word unsubscribe and we'll stop.</td></tr>
</table></td></tr></table></body></html>
$c$,
$c$Hi {{first_name}},

You told us what was getting in your way: waiting out minimum trading days, a profit cap that closed your winners, and a daily-loss rule that punished you for holding overnight. A lot of you stopped trading because of it.

So we changed it. Infinity v2 is live, and it is built on what you told us.

WHAT'S DIFFERENT NOW
- No minimum trading days. Pass as soon as your results show it. No waiting period.
- No daily profit cap. We no longer close your trades for making money. Let winners run.
- Daily loss is measured from your closed balance. Profit you hold overnight can't breach you on a pullback.
- Fewer trades to prove it. Stage 1 needs 20 counted trades (it was 30). Stage 2 needs 40 (it was 60).
- Tighter FX spreads, close to institutional pricing.

IT COSTS YOU NOTHING TO START
The challenge is free. Start with a $1,000 Stage 1 account and work up to $5,000, then $10,000. No fee to enter, no fee to restart (one Stage 1 attempt each month).

AND YOU GET PAID FOR IT
The profit you make in Stage 2 and Stage 3 is paid to you when you finish Stage 3.
- You receive 85% of your closed profit from Stages 2 and 3, up to a maximum of $700. The minimum payout is $500, so your 85% share needs to reach $500 before it can be paid.
- You'll need to verify your identity and add a payout method.
- Past Stage 3, Stage 4 ($25,000) pays out every 14 days at the same 85% split.

WHERE TO PICK UP
Your run is still open? Switch it to v2 from your dashboard. Your balance and progress carry over. Switching is one-way and needs you to have no open trades.
Your run ended or you breached? Restart Stage 1 on v2.

Open IPFX Markets: {{trading_url}}

THE HONEST BIT
We'd rather you read these now than find them mid-trade:
- A stop loss on every trade, at least 8x the spread away. You can tighten it, never widen it.
- Profit counts only on trades held 5 minutes or more. Losses always count.
- To pass a stage you need your profit target and a consistency score. The score is on your dashboard live.
- One account per person. Infinity accounts are simulated.

Full rules: {{rules_page_url}}. Questions? Reply to this email. We read every message.

Good trading,
The IPFX Capital team

Infinity accounts are simulated trading accounts. Please read the full terms: {{terms_url}}. Don't want these emails? Reply to this one with the word unsubscribe and we'll stop.
$c$,true)
on conflict(key) do update set subject=excluded.subject,preheader=excluded.preheader,body_html=excluded.body_html,body_text=excluded.body_text,is_active=true;
commit;
