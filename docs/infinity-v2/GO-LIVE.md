# Infinity v2 — go-live

There are two separate steps. Neither happens until the owner says go.

1. **Release.** This deploys everything with Infinity v2 still **off**:
   - database changes,
   - the four backend functions,
   - the hub,
   - the website.

   Nothing changes for traders.
2. **Switch-on.** v2 starts at the cutover: **1 Nov 2026 00:00 UTC**. From that moment, every new run and every monthly restart is Infinity v2. Runs already in progress stay on v1, unchanged, until they breach or restart.

## Who gets what

| Trader | Rules |
|---|---|
| Already in a run before the cutover | **v1, unchanged**, including later stages of that run, until it breaches or they restart |
| Restarts (monthly restart, free restart, Restart button) after the cutover | **v2** |
| Starts for the first time after the cutover | **v2** |
| v1 trader who chooses to switch (flat, consented, one-way) | v2 from the switch. The target is measured from the higher of the starting balance and the balance at the switch. Floors and held Stage 2 profit carry over. |

## v2 thresholds (version row, immutable once accepted)

| | Stage 1 | Stage 2 | Stage 3 |
|---|---|---|---|
| Consistency score | 1.0 | 1.65 this stage, 2.0 over Stages 1–2 | 2.0 over Stages 1–3 |

- Best day is counted by the **day a counted trade opened**.
- Moving from Stage 2 to Stage 3 needs **verified identity**. The setting `stage3_requires_kyc` is on by default; the account keeps trading while it waits.

## 1. Release

```bash
node scripts/release-infinity-v2.mjs
node scripts/release-infinity-v2.mjs --apply
```

The first command is a dry run. It checks everything and changes nothing:
- the branch contains the latest main;
- the live functions and hub equal main, so no one else's deploy would be overwritten;
- exactly the 15 release migrations are pending;
- every source-drift guard passes against the live database.

The second command releases. It stops at the first failure, and **Infinity v2 stays OFF**.

Each migration is one transaction, so a failed migration leaves nothing half-applied. To roll back a release:
- **Functions:** redeploy main's previous commit.
- **Hub:** `/opt/ipfx-hub/rollback-<stamp>`.
- **Website:** revert the merge commit.

Don't reverse the migrations: with the flag off, v1 behaves exactly as today.

## 2. Switch-on (owner decisions needed first)

The database refuses to enable v2 until both of these are set:

1. **Published v2 Terms:** a row in `platform_legal_documents` with `kind='terms'` and a `document_url`.
2. **Commission per lot for every enabled symbol.** Matching E8 is recommended.

   ```sql
   update public.infinity_v2_pricing_profiles set commission_round_turn_per_lot = <X> where commission_round_turn_per_lot is null;
   ```

Then enable v2. The cutover is already 1 Nov 00:00 UTC, so enabling it earlier is safe: starts before the cutover stay v1.

```sql
update public.infinity_v2_settings set terms_version = '<published version>', infinity_v2_enabled = true where singleton;
```

**Checks on owner test accounts after the cutover:**
- a restart creates one Stage 1 account on v2, and the monthly allowance drops;
- an existing v1 account and its next stage stay v1;
- a flat switch keeps the balance and shows the v2 target measured from the switch.

**Rollback:** `update public.infinity_v2_settings set infinity_v2_enabled=false where singleton;`
- New starts and restarts go back to v1.
- Accepted v2 runs keep their v2 rules: never rewrite them.

## 3. Copy policy v5 (separate owner decision)

Released as a **DRAFT**. Live copying keeps policy v4 until this is run:

```sql
update public.ab_policy_versions set status = 'RETIRED' where status = 'ACTIVE';
update public.ab_policy_versions set status = 'ACTIVE' where version = 5;
```

**What v5 changes:**
- The "2.75% in Stage 2" rule (v4: straight to **live** copying after 15 trades) is replaced by a run-wide consistency score of **2.33 or more over 80 or more counted trades**.
- That gate starts a **demo** copy test. Live copying still needs the existing prospective proof.
- Identity must be verified.
- **Kill switch:** copying stops when the copies score −1.0 or lower after 40 copied trades, or fall 12R from their peak. The same run can't re-promote the trader.

**Why demo first:** see `infinity-selection-study/copy_check/REPORT.md`. On E8 prices, traders who were profitable on their earlier trades did not stay profitable when copied.

**Recommended alongside v5:** re-enable the paused E8 shadow pricing, so every trade keeps being priced at E8's bid and ask. It was paused on 24 Oct; the undo is in migration `20261024130000`:

```sql
select cron.alter_job(jobid, active := true) from cron.job where jobname = 'ipfx-e8-simulator';
```

## Launch email

The template is staged inactive and nothing is queued. Sending is a separate, explicit owner action.

**Placeholders to fill:** `{{first_name}}`, `{{rules_page_url}}`, `{{terms_url}}`, `{{unsubscribe_link}}`.

**Sending limits:** Resend's free plan allows 100 emails a day, and the outbox caps itself at 80. Use Resend Pro for 2,000 sends.
