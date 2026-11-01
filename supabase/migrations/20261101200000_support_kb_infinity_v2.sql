-- Support chatbot: Infinity v2 answers (owner request, 1 Nov 2026). Existing v1 answers get a version note;

-- new answers cover the v2 rules, counted trades and score, which rules apply, and restarting.

-- An answer the owner edited by hand is never overwritten.

begin;

insert into public.support_kb (id, topic, title, keywords, answer, follow_ups, is_active)
values ($q$infinity-v2-rules$q$, $q$infinity$q$, $q$What are the Infinity v2 rules?$q$, array[$q$infinity v2$q$, $q$v2$q$, $q$new rules$q$, $q$new infinity rules$q$, $q$november rules$q$, $q$infinity rules$q$, $q$what changed$q$, $q$consistency score$q$, $q$counted trades$q$, $q$no minimum days$q$], $q$**Infinity v2** applies to every run started or restarted from **1 November 2026**.

| | Stage 1 | Stage 2 | Stage 3 | Stage 4 |
|---|---|---|---|---|
| Account | $1,000 | $5,000 | $10,000 | $25,000 |
| Profit target | 4% | 7% | 8% | none |
| Counted trades | 20 | 40 | 50 | none |
| Consistency score | 1.0 | 1.65 this stage and 2.0 overall | 2.0 overall | none |
| Best day | 35% | 35% | 30% | payout filters |
| Daily loss / max drawdown | 2.5% / 5% | 2% / 4% | 2% / 4% | 2% / 4% |

- **No minimum days or sessions** and **no daily profit cap**.
- **Stop loss** on every trade, at least **8 times the spread**; tighten it or move it to break-even, never further away.
- **Hold at least 5 minutes** for profit to count. Losses always count.
- **After a stop-out** the instrument pauses for **10 minutes**.
- **Daily loss** is measured from your closed balance at 00:00 UTC.
- **Verified identity** is needed to move from Stage 2 to Stage 3.
- Payouts are unchanged: 85% of combined Stage 2 and Stage 3 profit, $500 minimum, $700 maximum.$q$, array[$q$What is a counted trade?$q$, $q$Which rules apply to my run?$q$], true)
on conflict (id) do update set topic = excluded.topic, title = excluded.title, keywords = excluded.keywords,
  answer = excluded.answer, follow_ups = excluded.follow_ups, is_active = true, updated_at = now()
where public.support_kb.edited_by_owner is not true;

insert into public.support_kb (id, topic, title, keywords, answer, follow_ups, is_active)
values ($q$infinity-v2-counted-trades$q$, $q$infinity$q$, $q$What is a counted trade and the consistency score?$q$, array[$q$counted trade$q$, $q$counted trades$q$, $q$consistency score$q$, $q$overall score$q$, $q$score$q$, $q$what is r$q$, $q$r result$q$, $q$how is the score calculated$q$, $q$split tickets$q$], $q$A **counted trade** is one trade, or several trades on the same instrument and direction opened while one of them is still open or within **15 minutes** of the last entry. They share one risk limit and count once.

Each counted trade gets a result in **R**: its profit or loss divided by the risk to your opening stop (capped at plus or minus 5R for the score only).

Your **consistency score** is your average R divided by (the spread of your R results, treated as at least 0.5, divided by the square root of the number of counted trades). Steady positive trading raises it; one lucky trade cannot push it far.

IPFX Markets shows your **overall score** (every counted trade in this run) at all times and tells you the new score after each counted trade.$q$, array[$q$What are the Infinity v2 rules?$q$, $q$Which rules apply to my run?$q$], true)
on conflict (id) do update set topic = excluded.topic, title = excluded.title, keywords = excluded.keywords,
  answer = excluded.answer, follow_ups = excluded.follow_ups, is_active = true, updated_at = now()
where public.support_kb.edited_by_owner is not true;

insert into public.support_kb (id, topic, title, keywords, answer, follow_ups, is_active)
values ($q$infinity-v2-which-rules$q$, $q$infinity$q$, $q$Which rules apply to my run, v1 or v2?$q$, array[$q$which rules$q$, $q$v1$q$, $q$infinity v1$q$, $q$my rules$q$, $q$started before november$q$, $q$old rules$q$, $q$switch to v2$q$, $q$switch$q$, $q$keep my rules$q$], $q$Your run keeps the rules it started with.

- **Started before 1 November 2026:** Infinity v1, unchanged, until it ends (a breach) or you restart.
- **Started or restarted from 1 November 2026:** Infinity v2.
- **Switching:** you can switch a v1 run to v2 from IPFX Markets when you have no open positions or pending orders. It is **one-way**. Your balance, loss limits and any held Stage 2 profit carry over; the v2 counted trades and score start from the switch, and your target is measured from your balance at the switch.

The badge next to the CHALLENGE/DEMO toggle on IPFX Markets shows which version your account is on.$q$, array[$q$How do I restart?$q$, $q$What are the Infinity v2 rules?$q$], true)
on conflict (id) do update set topic = excluded.topic, title = excluded.title, keywords = excluded.keywords,
  answer = excluded.answer, follow_ups = excluded.follow_ups, is_active = true, updated_at = now()
where public.support_kb.edited_by_owner is not true;

insert into public.support_kb (id, topic, title, keywords, answer, follow_ups, is_active)
values ($q$infinity-v2-restart$q$, $q$infinity$q$, $q$How do I restart my Infinity challenge?$q$, array[$q$restart$q$, $q$restart challenge$q$, $q$reset$q$, $q$start again$q$, $q$new attempt$q$, $q$one restart$q$, $q$monthly restart$q$, $q$restart this month$q$, $q$start from zero$q$], $q$Every trader has **one free Stage 1 restart each calendar month**, and it resets on the 1st.

1. On IPFX Markets, click **Restart Challenge** next to the CHALLENGE/DEMO toggle (it shows how many restarts you have left).
2. Close any open positions and cancel pending orders first.
3. Read the **Infinity v2** requirements, tick the agreement box and click **Agree and restart**.

You start again from zero with a new $1,000 Stage 1 account on Infinity v2. Your current run ends and its progress does not carry over; your records and any payouts already due are kept.$q$, array[$q$What are the Infinity v2 rules?$q$, $q$Which rules apply to my run?$q$], true)
on conflict (id) do update set topic = excluded.topic, title = excluded.title, keywords = excluded.keywords,
  answer = excluded.answer, follow_ups = excluded.follow_ups, is_active = true, updated_at = now()
where public.support_kb.edited_by_owner is not true;

update public.support_kb set answer = answer || $q$

**Infinity v2 (from 1 November 2026):** new and restarted runs have no minimum days or sessions and no daily profit cap. You pass on counted trades and a consistency score instead. Ask "What are the Infinity v2 rules?" for the details. The text above describes Infinity v1, which still applies to runs started before 1 November 2026.$q$, updated_at = now()
where id in ($q$how-it-works$q$, $q$infinity-stage1$q$, $q$infinity-stage2$q$, $q$infinity-stage3$q$, $q$infinity-profit-cap$q$, $q$profit-target$q$, $q$minimum-days-trades$q$, $q$consistency-rules$q$, $q$time-limit$q$)
  and answer not like '%Infinity v2 (from 1 November 2026)%' and edited_by_owner is not true;

commit;
