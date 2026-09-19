# Support chatbot

The chat bubble on ipfxcapital.com is one shared script (`assets/js/support-chat.js`) that talks to the public
`support-chat` Edge Function. It answers questions about IPFX; it cannot see accounts and never gives out private data.

## How it answers

1. **Guards** (code, not the AI): personal/payment details typed into the chat, prompt-injection attempts, requests for
   credentials or staff contact details, other traders' data, "how do you detect / how do I get around the rules", trading
   advice, and "check my account" questions get fixed, safe replies.
2. **Rule lookups** (exact): "what's the drawdown on the $50K Traditional?" is answered straight from the
   `challenge_presets` table — the same table the trading engine enforces — so **fees, targets and limits can never go stale**.
3. **Knowledge base** (`support_kb`, ~80 answers) matched by keywords **and meaning** (free built-in `gte-small` embeddings).
4. **Optional AI**: if the Supabase secret `ANTHROPIC_API_KEY` exists, a Claude model (default `claude-haiku-4-5-20251001`,
   override with `SUPPORT_CHAT_MODEL`) writes the answer, using **only** the retrieved knowledge and live rules. Daily cap:
   `SUPPORT_LLM_DAILY_CAP` (default 3000). Without the key everything above still works.
5. **Fallback**: anything it can't answer reliably points to the support email and is logged (personal details removed) so it
   shows up in the admin page's "couldn't answer" list.

## Keeping it up to date (no code needed)

Open **admin.html → Support chatbot → Load / refresh**.

| You changed…                                 | Do this                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| a fee, target, drawdown, daily loss, etc.    | Change it in `challenge_presets`. The bot follows automatically (within a minute).        |
| contact email, payout minimum/days, review time, launch status, referral %, leverage … | Edit the value under **Facts the bot quotes**.       |
| a policy or wording                          | Edit the answer under **Answers the bot knows** (or add a new one).                       |
| visitors asked something it couldn't answer  | **Questions the bot couldn't answer** → *Add answer*.                                      |

In answers, use tokens instead of typing numbers: `{{c:contact_email}}`, `{{p:trad_50k_p1.fee}}`, `{{fees:traditional}}`,
`{{rules:infinity}}`, `{{cmp:daily}}`, `{{instruments}}`. Changes go live within about a minute.

Entries you edit are marked *edited* and are never overwritten by later seed updates.

## Data

`support_kb`, `support_config`, `support_chat_log` — all service-role only (RLS on, no policies). The log holds the visitor's
question with emails and long numbers removed and is purged after 90 days (`pg_cron`). Seed content lives in
`supabase/seed/support_kb.json`; `supabase/migrations/20260919103100_support_chat_seed.sql` is generated from it and is safe
to re-run.

## Turning on the AI answers

Add `ANTHROPIC_API_KEY` as a Supabase Edge Function secret (Dashboard → Edge Functions → Secrets). Nothing else changes.

## Tests

```bash
node --test tests/support-chat.test.mjs
```

Covers ~260 realistic questions → expected answers, exact rule lookups against a snapshot of the live presets, the safety
guards, off-topic fallbacks, that every answer renders without stray tokens, and that no answer contains internal or private
details. Refresh `tests/fixtures/support-presets.json` if presets change materially.
