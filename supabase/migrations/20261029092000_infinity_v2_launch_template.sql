-- Template only: no email_events insertion, scheduling or delivery.
begin;
insert into public.email_templates(key,category,subject,preheader,body_html,body_text,is_active) values(
'infinity_v2_launch','account','New from 1 November: pass on your trading, not the calendar',
'Your current run stays on v1 unless you choose to switch.',
$launch$<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Infinity v2 from 1 November</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1b1f24;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;">
  <tr><td style="background:#0f1720;padding:28px 28px 22px;color:#ffffff;">
    <div style="font-size:13px;letter-spacing:1px;color:#9fb3c8;text-transform:uppercase;">New from 1 November</div>
    <div style="font-size:26px;font-weight:bold;margin-top:6px;line-height:1.25;">Pass on your trading, not the calendar</div>
    <div style="font-size:15px;color:#c9d6e3;margin-top:8px;">The Infinity Challenge moves to v2. Your current run stays on v1 unless you switch.</div>
  </td></tr>
  <tr><td style="padding:24px 28px 8px;font-size:15px;line-height:1.6;">
    <p style="margin:0 0 12px;">Hi {{first_name}},</p>
    <p style="margin:0 0 12px;">You told us you want to be judged on how well you trade, not how many days you wait. From <b>1 November</b> the challenge moves to <b>Infinity v2</b>.</p>
    <p style="margin:0 0 4px;padding:12px 14px;background:#eef6ee;border-radius:8px;"><b>Your current run doesn't change unless you switch.</b> It stays on Infinity v1, same rules and payouts, until it ends (a breach or a restart).</p>
  </td></tr>
  <tr><td style="padding:16px 28px 0;"><div style="font-size:18px;font-weight:bold;margin-bottom:10px;">What's different</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
      <tr style="background:#f0f2f5;"><td style="padding:8px;border:1px solid #e3e6ea;"></td><td style="padding:8px;border:1px solid #e3e6ea;font-weight:bold;">Infinity v1 (current)</td><td style="padding:8px;border:1px solid #e3e6ea;font-weight:bold;color:#0b6b3a;">Infinity v2</td></tr>
      <tr><td style="padding:8px;border:1px solid #e3e6ea;">Minimum days and sessions</td><td style="padding:8px;border:1px solid #e3e6ea;">Yes</td><td style="padding:8px;border:1px solid #e3e6ea;"><b>None</b></td></tr>
      <tr><td style="padding:8px;border:1px solid #e3e6ea;">How you pass</td><td style="padding:8px;border:1px solid #e3e6ea;">Target + minimums</td><td style="padding:8px;border:1px solid #e3e6ea;"><b>Target + consistency score</b></td></tr>
      <tr><td style="padding:8px;border:1px solid #e3e6ea;">Daily profit cap</td><td style="padding:8px;border:1px solid #e3e6ea;">Closes your trades</td><td style="padding:8px;border:1px solid #e3e6ea;"><b>Gone: let winners run</b></td></tr>
      <tr><td style="padding:8px;border:1px solid #e3e6ea;">Holding overnight</td><td style="padding:8px;border:1px solid #e3e6ea;">Open profit can count against tomorrow</td><td style="padding:8px;border:1px solid #e3e6ea;"><b>Daily loss from closed balance</b></td></tr>
      <tr><td style="padding:8px;border:1px solid #e3e6ea;">FX spreads</td><td style="padding:8px;border:1px solid #e3e6ea;">Standard</td><td style="padding:8px;border:1px solid #e3e6ea;"><b>Tighter</b></td></tr>
      <tr><td style="padding:8px;border:1px solid #e3e6ea;">Minimum hold for profit</td><td style="padding:8px;border:1px solid #e3e6ea;">60 seconds</td><td style="padding:8px;border:1px solid #e3e6ea;"><b>5 minutes</b></td></tr>
    </table></td></tr>
  <tr><td style="padding:20px 28px 0;"><div style="font-size:18px;font-weight:bold;margin-bottom:10px;">The stages</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;text-align:center;">
      <tr style="background:#f0f2f5;font-weight:bold;"><td style="padding:8px;border:1px solid #e3e6ea;text-align:left;"></td><td style="padding:8px;border:1px solid #e3e6ea;">Stage 1</td><td style="padding:8px;border:1px solid #e3e6ea;">Stage 2</td><td style="padding:8px;border:1px solid #e3e6ea;">Stage 3</td><td style="padding:8px;border:1px solid #e3e6ea;">Stage 4</td></tr>
      <tr><td style="padding:8px;border:1px solid #e3e6ea;text-align:left;">Account</td><td style="padding:8px;border:1px solid #e3e6ea;">$1,000</td><td style="padding:8px;border:1px solid #e3e6ea;">$5,000</td><td style="padding:8px;border:1px solid #e3e6ea;">$10,000</td><td style="padding:8px;border:1px solid #e3e6ea;">$25,000</td></tr>
      <tr><td style="padding:8px;border:1px solid #e3e6ea;text-align:left;">Profit target</td><td style="padding:8px;border:1px solid #e3e6ea;">4%</td><td style="padding:8px;border:1px solid #e3e6ea;">7%</td><td style="padding:8px;border:1px solid #e3e6ea;">8%</td><td style="padding:8px;border:1px solid #e3e6ea;">—</td></tr>
      <tr><td style="padding:8px;border:1px solid #e3e6ea;text-align:left;">Counted trades</td><td style="padding:8px;border:1px solid #e3e6ea;">20</td><td style="padding:8px;border:1px solid #e3e6ea;">40</td><td style="padding:8px;border:1px solid #e3e6ea;">50</td><td style="padding:8px;border:1px solid #e3e6ea;">—</td></tr>
      <tr><td style="padding:8px;border:1px solid #e3e6ea;text-align:left;">Consistency score</td><td style="padding:8px;border:1px solid #e3e6ea;">0.75</td><td style="padding:8px;border:1px solid #e3e6ea;">1.25</td><td style="padding:8px;border:1px solid #e3e6ea;">2.0</td><td style="padding:8px;border:1px solid #e3e6ea;">—</td></tr>
      <tr><td style="padding:8px;border:1px solid #e3e6ea;text-align:left;">Daily loss / max drawdown</td><td style="padding:8px;border:1px solid #e3e6ea;">2.5% / 5%</td><td style="padding:8px;border:1px solid #e3e6ea;">2% / 4%</td><td style="padding:8px;border:1px solid #e3e6ea;">2% / 4%</td><td style="padding:8px;border:1px solid #e3e6ea;">2% / 4%</td></tr>
    </table>
    <p style="font-size:13px;color:#5b6570;margin:8px 0 0;">Payouts are the same as today: Stage 3 completion and Stage 4 every 14 days, at an 85% split.</p></td></tr>
  <tr><td style="padding:20px 28px 0;font-size:15px;line-height:1.6;"><div style="font-size:18px;font-weight:bold;margin-bottom:8px;">Six rules to know</div>
    <ol style="margin:0;padding-left:20px;">
      <li><b>Stop loss on every trade</b>, at least <b>8× the spread</b> away. Tighten it or move it to break-even, but never further away.</li>
      <li><b>Hold at least 5 minutes</b> for profit to count. Losses always count.</li>
      <li><b>After a stop-out</b>, that instrument pauses for <b>10 minutes</b>.</li>
      <li>Trades on the same instrument and direction within 15 minutes count as <b>one trade</b>.</li>
      <li>Your <b>consistency score</b> rises when your wins steadily outweigh your losses. It's on your dashboard live.</li>
      <li><b>One account per person.</b></li>
    </ol></td></tr>
  <tr><td style="padding:22px 28px;font-size:15px;line-height:1.6;">
    <div style="font-size:18px;font-weight:bold;margin-bottom:8px;">Which version am I on?</div>
    <p style="margin:0 0 8px;"><b>Trading now (v1):</b> keep your current rules until your run ends, or switch to v2 any time from your dashboard. Switching is one-way. Your balance and progress carry over, and v2 requirements count from the moment you switch.</p>
    <p style="margin:0 0 14px;"><b>Starting or restarting from 1 November:</b> your new run is on <b>Infinity v2</b>.</p>
    <a href="{{rules_page_url}}" style="display:inline-block;background:#0b6b3a;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;">Read the full rules and FAQ</a>
    <p style="margin:16px 0 0;">Questions? Reply to this email or use the support chat. We read every message.</p>
    <p style="margin:12px 0 0;">Good trading,<br>The IPFX team</p>
  </td></tr>
  <tr><td style="padding:14px 28px 22px;font-size:12px;color:#7a838c;border-top:1px solid #eef0f2;">Infinity accounts are simulated trading accounts. Please read the full terms before choosing: <a href="{{terms_url}}" style="color:#7a838c;">terms</a>. <a href="{{unsubscribe_link}}" style="color:#7a838c;">Unsubscribe</a></td></tr>
</table></td></tr></table>
</body></html>
$launch$,$launch$# Launch email: Infinity v2 (1 November)

**Subject:** New from 1 November: pass on your trading, not the calendar

**Preview text:** No minimum days. Let winners run. Your current run stays on v1 unless you choose to switch.

---

Hi {{first_name}},

From **1 November** the Infinity Challenge moves to **Infinity v2**. It's built around what you've told us: pass on how well you trade, not how many days you wait.

**Your current run doesn't change unless you choose to switch.** It stays on Infinity v1, with the same rules and payouts, until it ends (a breach or a restart).

### What's different

| | Infinity v1 (current) | Infinity v2 |
|---|---|---|
| Minimum trading days, sessions, waiting period | Yes | **None** |
| How you pass | Profit target + activity minimums | **Profit target + a consistency score** (shown live) |
| Daily profit cap | Closes your trades | **Gone.** Let winners run |
| Holding overnight | Profit held overnight can count against tomorrow's daily loss | **Daily loss is measured from your closed balance** |
| Spreads | Standard | **Tighter on FX**, close to institutional pricing |
| Scalps under the minimum hold | 60 seconds | **5 minutes** |

### The stages

| | Stage 1 | Stage 2 | Stage 3 | Stage 4 |
|---|---|---|---|---|
| Account | $1,000 | $5,000 | $10,000 | $25,000 |
| Profit target | 4% | 7% | 8% | none |
| Counted trades | 20 | 40 | 50 | — |
| Consistency score | 0.75 | 1.25 | 2.0 | — |
| Daily loss / max drawdown | 2.5% / 5% | 2% / 4% | 2% / 4% | 2% / 4% |

Payouts are the same as today: Stage 3 completion and Stage 4 every 14 days, at an 85% split.

### Six rules to know
1. **Stop loss on every trade**, at least **8× the spread** away. You can tighten it or move it to break-even, but never move it further away.
2. **Hold at least 5 minutes** for profit to count. Losses always count.
3. **After a stop-out**, that instrument pauses for **10 minutes**.
4. **Trades on the same instrument and direction within 15 minutes count as one trade.**
5. **Your consistency score** rises when your wins steadily outweigh your losses. It's on your dashboard in real time.
6. **One account per person.**

### Which version am I on?
- **Trading now (Infinity v1):** keep your current rules until your run ends, or switch to v2 at any time from your dashboard. Switching is one-way. Your balance and progress carry over, and the v2 requirements count from the moment you switch.
- **Starting or restarting from 1 November:** your new run is on **Infinity v2**.

**Full rules and FAQ:** {{rules_page_url}}

Questions? Reply to this email or use the support chat. We read every message.

Good trading,
The IPFX team

*Infinity accounts are simulated trading accounts. Please read the full terms before choosing: {{terms_url}}. {{unsubscribe_link}}*

---

## FAQ (for the rules page)

**What is a consistency score?**
It measures how clearly your wins outweigh your losses across your counted trades, adjusted for how many counted trades you've taken. One big lucky trade won't push it far; steady, positive trading will. You'll see it on your dashboard all the time.

**Why a minimum stop distance?**
Very tight stops are mostly eaten by the spread. A stop at least 8× the spread means your result depends on your trading, not on costs.

**Can I hold trades overnight or over the weekend?**
Yes. Daily loss is measured from your closed balance, so open profit carried overnight doesn't count against you if the trade pulls back. Weekend gaps can fill beyond your stop.

**Why can't I widen my stop?**
Your risk is measured from your opening stop. Moving it further away would hide your real risk. You can always tighten it or move it to break-even.

**What happens to my current challenge?**
It stays on Infinity v1, with the same rules and payouts, until it ends (a breach or a restart). You can switch it to v2 at any time from your dashboard. Every run started or restarted from 1 November is on v2.

**If I switch, do I lose my progress?**
No. Your balance, drawdown limits and any held Stage 2 profit carry over. The v2 counted trades and consistency score for your current stage start from the moment you switch. Switching can't be undone.
$launch$,false) on conflict(key) do nothing;
commit;
