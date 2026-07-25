# IPFX — Activate copier + admin console + payouts

Everything is coded and pushed. Do these once to turn it on. ~10 minutes.

## 1. Database (one paste)
Supabase → SQL Editor → paste **`SETUP.sql`** → Run.
Creates every table/view (copier, payouts, admins, stats, risk) and sets the trader split to **85%**. Safe to re-run.

## 2. Make yourself admin
In the SQL editor, run (use the email you log into ipfxcapital.com with):
```sql
insert into public.admins(user_id)
select id from auth.users where email = 'YOUR_LOGIN_EMAIL'
on conflict do nothing;
```

## 3. Deploy the Edge Functions
Supabase → Edge Functions → for each folder in `supabase/functions/`, create/deploy a function with the same name, pasting its `index.ts`:
- **`trading-engine`** — redeploy (adds the mirror hook)
- **`admin-console`** — new (powers `admin.html`)
- **`live-mirror`** — new (the copier; stays dormant until step 5)

Leave **"Verify JWT"** ON for all three (they do their own auth).

## 4. Use it
Go to **`ipfxcapital.com/admin.html`** → you'll see every trader with status, win rate, profit factor, max drawdown, and owed payout. This works with **no** MetaApi/live money.

## 5. (Optional) Turn on live copying
Only when you're ready to push trades to a real account:
1. Create a **MetaApi** account, connect an MT5 login, copy its **account ID** + note the **region**.
2. Supabase → Edge Functions → Secrets → add `METAAPI_TOKEN` = your MetaApi token.
3. In `admin.html`, click **Approve** on a trader → pick **Own broker** (recommended) or **Prop firm** → paste the MetaApi account ID → **Enable**.

Copying stays OFF for everyone until you do step 5 for a specific trader.
